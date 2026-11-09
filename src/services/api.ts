import { AppData, Task, Vendor, Karyawan, Recap } from '../types.ts';
import { supabase, isSupabaseConfigured } from '../lib/supabase.ts';

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
  } catch (e) {
    // ignore
  }
  return headers;
}

export async function fetchAllData(): Promise<AppData> {
  if (isSupabaseConfigured) {
    try {
      const [tasksRes, vendorsRes, categoriesRes, karyawanRes, recapsRes] = await Promise.all([
        supabase.from('tasks').select('*').order('waktu_update', { ascending: false }),
        supabase.from('vendors').select('*').order('nama', { ascending: true }),
        supabase.from('categories').select('*').order('nama', { ascending: true }),
        supabase.from('karyawan').select('*').order('nama', { ascending: true }),
        supabase.from('recaps').select('*').order('tanggal', { ascending: false }),
      ]);

      if (!tasksRes.error && tasksRes.data) {
        return {
          tasks: (tasksRes.data || []).map((t: any) => ({
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
            Penerima: t.penerima || '',
            Catatan: t.catatan || '',
            FotoPenerima: t.foto_penerima || '',
          })),
          vendors: (vendorsRes.data || []).map((v: any) => ({
            ID: v.id,
            Nama: v.nama,
            NoHP: v.no_hp || '',
            Alamat: v.alamat || '',
            LinkMaps: v.link_maps || '',
          })),
          categories: (categoriesRes.data || []).map((c: any) => c.nama),
          users: (karyawanRes.data || []).map((k: any) => ({
            ID: k.id,
            Nama: k.nama,
            Posisi: k.posisi || 'Sprinter',
          })),
          recaps: (recapsRes.data || []).map((r: any) => ({
            Tanggal: r.tanggal,
            Karyawan: r.karyawan || '',
            UangCash: Number(r.uang_cash) || 0,
          })),
          sprinterLocations: [],
        };
      }
      if (tasksRes.error) {
        console.warn('Direct Supabase fetch tasks error:', tasksRes.error);
      }
    } catch (e) {
      console.warn('Direct Supabase fetch failed, falling back to /api/data:', e);
    }
  }

  const res = await fetch('/api/data');
  if (!res.ok) throw new Error(`HTTP error ${res.status}`);
  return await res.json();
}

export async function apiSaveTask(task: Task): Promise<void> {
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
        penerima: task.Penerima || '',
        catatan: task.Catatan || '',
        foto_penerima: task.FotoPenerima || '',
      });
      if (error) {
        console.error('Supabase direct apiSaveTask error:', error);
        throw new Error(error.message || 'Gagal menyimpan tugas ke Supabase');
      }
      return;
    } catch (e: any) {
      console.warn('Direct Supabase save failed, attempting /api/tasks fallback:', e);
      if (!e.message?.includes('fetch')) {
        throw e;
      }
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
  if (isSupabaseConfigured) {
    try {
      const { error } = await supabase.from('tasks').delete().eq('id', id);
      if (error) throw new Error(error.message || 'Gagal menghapus tugas dari Supabase');
      return;
    } catch (e: any) {
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
  if (isSupabaseConfigured) {
    try {
      const { error } = await supabase.from('vendors').upsert({
        id: vendor.ID,
        nama: vendor.Nama,
        no_hp: vendor.NoHP || '',
        alamat: vendor.Alamat || '',
        link_maps: vendor.LinkMaps || '',
      });
      if (error) throw new Error(error.message || 'Gagal menyimpan vendor ke Supabase');
      return;
    } catch (e: any) {
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
  if (isSupabaseConfigured) {
    try {
      const { error } = await supabase.from('vendors').delete().eq('id', id);
      if (error) throw new Error(error.message || 'Gagal menghapus vendor dari Supabase');
      return;
    } catch (e: any) {
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
  if (isSupabaseConfigured) {
    try {
      const { error } = await supabase.from('karyawan').upsert({
        id: karyawan.ID,
        nama: karyawan.Nama,
        posisi: karyawan.Posisi || 'Sprinter',
      });
      if (error) throw new Error(error.message || 'Gagal menyimpan karyawan ke Supabase');
      return;
    } catch (e: any) {
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
  if (isSupabaseConfigured) {
    try {
      const { error } = await supabase.from('karyawan').delete().eq('id', id);
      if (error) throw new Error(error.message || 'Gagal menghapus karyawan dari Supabase');
      return;
    } catch (e: any) {
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
  if (isSupabaseConfigured) {
    try {
      const { error } = await supabase.from('categories').insert({ nama });
      if (error) throw new Error(error.message || 'Gagal menyimpan kategori ke Supabase');
      return;
    } catch (e: any) {
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
  if (isSupabaseConfigured) {
    try {
      const { error } = await supabase.from('categories').delete().eq('nama', nama);
      if (error) throw new Error(error.message || 'Gagal menghapus kategori dari Supabase');
      return;
    } catch (e: any) {
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
  if (isSupabaseConfigured) {
    try {
      const { error } = await supabase.from('recaps').upsert({
        tanggal: recap.Tanggal,
        karyawan: recap.Karyawan || '',
        uang_cash: Number(recap.UangCash) || 0,
      });
      if (error) throw new Error(error.message || 'Gagal menyimpan rekap ke Supabase');
      return;
    } catch (e: any) {
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
