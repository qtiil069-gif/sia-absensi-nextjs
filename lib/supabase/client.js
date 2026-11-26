import { createBrowserClient } from '@supabase/ssr';

/**
 * Browser client Supabase (dipakai komponen client / lib/api.js sisi browser).
 * Memakai anon key; RLS tetap berlaku — client ini TIDAK pernah mem-bypass RLS.
 */
export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  );
}
