// Hook kecil untuk membaca profil + peran user dari Supabase Auth.
// Peran dipakai UI untuk menyembunyikan mutasi non-Admin; penegakan
// sesungguhnya tetap di server (Route Handler / RLS), bukan di sini.
'use client';

import { useCallback, useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';

export const ROLE_ADMIN = 'ADMIN_KEPALA_SEKOLAH';
export const ROLE_TEACHER = 'GURU';

export function isAdminRole(role) {
  return role === ROLE_ADMIN;
}

// Versi non-hook (dipakai lib/api.js untuk getBootstrap).
// Mencoba tabel "profiles" (id, role, nama); bila tidak ada,
// jatuh ke user_metadata.role, lalu default GURU.
export async function getProfile() {
  const supabase = createClient();
  const {
    data: { session },
    error: sessionError,
  } = await supabase.auth.getSession();
  if (sessionError) throw new Error(sessionError.message);
  const user = session?.user;
  if (!user) return null;

  let role = user.user_metadata?.role || null;
  let name = user.user_metadata?.full_name || user.user_metadata?.name || '';

  try {
    const { data, error } = await supabase
      .from('profiles')
      .select('role, nama')
      .eq('id', user.id)
      .maybeSingle();
    if (!error && data) {
      role = data.role || role;
      name = data.nama || name;
    }
  } catch {
    // Tabel profiles belum tentu ada; abaikan dan pakai metadata.
  }

  return {
    id: user.id,
    email: user.email || '',
    name: name || user.email || '',
    role: role || ROLE_TEACHER,
    isAdmin: isAdminRole(role || ROLE_TEACHER),
  };
}

export function useProfile() {
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setProfile(await getProfile());
    } catch (err) {
      setError(err?.message || 'Gagal memuat profil.');
      setProfile(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return {
    user: profile,
    profile,
    role: profile?.role || null,
    isAdmin: !!profile?.isAdmin,
    loading,
    error,
    refresh,
  };
}

export default useProfile;
