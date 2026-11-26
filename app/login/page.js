// Login email + password via Supabase Auth (lib/supabase/client.js).
'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';

const FRIENDLY_ERRORS = [
  [/invalid login credentials/i, 'Email atau kata sandi salah. Periksa kembali lalu coba lagi.'],
  [/email not confirmed/i, 'Email belum dikonfirmasi. Periksa kotak masuk email Anda.'],
  [/too many requests/i, 'Terlalu banyak percobaan masuk. Tunggu beberapa menit lalu coba lagi.'],
  [/network/i, 'Tidak dapat terhubung ke server. Periksa koneksi internet Anda.'],
];

function friendlyMessage(raw) {
  const text = String(raw || '');
  for (const [pattern, message] of FRIENDLY_ERRORS) {
    if (pattern.test(text)) return message;
  }
  return text || 'Gagal masuk. Silakan coba lagi.';
}

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    if (busy) return;
    setError('');
    setBusy(true);
    try {
      const supabase = createClient();
      const { error: authError } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password,
      });
      if (authError) throw new Error(authError.message);
      router.push('/');
      router.refresh();
    } catch (err) {
      setError(friendlyMessage(err?.message));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-wrap">
      <section className="login-card" aria-label="Masuk SIA Absensi Sekolah">
        <span className="brand-mark" aria-hidden="true">☺</span>
        <h1>Masuk SIA Absensi Sekolah</h1>
        <p>Masuk dengan email dan kata sandi akun sekolah Anda untuk mengelola absensi.</p>
        {error && (
          <p className="page-feedback is-error" role="alert">{error}</p>
        )}
        <form className="record-form" onSubmit={handleSubmit}>
          <label className="form-field">
            <span>Email</span>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="nama@sekolah.sch.id"
              autoComplete="email"
              required
            />
          </label>
          <label className="form-field">
            <span>Kata sandi</span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Kata sandi Anda"
              autoComplete="current-password"
              required
            />
          </label>
          <div className="form-actions">
            <button type="submit" className="button coral" disabled={busy} style={{ flex: 1 }}>
              {busy ? 'Memeriksa…' : 'Masuk'}
            </button>
          </div>
        </form>
        <p>Lupa kata sandi? Hubungi Admin Kepala Sekolah untuk mengatur ulang akun Anda.</p>
      </section>
    </div>
  );
}
