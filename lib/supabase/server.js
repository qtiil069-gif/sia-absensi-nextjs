import { createServerClient } from '@supabase/ssr';
import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import { cookies } from 'next/headers';

/**
 * Server client Supabase (Route Handler / Server Component).
 * Membawa sesi user dari cookie, jadi query tunduk pada RLS sebagai user itu.
 */
export function createClient() {
  const cookieStore = cookies();
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            );
          } catch {
            // setAll dipanggil dari Server Component — pengabaian ini sesuai
            // pola resmi @supabase/ssr; refresh sesi ditangani middleware.
          }
        },
      },
    }
  );
}

/**
 * Service-role client.
 * HANYA untuk pekerjaan server yang memang butuh melewati RLS setelah
 * otorisasi + validasi cakupan diperiksa eksplisit di kode route:
 * penulisan audit_log, pembuatan qr_token, dan pembacaan ekspor.
 * JANGAN dipakai untuk query biasa atas nama user, dan JANGAN pernah
 * dikirim ke browser.
 */
export function createServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    throw new Error(
      'SUPABASE_SERVICE_ROLE_KEY belum dikonfigurasi. Periksa .env.local.'
    );
  }
  return createSupabaseClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
