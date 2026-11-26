import { createServerClient } from '@supabase/ssr';
import { NextResponse } from 'next/server';

/**
 * Pola resmi @supabase/ssr: refresh sesi dari cookie pada setiap request,
 * plus penegakan akses: semua route dilindungi kecuali /login dan
 * /api/auth/* (di sanalah sesi dibuat). Tanpa sesi yang valid:
 *   - request /api/* → 401 JSON { ok:false, error:{ code:'UNAUTHENTICATED' } }
 *   - request halaman → redirect ke /login.
 * Aset statis Next (_next, favicon) tidak lewat matcher middleware.
 */
export async function updateSession(request) {
  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          );
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  // getUser() memvalidasi ulang token ke Auth server (bukan sekadar baca
  // klaim JWT lokal), sekaligus me-refresh sesi bila sudah kedaluwarsa.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const pathname = request.nextUrl.pathname;
  const isPublic =
    pathname === '/login' ||
    pathname.startsWith('/login/') ||
    pathname.startsWith('/api/auth/') ||
    pathname.startsWith('/_next/') ||
    pathname === '/favicon.ico';

  if (!user && !isPublic) {
    if (pathname.startsWith('/api/')) {
      return NextResponse.json(
        {
          ok: false,
          error: {
            code: 'UNAUTHENTICATED',
            message: 'Anda belum masuk. Silakan masuk kembali.',
          },
        },
        { status: 401 }
      );
    }
    const loginUrl = request.nextUrl.clone();
    loginUrl.pathname = '/login';
    loginUrl.searchParams.set('next', pathname);
    return NextResponse.redirect(loginUrl);
  }

  return supabaseResponse;
}
