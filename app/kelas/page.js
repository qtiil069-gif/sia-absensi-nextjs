// Data Kelas (porting pages/classes.js asli): baca, cari/filter, tambah,
// edit, nonaktifkan. Mutasi hanya tampil bila peran Admin Kepala Sekolah.
'use client';

import { useCallback, useEffect, useState } from 'react';
import api from '@/lib/api';
import { useProfile } from '@/lib/useProfile';
import { useToast } from '@/components/Toast';
import DataTable from '@/components/DataTable';

const LEVELS = Array.from({ length: 12 }, (_, i) => i + 1);

export default function KelasPage() {
  const toast = useToast();
  const { isAdmin } = useProfile();
  const [rows, setRows] = useState([]);
  const [years, setYears] = useState([]);
  const [teachers, setTeachers] = useState([]);
  const [query, setQuery] = useState('');
  const [level, setLevel] = useState('');
  const [status, setStatus] = useState('active');
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');
  const [isError, setIsError] = useState(false);
  const [editing, setEditing] = useState(null); // null = tutup, {} = tambah, row = edit
  const [form, setForm] = useState({ name: '', level: 1, yearId: '', homeroomId: '' });
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');

  const showMessage = useCallback((text, error = false) => {
    setMessage(text);
    setIsError(error);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const records = await api.listClasses({
        q: query || undefined,
        level: level || undefined,
        status: isAdmin ? status : 'active',
      });
      setRows(Array.isArray(records) ? records : records?.items || []);
    } catch (err) {
      showMessage(err?.message || 'Data kelas belum dapat ditampilkan.', true);
    } finally {
      setLoading(false);
    }
  }, [query, level, status, isAdmin, showMessage]);

  useEffect(() => {
    // Metadata tahun ajaran & wali kelas (lihat catatan kontrak di lib/api.js).
    api.getRosterOptions()
      .then((meta) => {
        setYears(meta?.years || []);
        setTeachers(meta?.teachers || []);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    const t = setTimeout(load, query ? 350 : 0);
    return () => clearTimeout(t);
  }, [load, query]);

  function openEditor(row) {
    if (!isAdmin) return;
    setFormError('');
    setForm({
      name: row?.name || '',
      level: row?.level || 1,
      yearId: row?.yearId || years.find((y) => y.active)?.id || '',
      homeroomId: row?.homeroomId || '',
    });
    setEditing(row || {});
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (saving) return;
    setSaving(true);
    setFormError('');
    try {
      const payload = {
        name: form.name.trim(),
        level: Number(form.level),
        yearId: form.yearId,
        homeroomId: form.homeroomId || '',
      };
      if (editing?.id) {
        await api.updateClass({ ...payload, id: editing.id, expectedRevision: editing.revision });
        toast.success('Kelas berhasil diperbarui.');
      } else {
        await api.createClass(payload);
        toast.success('Kelas berhasil disimpan.');
      }
      setEditing(null);
      showMessage('Kelas berhasil disimpan.');
      await load();
    } catch (err) {
      setFormError(err?.message || 'Gagal menyimpan kelas.');
      toast.error(err?.message || 'Gagal menyimpan kelas.');
    } finally {
      setSaving(false);
    }
  }

  async function handleDeactivate(row) {
    if (!row.active || saving) return;
    if (!window.confirm(`Nonaktifkan kelas ${row.name}? Data siswa dan riwayat tetap disimpan.`)) return;
    setSaving(true);
    try {
      await api.deactivateClass({ id: row.id, expectedRevision: row.revision });
      showMessage('Kelas dinonaktifkan. Data dan riwayat tetap tersimpan.');
      toast.success('Kelas berhasil dinonaktifkan.');
      await load();
    } catch (err) {
      showMessage(err?.message || 'Gagal menonaktifkan kelas.', true);
      toast.error(err?.message || 'Gagal menonaktifkan kelas.');
    } finally {
      setSaving(false);
    }
  }

  const yearName = (row) => years.find((y) => y.id === row.yearId)?.name || row.yearId || '—';
  const teacherName = (row) => teachers.find((t) => t.id === row.homeroomId)?.name || row.homeroomName || '';

  return (
    <>
      <header className="topbar">
        <div className="page-heading">
          <div>
            <p className="eyebrow">RUANG SEKOLAH</p>
            <h1>Data Kelas</h1>
          </div>
        </div>
      </header>
      <section className="module-panel" aria-label="Data kelas">
        <p className="eyebrow">RUANG SEKOLAH</p>
        <h2>Data Kelas</h2>
        <p>Kelola rombongan belajar: tambah, ubah, dan nonaktifkan kelas. Nonaktif mempertahankan data dan riwayat.</p>

        <div className="page-tools">
          <label className="form-field">
            <span>Cari kelas</span>
            <input type="search" value={query} maxLength={100} placeholder="Nama kelas…" onChange={(e) => setQuery(e.target.value)} />
          </label>
          <label className="form-field">
            <span>Tingkat</span>
            <select value={level} onChange={(e) => setLevel(e.target.value)}>
              <option value="">Semua tingkat</option>
              {LEVELS.map((n) => (
                <option key={n} value={n}>{n}</option>
              ))}
            </select>
          </label>
          {isAdmin && (
            <label className="form-field">
              <span>Status kelas</span>
              <select value={status} onChange={(e) => setStatus(e.target.value)}>
                <option value="active">Aktif</option>
                <option value="inactive">Nonaktif</option>
                <option value="all">Semua status</option>
              </select>
            </label>
          )}
          <button type="button" className="button light" onClick={() => { setEditing(null); showMessage(''); load(); }}>
            Muat ulang
          </button>
          {isAdmin && (
            <button type="button" className="button coral" onClick={() => openEditor(null)}>
              Tambah kelas
            </button>
          )}
        </div>

        {message && (
          <p className={`page-feedback${isError ? ' is-error' : ''}`} role={isError ? 'alert' : 'status'}>{message}</p>
        )}
        {loading && <p className="notice">Memuat data kelas…</p>}

        {editing && (
          <section className="record-editor" aria-label={editing.id ? 'Edit kelas' : 'Tambah kelas'}>
            <h3>{editing.id ? 'Edit kelas' : 'Tambah kelas'}</h3>
            {formError && <p className="page-feedback is-error" role="alert">{formError}</p>}
            {!years.length && (
              <p className="page-feedback is-error" role="alert">
                Daftar tahun ajaran belum tersedia dari server. Isi kolom tahun ajaran dengan ID/nama tahun ajaran.
              </p>
            )}
            <form className="record-form" onSubmit={handleSubmit}>
              <label className="form-field">
                <span>Nama kelas</span>
                <input value={form.name} maxLength={60} required onChange={(e) => setForm({ ...form, name: e.target.value })} />
              </label>
              <label className="form-field">
                <span>Tingkat kelas</span>
                <input type="number" min={1} max={12} required value={form.level} onChange={(e) => setForm({ ...form, level: e.target.value })} />
              </label>
              <label className="form-field">
                <span>Tahun ajaran</span>
                {years.length ? (
                  <select value={form.yearId} required onChange={(e) => setForm({ ...form, yearId: e.target.value })}>
                    <option value="">Pilih tahun ajaran</option>
                    {years.filter((y) => y.active || y.id === form.yearId).map((y) => (
                      <option key={y.id} value={y.id}>{y.name}</option>
                    ))}
                  </select>
                ) : (
                  <input value={form.yearId} required placeholder="cth. 2026/2027" onChange={(e) => setForm({ ...form, yearId: e.target.value })} />
                )}
              </label>
              <label className="form-field">
                <span>Wali kelas</span>
                {teachers.length ? (
                  <select value={form.homeroomId} onChange={(e) => setForm({ ...form, homeroomId: e.target.value })}>
                    <option value="">Belum ditetapkan</option>
                    {teachers.map((t) => (
                      <option key={t.id} value={t.id}>{t.name}</option>
                    ))}
                  </select>
                ) : (
                  <select value={form.homeroomId} onChange={(e) => setForm({ ...form, homeroomId: e.target.value })}>
                    <option value="">Belum ditetapkan</option>
                  </select>
                )}
              </label>
              <div className="form-actions">
                <button type="submit" className="button coral" disabled={saving}>Simpan</button>
                <button type="button" className="button light" onClick={() => setEditing(null)}>Batal</button>
              </div>
            </form>
          </section>
        )}

        <DataTable
          columns={[
            { key: 'name', label: 'Kelas' },
            { key: 'level', label: 'Tingkat' },
            { key: 'yearId', label: 'Tahun ajaran', render: (row) => yearName(row) },
            { key: 'homeroom', label: 'Wali kelas', render: (row) => teacherName(row) || '—' },
            { key: 'active', label: 'Status', render: (row) => (row.active ? 'Aktif' : 'Nonaktif') },
            ...(isAdmin
              ? [{
                  key: 'actions',
                  label: 'Tindakan',
                  render: (row) => (
                    <div className="row-actions">
                      <button type="button" className="button light" onClick={() => openEditor(row)}>Edit</button>
                      <button type="button" className="button light" onClick={() => handleDeactivate(row)} disabled={!row.active}>
                        Nonaktifkan
                      </button>
                    </div>
                  ),
                }]
              : []),
          ]}
          rows={rows}
          emptyText="Belum ada kelas yang cocok dengan filter."
        />
      </section>
    </>
  );
}
