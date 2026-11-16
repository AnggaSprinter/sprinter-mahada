import { AppData, Task, Vendor, Karyawan, Recap } from '../types.ts';
import { supabase, isSupabaseConfigured } from '../lib/supabase.ts';

// -------------------------------------------------------------
// CACHE & QUOTA CIRCUIT BREAKER STATE
// -------------------------------------------------------------

interface CacheEntry<T> {
  data: T;
  timestamp: number;
}

const MASTER_STALE_MS = 10 * 60 * 1000; // 10 menit untuk master data (vendor, kategori, karyawan)
const RECAPS_STALE_MS = 3 * 60 * 1000;  // 3 menit untuk rekap
const TASKS_CHECK_INTERVAL_MS = 30 * 1000; // Cek perubahan tugas setiap minimal 30 detik

let vendorsCache: CacheEntry<Vendor[]> | null = null;
let categoriesCache: CacheEntry<string[]> | null = null;
let karyawanCache: CacheEntry<Karyawan[]> | null = null;
let recapsCache: CacheEntry<Recap[]> | null = null;
let tasksCache: { data: Task[]; lastUpdateTime: string; timestamp: number } | null = null;

// Quota Circuit Breaker (HTTP 402)
let isQuotaBlocked = false;
let quotaErrorMessage = '';
type QuotaListener = (blocked: boolean, message: string) => void;
const quotaListeners: Set<QuotaListener> = new Set();

export function subscribeQuotaState(listener: QuotaListener): () => void {
  quotaListeners.add(listener);
  listener(isQuotaBlocked, quotaErrorMessage);
  return () => quotaListeners.delete(listener);
}

function notifyQuotaState(blocked: boolean, message: string) {
  isQuotaBlocked = blocked;
  quotaErrorMessage = message;
  quotaListeners.forEach((fn) => {
    try {
      fn(blocked, message);
    } catch {
      // ignore listener error
    }
  });
}

export function resetQuotaState() {
  notifyQuotaState(false, '');
}

export function clearClientCache() {
  vendorsCache = null;
  categoriesCache = null;
  karyawanCache = null;
  recapsCache = null;
  tasksCache = null;
  try {
    localStorage.removeItem('sprinter_cache_vendors');
    localStorage.removeItem('sprinter_cache_categories');
    localStorage.removeItem('sprinter_cache_karyawan');
  } catch {
    // ignore
  }
}

// In-Flight Promise Deduplication
let activeFetchPromise: Promise<AppData> | null = null;

// LocalStorage helpers for master data persistence
function getLocalMasterCache<T>(key: string, maxAgeMs: number): T | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (Date.now() - parsed.timestamp < maxAgeMs) {
      return parsed.data as T;
    }
  } catch {
    // ignore
  }
  return null;
}

function setLocalMasterCache<T>(key: string, data: T) {
  try {
    localStorage.setItem(key, JSON.stringify({ data, timestamp: Date.now() }));
  } catch {
    // ignore
  }
}

// -------------------------------------------------------------
// HELPER: DETECT HTTP 402 & EGRESS ERRORS
// -------------------------------------------------------------
function checkAndHandleQuotaError(error: any): boolean {
  if (!error) return false;
  const status = error.status || error.code;
  const msg = (error.message || '').toLowerCase();
  if (
    status === 402 ||
    status === '402' ||
    msg.includes('402') ||
    msg.includes('payment required') ||
    msg.includes('quota') ||
    msg.includes('exceeded')
  ) {
    const userMsg =
      'Batas kuota Supabase telah terlampaui (HTTP 402 Payment Required). Polling otomatis dihentikan untuk mencegah pemborosan egress.';
    console.error('SUPABASE QUOTA EXCEEDED (402):', error);
    notifyQuotaState(true, userMsg);
    return true;
  }
  return false;
}

async function getHeaders(): Promise<HeadersInit> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  try {
    if (isSupabaseConfigured) {
      const { data } = await supabase.auth.getSession();
      const token = data?.session?.access_token;
      if (token) headers['Authorization'] = `Bearer ${token}`;
    }
  } catch {
    // ignore
  }
  return headers;
}

// -------------------------------------------------------------
// OPTIMIZED FETCH ALL DATA (SMART CACHING & EGRESS MINIMIZATION)
// -------------------------------------------------------------
export async function fetchAllData(force = false): Promise<AppData> {
  if (activeFetchPromise) {
    return activeFetchPromise;
  }

  activeFetchPromise = (async () => {
    // 1. If currently blocked by HTTP 402 and not forced, return cached data immediately
    if (isQuotaBlocked && !force) {
      return getCachedFallbackData();
    }

    if (isSupabaseConfigured) {
      try {
        const now = Date.now();

        // A. MASTER DATA: VENDORS
        let currentVendors: Vendor[] | null = null;
        if (!force && vendorsCache && now - vendorsCache.timestamp < MASTER_STALE_MS) {
          currentVendors = vendorsCache.data;
        } else if (!force) {
          currentVendors = getLocalMasterCache<Vendor[]>('sprinter_cache_vendors', MASTER_STALE_MS);
          if (currentVendors) vendorsCache = { data: currentVendors, timestamp: now };
        }

        // B. MASTER DATA: CATEGORIES
        let currentCategories: string[] | null = null;
        if (!force && categoriesCache && now - categoriesCache.timestamp < MASTER_STALE_MS) {
          currentCategories = categoriesCache.data;
        } else if (!force) {
          currentCategories = getLocalMasterCache<string[]>('sprinter_cache_categories', MASTER_STALE_MS);
          if (currentCategories) categoriesCache = { data: currentCategories, timestamp: now };
        }

        // C. MASTER DATA: KARYAWAN
        let currentKaryawan: Karyawan[] | null = null;
        if (!force && karyawanCache && now - karyawanCache.timestamp < MASTER_STALE_MS) {
          currentKaryawan = karyawanCache.data;
        } else if (!force) {
          currentKaryawan = getLocalMasterCache<Karyawan[]>('sprinter_cache_karyawan', MASTER_STALE_MS);
          if (currentKaryawan) karyawanCache = { data: currentKaryawan, timestamp: now };
        }

        // D. RECAPS: CACHE CHECK (3 MINUTES)
        let currentRecaps: Recap[] | null = null;
        if (!force && recapsCache && now - recapsCache.timestamp < RECAPS_STALE_MS) {
          currentRecaps = recapsCache.data;
        }

        // E. TASKS: LIGHTWEIGHT CHANGE DETECTION
        // Instead of downloading entire tasks table with base64 images (~5MB),
        // we first check the latest waktu_update (~50 bytes)!
        let needsTasksFetch = force || !tasksCache;
        if (!needsTasksFetch && tasksCache) {
          const checkRes = await supabase
            .from('tasks')
            .select('waktu_update')
            .order('waktu_update', { ascending: false })
            .limit(1);

          if (checkRes.error) {
            if (checkAndHandleQuotaError(checkRes.error)) {
              return getCachedFallbackData();
            }
          } else {
            const latestTime = checkRes.data?.[0]?.waktu_update || '';
            if (latestTime !== tasksCache.lastUpdateTime) {
              needsTasksFetch = true;
            } else {
              // Data unchanged! Update timestamp and reuse cached tasks
              tasksCache.timestamp = now;
            }
          }
        }

        // Build list of queries that genuinely need to run
        const queriesToRun: Promise<any>[] = [];
        const queryKeys: string[] = [];

        if (needsTasksFetch) {
          queryKeys.push('tasks');
          queriesToRun.push(
            supabase
              .from('tasks')
              .select(
                'id, karyawan, judul_tugas, invoice, kategori, dari, tujuan, prioritas, pic, no_hp, biaya, keterangan_biaya, status, waktu_update, waktu_dibuat, waktu_selesai, penerima, catatan, foto_penerima'
              )
              .order('waktu_update', { ascending: false })
              .limit(100)
          );
        }

        if (!currentVendors) {
          queryKeys.push('vendors');
          queriesToRun.push(
            supabase
              .from('vendors')
              .select('id, nama, no_hp, alamat, link_maps')
              .order('nama', { ascending: true })
          );
        }

        if (!currentCategories) {
          queryKeys.push('categories');
          queriesToRun.push(
            supabase
              .from('categories')
              .select('id, nama')
              .order('nama', { ascending: true })
          );
        }

        if (!currentKaryawan) {
          queryKeys.push('karyawan');
          queriesToRun.push(
            supabase
              .from('karyawan')
              .select('id, nama, posisi')
              .order('nama', { ascending: true })
          );
        }

        if (!currentRecaps) {
          queryKeys.push('recaps');
          queriesToRun.push(
            supabase
              .from('recaps')
              .select('tanggal, karyawan, uang_cash')
              .order('tanggal', { ascending: false })
              .limit(31) // Cukup 1 bulan terakhir
          );
        }

        // Execute only required queries in parallel
        if (queriesToRun.length > 0) {
          const results = await Promise.all(queriesToRun);

          for (let i = 0; i < queryKeys.length; i++) {
            const key = queryKeys[i];
            const res = results[i];

            if (res.error) {
              if (checkAndHandleQuotaError(res.error)) {
                return getCachedFallbackData();
              }
              console.warn(`Supabase fetch ${key} error:`, res.error);
              continue;
            }

            if (key === 'tasks' && res.data) {
              const mappedTasks: Task[] = res.data.map((t: any) => ({
                ID: t.id,
                Karyawan: t.karyawan,
                JudulTugas: t.judul_tugas,
                Invoice: t.invoice || '',
                Kategori: t.kategori || 'Lainnya',
                Dari: t.dari || '',
                Tujuan: t.tujuan,
                Prioritas: t.prioritas || 'Standar',
                PIC: t.pic || '',
                NoHP: t.no_hp || '',
                Biaya: Number(t.biaya) || 0,
                KeteranganBiaya: t.keterangan_biaya || '',
                Status: t.status || 'Pending',
                WaktuUpdate: t.waktu_update || '',
                WaktuDibuat: t.waktu_dibuat || t.waktu_update || '',
                WaktuSelesai: t.waktu_selesai || '',
                Penerima: t.penerima || '',
                Catatan: t.catatan || '',
                FotoPenerima: t.foto_penerima || '',
              }));
              const latestUpdateTime = mappedTasks[0]?.WaktuUpdate || '';
              tasksCache = { data: mappedTasks, lastUpdateTime, timestamp: now };
            } else if (key === 'vendors' && res.data) {
              currentVendors = res.data.map((v: any) => ({
                ID: v.id,
                Nama: v.nama,
                NoHP: v.no_hp || '',
                Alamat: v.alamat || '',
                LinkMaps: v.link_maps || '',
              }));
              vendorsCache = { data: currentVendors, timestamp: now };
              setLocalMasterCache('sprinter_cache_vendors', currentVendors);
            } else if (key === 'categories' && res.data) {
              currentCategories = res.data.map((c: any) => c.nama);
              categoriesCache = { data: currentCategories, timestamp: now };
              setLocalMasterCache('sprinter_cache_categories', currentCategories);
            } else if (key === 'karyawan' && res.data) {
              currentKaryawan = res.data.map((k: any) => ({
                ID: k.id,
                Nama: k.nama,
                Posisi: k.posisi || 'Sprinter',
              }));
              karyawanCache = { data: currentKaryawan, timestamp: now };
              setLocalMasterCache('sprinter_cache_karyawan', currentKaryawan);
            } else if (key === 'recaps' && res.data) {
              currentRecaps = res.data.map((r: any) => ({
                Tanggal: r.tanggal,
                Karyawan: r.karyawan || '',
                UangCash: Number(r.uang_cash) || 0,
              }));
              recapsCache = { data: currentRecaps, timestamp: now };
            }
          }
        }

        // Return complete assembled data from cache/fresh queries
        return {
          tasks: tasksCache?.data || [],
          vendors: currentVendors || vendorsCache?.data || [],
          categories: currentCategories || categoriesCache?.data || [],
          users: currentKaryawan || karyawanCache?.data || [],
          recaps: currentRecaps || recapsCache?.data || [],
          sprinterLocations: [],
        };
      } catch (e: any) {
        if (checkAndHandleQuotaError(e)) {
          return getCachedFallbackData();
        }
        console.warn('Direct Supabase fetch failed, attempting /api/data fallback:', e);
      }
    }

    // Fallback to Express backend if Supabase direct is not configured or in local dev
    const res = await fetch('/api/data');
    if (!res.ok) {
      if (res.status === 402) {
        notifyQuotaState(true, 'Batas kuota database terlampaui (HTTP 402).');
      }
      throw new Error(`HTTP error ${res.status}`);
    }
    const data = await res.json();
    return data;
  })();

  try {
    return await activeFetchPromise;
  } finally {
    activeFetchPromise = null;
  }
}

function getCachedFallbackData(): AppData {
  return {
    tasks: tasksCache?.data || [],
    vendors: vendorsCache?.data || getLocalMasterCache<Vendor[]>('sprinter_cache_vendors', 86400000) || [],
    categories: categoriesCache?.data || getLocalMasterCache<string[]>('sprinter_cache_categories', 86400000) || [],
    users: karyawanCache?.data || getLocalMasterCache<Karyawan[]>('sprinter_cache_karyawan', 86400000) || [],
    recaps: recapsCache?.data || [],
    sprinterLocations: [],
  };
}

// -------------------------------------------------------------
// MUTATIONS (WITH CACHE INVALIDATION & PROJECTION CONTROL)
// -------------------------------------------------------------

export async function apiSaveTask(task: Task): Promise<void> {
  // Invalidate tasks cache so next fetch gets fresh state
  tasksCache = null;

  if (isSupabaseConfigured) {
    try {
      const { error } = await supabase.from('tasks').upsert({
        id: task.ID,
        karyawan: task.Karyawan,
        judul_tugas: task.JudulTugas,
        invoice: task.Invoice || '',
        kategori: task.Kategori || 'Lainnya',
        dari: task.Dari || '',
        tujuan: task.Tujuan,
        prioritas: task.Prioritas || 'Standar',
        pic: task.PIC || '',
        no_hp: task.NoHP || '',
        biaya: Number(task.Biaya) || 0,
        keterangan_biaya: task.KeteranganBiaya || '',
        status: task.Status || 'Pending',
        waktu_update: task.WaktuUpdate || new Date().toISOString().replace('T', ' ').substring(0, 19),
        waktu_dibuat: task.WaktuDibuat || task.WaktuUpdate || new Date().toISOString().replace('T', ' ').substring(0, 19),
        waktu_selesai: task.WaktuSelesai || '',
        penerima: task.Penerima || '',
        catatan: task.Catatan || '',
        foto_penerima: task.FotoPenerima || '',
      });
      if (error) {
        checkAndHandleQuotaError(error);
        throw new Error(error.message || 'Gagal menyimpan tugas ke Supabase');
      }
      return;
    } catch (e: any) {
      if (checkAndHandleQuotaError(e)) throw e;
      if (!e.message?.includes('fetch')) throw e;
    }
  }

  const headers = await getHeaders();
  const res = await fetch('/api/tasks', {
    method: 'POST',
    headers,
    body: JSON.stringify(task),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Gagal menyimpan tugas ke Supabase');
  }
}

export async function apiDeleteTask(id: string): Promise<void> {
  tasksCache = null;

  if (isSupabaseConfigured) {
    try {
      const { error } = await supabase.from('tasks').delete().eq('id', id);
      if (error) {
        checkAndHandleQuotaError(error);
        throw new Error(error.message || 'Gagal menghapus tugas dari Supabase');
      }
      return;
    } catch (e: any) {
      if (checkAndHandleQuotaError(e)) throw e;
      console.warn('Direct Supabase delete failed, attempting /api/tasks fallback:', e);
    }
  }

  const headers = await getHeaders();
  const res = await fetch(`/api/tasks/${id}`, {
    method: 'DELETE',
    headers,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Gagal menghapus tugas dari Supabase');
  }
}

export async function apiSaveVendor(vendor: Vendor): Promise<void> {
  vendorsCache = null;
  try {
    localStorage.removeItem('sprinter_cache_vendors');
  } catch {
    // ignore
  }

  if (isSupabaseConfigured) {
    try {
      const { error } = await supabase.from('vendors').upsert({
        id: vendor.ID,
        nama: vendor.Nama,
        no_hp: vendor.NoHP || '',
        alamat: vendor.Alamat || '',
        link_maps: vendor.LinkMaps || '',
      });
      if (error) {
        checkAndHandleQuotaError(error);
        throw new Error(error.message || 'Gagal menyimpan vendor ke Supabase');
      }
      return;
    } catch (e: any) {
      if (checkAndHandleQuotaError(e)) throw e;
      console.warn('Direct Supabase save vendor failed:', e);
    }
  }

  const headers = await getHeaders();
  const res = await fetch('/api/vendors', {
    method: 'POST',
    headers,
    body: JSON.stringify(vendor),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Gagal menyimpan vendor ke Supabase');
  }
}

export async function apiDeleteVendor(id: string): Promise<void> {
  vendorsCache = null;
  try {
    localStorage.removeItem('sprinter_cache_vendors');
  } catch {
    // ignore
  }

  if (isSupabaseConfigured) {
    try {
      const { error } = await supabase.from('vendors').delete().eq('id', id);
      if (error) {
        checkAndHandleQuotaError(error);
        throw new Error(error.message || 'Gagal menghapus vendor dari Supabase');
      }
      return;
    } catch (e: any) {
      if (checkAndHandleQuotaError(e)) throw e;
      console.warn('Direct Supabase delete vendor failed:', e);
    }
  }

  const headers = await getHeaders();
  const res = await fetch(`/api/vendors/${id}`, {
    method: 'DELETE',
    headers,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Gagal menghapus vendor dari Supabase');
  }
}

export async function apiSaveKaryawan(karyawan: Karyawan): Promise<void> {
  karyawanCache = null;
  try {
    localStorage.removeItem('sprinter_cache_karyawan');
  } catch {
    // ignore
  }

  if (isSupabaseConfigured) {
    try {
      const { error } = await supabase.from('karyawan').upsert({
        id: karyawan.ID,
        nama: karyawan.Nama,
        posisi: karyawan.Posisi || 'Sprinter',
      });
      if (error) {
        checkAndHandleQuotaError(error);
        throw new Error(error.message || 'Gagal menyimpan karyawan ke Supabase');
      }
      return;
    } catch (e: any) {
      if (checkAndHandleQuotaError(e)) throw e;
      console.warn('Direct Supabase save karyawan failed:', e);
    }
  }

  const headers = await getHeaders();
  const res = await fetch('/api/karyawan', {
    method: 'POST',
    headers,
    body: JSON.stringify(karyawan),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Gagal menyimpan karyawan ke Supabase');
  }
}

export async function apiDeleteKaryawan(id: string): Promise<void> {
  karyawanCache = null;
  try {
    localStorage.removeItem('sprinter_cache_karyawan');
  } catch {
    // ignore
  }

  if (isSupabaseConfigured) {
    try {
      const { error } = await supabase.from('karyawan').delete().eq('id', id);
      if (error) {
        checkAndHandleQuotaError(error);
        throw new Error(error.message || 'Gagal menghapus karyawan dari Supabase');
      }
      return;
    } catch (e: any) {
      if (checkAndHandleQuotaError(e)) throw e;
      console.warn('Direct Supabase delete karyawan failed:', e);
    }
  }

  const headers = await getHeaders();
  const res = await fetch(`/api/karyawan/${id}`, {
    method: 'DELETE',
    headers,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Gagal menghapus karyawan dari Supabase');
  }
}

export async function apiSaveCategory(nama: string): Promise<void> {
  categoriesCache = null;
  try {
    localStorage.removeItem('sprinter_cache_categories');
  } catch {
    // ignore
  }

  if (isSupabaseConfigured) {
    try {
      const { error } = await supabase.from('categories').insert({ nama });
      if (error) {
        checkAndHandleQuotaError(error);
        throw new Error(error.message || 'Gagal menyimpan kategori ke Supabase');
      }
      return;
    } catch (e: any) {
      if (checkAndHandleQuotaError(e)) throw e;
      console.warn('Direct Supabase save category failed:', e);
    }
  }

  const headers = await getHeaders();
  const res = await fetch('/api/categories', {
    method: 'POST',
    headers,
    body: JSON.stringify({ nama }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Gagal menyimpan kategori ke Supabase');
  }
}

export async function apiDeleteCategory(nama: string): Promise<void> {
  categoriesCache = null;
  try {
    localStorage.removeItem('sprinter_cache_categories');
  } catch {
    // ignore
  }

  if (isSupabaseConfigured) {
    try {
      const { error } = await supabase.from('categories').delete().eq('nama', nama);
      if (error) {
        checkAndHandleQuotaError(error);
        throw new Error(error.message || 'Gagal menghapus kategori dari Supabase');
      }
      return;
    } catch (e: any) {
      if (checkAndHandleQuotaError(e)) throw e;
      console.warn('Direct Supabase delete category failed:', e);
    }
  }

  const headers = await getHeaders();
  const res = await fetch(`/api/categories/${encodeURIComponent(nama)}`, {
    method: 'DELETE',
    headers,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Gagal menghapus kategori dari Supabase');
  }
}

export async function apiSaveRecap(recap: Recap): Promise<void> {
  recapsCache = null;

  if (isSupabaseConfigured) {
    try {
      const { error } = await supabase.from('recaps').upsert({
        tanggal: recap.Tanggal,
        karyawan: recap.Karyawan || '',
        uang_cash: Number(recap.UangCash) || 0,
      });
      if (error) {
        checkAndHandleQuotaError(error);
        throw new Error(error.message || 'Gagal menyimpan rekap ke Supabase');
      }
      return;
    } catch (e: any) {
      if (checkAndHandleQuotaError(e)) throw e;
      console.warn('Direct Supabase save recap failed:', e);
    }
  }

  const headers = await getHeaders();
  const res = await fetch('/api/recaps', {
    method: 'POST',
    headers,
    body: JSON.stringify(recap),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Gagal menyimpan rekap ke Supabase');
  }
}
