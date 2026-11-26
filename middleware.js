import { updateSession } from './lib/supabase/middleware';

/**
 * Lindungi semua route kecuali halaman login dan endpoint auth.
 * Halaman /login dan /api/auth/* harus tetap bisa diakses tanpa sesi
 * (di sanalah sesi dibuat). Aset statis Next (_next, favicon) juga
 * dikecualikan agar halaman login bisa dimuat.
 */
export async function middleware(request) {
  return await updateSession(request);
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|login|api/auth).*)',
  ],
};
