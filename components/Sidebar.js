// Sidebar navigasi utama (porting index.html asli).
// Di halaman /login sidebar disembunyikan. "Keluar" memakai Supabase Auth.
'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { useProfile } from '@/lib/useProfile';

const NAV = [
  { href: '/', label: 'Dashboard', icon: '⌂', tone: 'mint', exact: true },
  { href: '/kelas', label: 'Data Kelas', icon: '▦', tone: 'peach' },
  { href: '/siswa', label: 'Data Siswa', icon: '☺', tone: 'yellow' },
  { href: '/absensi', label: 'Absensi Siswa', icon: '▣', tone: 'blue' },
  { href: '/kartu', label: 'Kartu ID', icon: '▤', tone: 'lavender' },
  { href: '/pengaturan', label: 'Pengaturan Sekolah', icon: '⚙', tone: 'mint', adminOnly: true },
];

export default function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const { profile, isAdmin } = useProfile();
  const [open, setOpen] = useState(false);

  // Halaman login memakai layout tanpa sidebar.
  if (pathname === '/login') return null;

  const isActive = (item) =>
    item.exact ? pathname === item.href : pathname === item.href || pathname.startsWith(`${item.href}/`);

  async function handleLogout() {
    try {
      await createClient().auth.signOut();
    } finally {
      router.push('/login');
      router.refresh();
    }
  }

  return (
    <>
      <button
        type="button"
        className="sidebar-backdrop"
        aria-label="Tutup menu"
        hidden={!open}
        onClick={() => setOpen(false)}
      />
      <aside className={`sidebar${open ? ' open' : ''}`} id="sidebar" aria-label="Menu utama">
        <Link href="/" className="brand" onClick={() => setOpen(false)}>
          <span className="brand-mark" aria-hidden="true">☺</span>
          <span>
            SIA<span className="brand-sub">SEKOLAH</span>
          </span>
        </Link>
        <div className="profile">
          <div className="avatar" aria-hidden="true">
            ☺<span />
          </div>
          <strong>{profile?.name || 'Selamat datang!'}</strong>
          <span>{isAdmin ? 'Admin Kepala Sekolah' : profile ? 'Guru' : 'Sistem Informasi Absensi'}</span>
        </div>
        <p className="nav-caption">RUANG SEKOLAH</p>
        <nav>
          {NAV.filter((item) => !item.adminOnly || isAdmin).map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={`nav-item${isActive(item) ? ' active' : ''}`}
              aria-current={isActive(item) ? 'page' : undefined}
              onClick={() => setOpen(false)}
            >
              <span className={`nav-icon ${item.tone}`} aria-hidden="true">{item.icon}</span>
              {item.label}
            </Link>
          ))}
          <button type="button" className="nav-item" onClick={handleLogout}>
            <span className="nav-icon peach" aria-hidden="true">↪</span>
            Keluar
          </button>
        </nav>
        <div className="sidebar-note">
          <span className="note-icon" aria-hidden="true">✦</span>
          <strong>Setiap hari berarti.</strong>
          <p>
            Catat kehadiran, dampingi
            <br />
            perjalanan belajar mereka.
          </p>
          <Link href="/absensi" className="button coral small" onClick={() => setOpen(false)}>
            Mulai absensi <span aria-hidden="true">↗</span>
          </Link>
        </div>
        <div className="sidebar-footer">
          SIA Sekolah <span>·</span> Tahap 3
        </div>
      </aside>
      {/* Tombol menu mobile dirender di dalam workspace oleh halaman;
          tombol ini dipakai sebagai cadangan bila halaman tidak menyediakannya. */}
      <button
        type="button"
        className="icon-button mobile-menu"
        aria-label="Buka menu"
        aria-expanded={open}
        aria-controls="sidebar"
        onClick={() => setOpen((v) => !v)}
        style={{ position: 'fixed', left: 12, top: 12, zIndex: 25 }}
      >
        ☰
      </button>
    </>
  );
}
