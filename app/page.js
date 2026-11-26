// Dashboard (porting components/dashboard.js + index.html asli):
// banner peach, 4 kartu statistik pastel, grafik batang 7 hari dan donat
// komposisi kehadiran — keduanya CSS sederhana, tanpa lib chart berat.
'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import api from '@/lib/api';
import { useProfile } from '@/lib/useProfile';
import { useToast } from '@/components/Toast';
import StatCard from '@/components/StatCard';

const STATUS_META = [
  ['H', 'Hadir', '#73a99b'],
  ['S', 'Sakit', '#edc063'],
  ['I', 'Izin', '#8eb3d0'],
  ['A', 'Alfa', '#e69c7e'],
];

function todayId() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function formatDateId(dateStr) {
  if (!dateStr) return '';
  try {
    return new Date(`${dateStr}T12:00:00Z`).toLocaleDateString('id-ID', {
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
    });
  } catch {
    return dateStr;
  }
}

export default function DashboardPage() {
  const toast = useToast();
  const { profile } = useProfile();
  const [data, setData] = useState(null);
  const [classes, setClasses] = useState([]);
  const [classId, setClassId] = useState('');
  const [date, setDate] = useState(todayId());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const result = await api.getDashboard({ date, classId: classId || undefined });
      setData(result);
    } catch (err) {
      setError(err?.message || 'Data dashboard belum dapat ditampilkan.');
      toast.error(err?.message || 'Data dashboard belum dapat ditampilkan.');
    } finally {
      setLoading(false);
    }
  }, [date, classId, toast]);

  useEffect(() => {
    api.listClasses({ status: 'active' }).then((list) => setClasses(Array.isArray(list) ? list : list?.items || [])).catch(() => setClasses([]));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const stats = data?.stats || {};
  const weekly = Array.isArray(data?.weekly) ? data.weekly : [];
  const composition = data?.composition || { counts: {}, rate: null, total: 0 };
  const counts = composition.counts || {};
  const total = composition.total || 0;

  let position = 0;
  const gradient = STATUS_META.map(([code, , color]) => {
    const count = counts[code] || 0;
    const percent = total ? (count / total) * 100 : 0;
    const stop = `${color} ${position}% ${position + percent}%`;
    position += percent;
    return stop;
  }).join(',');

  const greetingName = profile?.name ? `, ${profile.name}` : '';

  return (
    <>
      <header className="topbar">
        <div className="page-heading">
          <div>
            <p className="eyebrow">RUANG KERJA SEKOLAH</p>
            <h1>Dashboard</h1>
          </div>
        </div>
        <span className="topbar-monogram" aria-hidden="true">S</span>
      </header>

      <section aria-label="Ringkasan sekolah">
        <div className="welcome-banner">
          <div className="welcome-copy">
            <span className="semester-pill">☀ <span>{data?.school?.semester || 'Semester aktif'}</span></span>
            <h2>
              Selamat mengajar,
              <br />
              Bapak &amp; Ibu Guru{greetingName}! <span aria-hidden="true">☀</span>
            </h2>
            <p>
              Hari baru, kesempatan baru untuk tumbuh bersama.
              <br /> Kelola kegiatan sekolah dengan lebih hangat dan terarah.
            </p>
            <div className="banner-actions">
              <Link href="/absensi" className="button coral">▷ Mulai Absensi Kelas</Link>
              <Link href="/siswa" className="button light">Data Siswa</Link>
            </div>
          </div>
        </div>

        <div className="section-toolbar">
          <div>
            <h2>Sekolah dalam angka</h2>
            <p>{data?.scope || 'Ringkasan kegiatan hari ini'}{data?.date ? ` · ${formatDateId(data.date)}` : ''}</p>
          </div>
          <div className="filters">
            <label className="sr-only" htmlFor="class-filter">Filter kelas</label>
            <select id="class-filter" value={classId} onChange={(e) => setClassId(e.target.value)}>
              <option value="">Semua kelas</option>
              {classes.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
            <label className="date-filter">
              <span aria-hidden="true">▣</span>
              <input type="date" value={date} onChange={(e) => setDate(e.target.value)} aria-label="Tanggal ringkasan" required />
            </label>
          </div>
        </div>

        {loading && <p className="notice">Memuat ringkasan sekolah…</p>}
        {error && !loading && (
          <div className="error-panel" role="alert">
            <strong>Data belum dapat ditampilkan</strong>
            <p>{error}</p>
            <button type="button" className="button light" onClick={load}>Coba lagi</button>
          </div>
        )}

        <div className="stats-grid" aria-label="Statistik hari terpilih">
          <StatCard tone="mint" icon="☺" label="Total Siswa" value={stats.students?.toLocaleString('id-ID')} sub="Siswa aktif terdaftar" />
          <StatCard tone="peach" icon="▦" label="Data Kelas" value={stats.classes} sub="Rombongan belajar" />
          <StatCard tone="yellow" icon="▣" label="Kehadiran" value={stats.attendanceRate === null || stats.attendanceRate === undefined ? '—' : `${stats.attendanceRate}%`} sub={`${stats.sessions ?? 0} sesi absensi`} />
          <StatCard tone="blue" icon="▤" label="Jurnal Mengajar" value={stats.journals} sub="Pertemuan tercatat" />
        </div>

        <div className="charts-grid">
          <article className="chart-card">
            <div className="card-heading">
              <div>
                <h2>Grafik Kehadiran</h2>
                <p>Persentase hadir per hari · pekan terpilih</p>
              </div>
              <span className="chart-tag">7 hari</span>
            </div>
            <div className="bar-chart" aria-label="Grafik kehadiran mingguan">
              {weekly.length === 0 && <p className="chart-footnote">Belum ada data pekan ini.</p>}
              {weekly.map((day) => {
                const label = (() => {
                  try {
                    return new Date(`${day.date}T12:00:00Z`).toLocaleDateString('id-ID', { weekday: 'short', timeZone: 'UTC' });
                  } catch {
                    return day.date;
                  }
                })();
                return (
                  <div
                    key={day.date}
                    className="bar-column"
                    aria-label={`${label}, ${day.date}: ${day.rate === null ? 'belum ada catatan' : `${day.rate}% hadir dari ${day.total} catatan`}`}
                  >
                    <span className="bar-value">{day.rate === null ? '—' : `${day.rate}%`}</span>
                    <div className="bar-track">
                      <div
                        className="bar-fill"
                        style={{
                          height: `${day.rate === null ? 0 : Math.min(100, Math.max(0, day.rate))}%`,
                          background: day.rate === null ? '#e4e8dd' : undefined,
                        }}
                      />
                    </div>
                    <span className="bar-label">{label}</span>
                  </div>
                );
              })}
            </div>
            <p className="chart-footnote">Persentase dari catatan absensi yang sudah diisi.</p>
          </article>

          <article className="chart-card">
            <div className="card-heading">
              <div>
                <h2>Komposisi Kehadiran</h2>
                <p>Rekap status pada tanggal terpilih</p>
              </div>
              <span aria-hidden="true">▦</span>
            </div>
            <div className="composition-layout">
              <div
                className="donut"
                role="img"
                aria-label={total ? `${composition.rate}% hadir dari ${total} catatan absensi` : 'Belum ada catatan absensi'}
                style={{ background: total ? `conic-gradient(${gradient})` : '#e9ece4' }}
              >
                <div className="donut-center">
                  <strong>{composition.rate === null || composition.rate === undefined ? '—' : `${composition.rate}%`}</strong>
                  <span>Hadir</span>
                </div>
              </div>
              <ul className="legend">
                {STATUS_META.map(([code, label, color]) => {
                  const count = counts[code] || 0;
                  const percent = total ? Math.round((count / total) * 100) : 0;
                  return (
                    <li key={code}>
                      <span className="legend-dot" style={{ background: color }} />
                      <span>{label}</span>
                      <strong>{percent}% <span className="legend-count">({count})</span></strong>
                    </li>
                  );
                })}
              </ul>
            </div>
            <p className="chart-footnote">
              {total
                ? `${total} catatan siswa-sesi · siswa dapat tercatat pada beberapa sesi.`
                : 'Belum ada catatan absensi pada tanggal ini. Tidak dihitung sebagai alfa.'}
            </p>
          </article>
        </div>

        <div className="development-note">
          <span aria-hidden="true">✧</span>
          <p><strong>Ruang tumbuh sekolah Anda.</strong> Kelas, siswa, dan absensi tersedia. Modul lain dikembangkan bertahap.</p>
          <span className="version-tag">Tahap 3</span>
        </div>
      </section>
    </>
  );
}
