// Data Siswa (porting pages/students.js asli): baca, tambah, edit,
// nonaktifkan, pindah kelas, validasi NIS unik (server), pencarian nama/NIS,
// filter kelas/status, pagination server. Foto diunggah ke bucket Storage
// "siswa-foto" dengan path {student_id}/{nama-file}. Kartu ID dapat dilihat
// per siswa; cetak massal & ekspor ada di halaman Kartu ID.
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import api from '@/lib/api';
import { createClient } from '@/lib/supabase/client';
import { useProfile } from '@/lib/useProfile';
import { useToast } from '@/components/Toast';
import DataTable from '@/components/DataTable';
import StudentCard from '@/components/StudentCard';

const PAGE_SIZES = [10, 25, 50, 100];

// Unggah foto ke bucket "siswa-foto" path {student_id}/{nama-file}.
async function uploadStudentPhoto(studentId, file) {
  const supabase = createClient();
  const safeName = String(file.name || 'foto.jpg').replace(/[^\w.\-]+/g, '_');
  const path = `${studentId}/${safeName}`;
  const { error } = await supabase.storage.from('siswa-foto').upload(path, file, {
    upsert: true,
    contentType: file.type || undefined,
  });
  if (error) throw new Error(`Gagal mengunggah foto: ${error.message}`);
  const { data } = supabase.storage.from('siswa-foto').getPublicUrl(path);
  return data?.publicUrl || path;
}

const EMPTY_FORM = {
  name: '', nis: '', nisn: '', classId: '',
  guardianName: '', guardianPhone: '', guardianRelation: '', photo: '',
};

export default function SiswaPage() {
  const toast = useToast();
  const { isAdmin } = useProfile();
  const [rows, setRows] = useState([]);
  const [classes, setClasses] = useState([]);
  const [school, setSchool] = useState({});
  const [query, setQuery] = useState('');
  const [classId, setClassId] = useState('');
  const [status, setStatus] = useState('active');
  const [pageSize, setPageSize] = useState(25);
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');
  const [isError, setIsError] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [photoFile, setPhotoFile] = useState(null);
  const [photoPreview, setPhotoPreview] = useState('');
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');
  const [cardStudent, setCardStudent] = useState(null);
  const fileInputRef = useRef(null);

  const showMessage = useCallback((text, error = false) => {
    setMessage(text);
    setIsError(error);
  }, []);

  const load = useCallback(async (targetPage = page) => {
    setLoading(true);
    try {
      const result = await api.queryStudents({
        q: query || undefined,
        classId: classId || undefined,
        status: isAdmin ? status : 'active',
        page: targetPage,
        pageSize,
      });
      setRows(result?.items || []);
      setTotal(result?.total ?? result?.items?.length ?? 0);
      setPage(result?.page || targetPage);
      setPages(result?.pages || 1);
    } catch (err) {
      showMessage(err?.message || 'Data siswa belum dapat ditampilkan.', true);
    } finally {
      setLoading(false);
    }
  }, [query, classId, status, pageSize, page, isAdmin, showMessage]);

  useEffect(() => {
    api.listClasses(isAdmin ? { status: 'all' } : {})
      .then((list) => setClasses(Array.isArray(list) ? list : list?.items || []))
      .catch(() => setClasses([]));
    api.getSchoolSettings().then(setSchool).catch(() => setSchool({}));
  }, [isAdmin]);

  useEffect(() => {
    const t = setTimeout(() => load(1), query ? 350 : 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, classId, status, pageSize]);

  const classNameOf = (row) => {
    const ids = row.classIds || (row.classId ? [row.classId] : []);
    return ids.map((id) => classes.find((c) => c.id === id)?.name || id).join(', ') || 'Belum ditetapkan';
  };

  function openEditor(row) {
    if (!isAdmin) return;
    setFormError('');
    setPhotoFile(null);
    setPhotoPreview(row?.photo || '');
    setForm({
      name: row?.name || '',
      nis: row?.nis || '',
      nisn: row?.nisn || '',
      classId: row?.classIds?.[0] || row?.classId || '',
      guardianName: row?.guardianName || '',
      guardianPhone: row?.guardianPhone || '',
      guardianRelation: row?.guardianRelation || '',
      photo: row?.photo || '',
    });
    setEditing(row || {});
  }

  function handlePhotoChange(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      setFormError('Ukuran foto maksimal 5 MB.');
      return;
    }
    setPhotoFile(file);
    setPhotoPreview(URL.createObjectURL(file));
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (saving) return;
    setSaving(true);
    setFormError('');
    try {
      const profile = {
        guardianName: form.guardianName.trim(),
        guardianPhone: form.guardianPhone.trim(),
        guardianRelation: form.guardianRelation.trim(),
        photo: form.photo,
      };
      const base = {
        name: form.name.trim(),
        nis: form.nis.trim(),
        nisn: form.nisn.trim(),
        classId: form.classId,
        ...profile,
      };
      let saved;
      if (editing?.id) {
        saved = await api.updateStudent({ ...base, id: editing.id, expectedRevision: editing.revision });
      } else {
        saved = await api.createStudent(base);
      }
      const studentId = saved?.id || editing?.id;
      // Foto baru diunggah setelah siswa tersimpan (butuh student_id untuk path).
      if (photoFile && studentId) {
        try {
          const url = await uploadStudentPhoto(studentId, photoFile);
          await api.updateStudent({ id: studentId, photo: url, expectedRevision: saved?.revision ?? editing?.revision });
        } catch (uploadErr) {
          toast.error(`${uploadErr.message} Data siswa tetap tersimpan; coba unggah ulang fotonya.`);
        }
      }
      setEditing(null);
      showMessage('Data siswa berhasil disimpan.');
      toast.success(editing?.id ? 'Data siswa berhasil diperbarui.' : 'Data siswa berhasil disimpan.');
      await load(1);
    } catch (err) {
      setFormError(err?.message || 'Gagal menyimpan data siswa.');
      toast.error(err?.message || 'Gagal menyimpan data siswa.');
    } finally {
      setSaving(false);
    }
  }

  async function handleDeactivate(row) {
    if (!row.active || saving) return;
    if (!window.confirm(`Nonaktifkan siswa ${row.name}? Data dan riwayat absensi tetap disimpan.`)) return;
    setSaving(true);
    try {
      await api.deactivateStudent({ id: row.id, expectedRevision: row.revision });
      showMessage('Siswa dinonaktifkan tanpa menghapus riwayat.');
      toast.success('Data siswa berhasil dinonaktifkan.');
      await load(page);
    } catch (err) {
      showMessage(err?.message || 'Gagal menonaktifkan siswa.', true);
      toast.error(err?.message || 'Gagal menonaktifkan siswa.');
    } finally {
      setSaving(false);
    }
  }

  async function handleExportExcel() {
    try {
      showMessage('Menyiapkan berkas Excel…');
      const blob = await api.exportStudentData({
        q: query || undefined,
        classId: classId || undefined,
        status: isAdmin ? status : 'active',
      });
      api.downloadBlob(blob, blob.filename || 'data-siswa.xlsx');
      showMessage('Berkas Excel siap diunduh.');
      toast.success('Berkas Excel siap diunduh.');
    } catch (err) {
      showMessage(err?.message || 'Gagal mengunduh data.', true);
      toast.error(err?.message || 'Gagal mengunduh data.');
    }
  }

  return (
    <>
      <header className="topbar">
        <div className="page-heading">
          <div>
            <p className="eyebrow">RUANG SEKOLAH</p>
            <h1>Data Siswa</h1>
          </div>
        </div>
      </header>
      <section className="module-panel" aria-label="Data siswa">
        <p className="eyebrow">RUANG SEKOLAH</p>
        <h2>Data Siswa</h2>
        <p>Kelola siswa aktif dan nonaktif, pindah kelas, foto, data wali, dan kartu ID.</p>

        <div className="page-tools">
          <label className="form-field">
            <span>Cari siswa</span>
            <input type="search" value={query} maxLength={100} placeholder="Nama atau NIS…" onChange={(e) => setQuery(e.target.value)} />
          </label>
          <label className="form-field">
            <span>Filter kelas siswa</span>
            <select value={classId} onChange={(e) => setClassId(e.target.value)}>
              <option value="">Semua kelas</option>
              {classes.map((c) => (
                <option key={c.id} value={c.id}>{c.name}{c.active ? '' : ' (nonaktif)'}</option>
              ))}
            </select>
          </label>
          {isAdmin && (
            <label className="form-field">
              <span>Status siswa</span>
              <select value={status} onChange={(e) => setStatus(e.target.value)}>
                <option value="active">Aktif</option>
                <option value="inactive">Nonaktif</option>
                <option value="all">Semua status</option>
              </select>
            </label>
          )}
          <label className="form-field">
            <span>Siswa per halaman</span>
            <select value={pageSize} onChange={(e) => setPageSize(Number(e.target.value))}>
              {PAGE_SIZES.map((n) => (
                <option key={n} value={n}>{n}</option>
              ))}
            </select>
          </label>
          <button type="button" className="button light" onClick={() => { setEditing(null); showMessage(''); load(1); }}>
            Muat ulang
          </button>
          {isAdmin && (
            <button type="button" className="button coral" onClick={() => openEditor(null)}>
              Tambah siswa
            </button>
          )}
          <Link href={classId ? `/kartu?classId=${encodeURIComponent(classId)}` : '/kartu'} className="button light">
            Cetak Kartu ID
          </Link>
          <button type="button" className="button light" onClick={handleExportExcel}>
            Unduh data Excel
          </button>
        </div>

        {message && (
          <p className={`page-feedback${isError ? ' is-error' : ''}`} role={isError ? 'alert' : 'status'}>{message}</p>
        )}
        {loading && <p className="notice">Memuat data siswa…</p>}

        {editing && (
          <section className="record-editor" aria-label={editing.id ? 'Edit siswa' : 'Tambah siswa'}>
            <h3>{editing.id ? 'Edit siswa' : 'Tambah siswa'}</h3>
            {formError && <p className="page-feedback is-error" role="alert">{formError}</p>}
            <form className="record-form" onSubmit={handleSubmit}>
              <label className="form-field">
                <span>Nama siswa</span>
                <input value={form.name} maxLength={120} required onChange={(e) => setForm({ ...form, name: e.target.value })} />
              </label>
              <label className="form-field">
                <span>NIS</span>
                <input value={form.nis} maxLength={30} required onChange={(e) => setForm({ ...form, nis: e.target.value })} />
              </label>
              <label className="form-field">
                <span>NISN (opsional)</span>
                <input value={form.nisn} maxLength={10} onChange={(e) => setForm({ ...form, nisn: e.target.value })} />
              </label>
              <label className="form-field">
                <span>Kelas siswa</span>
                <select value={form.classId} required onChange={(e) => setForm({ ...form, classId: e.target.value })}>
                  <option value="">Pilih kelas aktif</option>
                  {classes.filter((c) => c.active).map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
              </label>
              <label className="form-field">
                <span>Nama wali murid</span>
                <input value={form.guardianName} maxLength={120} onChange={(e) => setForm({ ...form, guardianName: e.target.value })} />
              </label>
              <label className="form-field">
                <span>Telepon/WhatsApp wali</span>
                <input type="tel" value={form.guardianPhone} maxLength={30} onChange={(e) => setForm({ ...form, guardianPhone: e.target.value })} />
              </label>
              <label className="form-field">
                <span>Hubungan wali dengan siswa</span>
                <input value={form.guardianRelation} maxLength={60} placeholder="Ayah, Ibu, Wali, …" onChange={(e) => setForm({ ...form, guardianRelation: e.target.value })} />
              </label>
              <div className="form-field image-field">
                <span>Foto siswa</span>
                {photoPreview && <img src={photoPreview} alt="Pratinjau foto siswa" />}
                <input ref={fileInputRef} type="file" accept="image/jpeg,image/png,image/webp" onChange={handlePhotoChange} />
                <span>JPEG/PNG/WebP maksimal 5 MB. Foto diunggah ke penyimpanan sekolah setelah data tersimpan.</span>
              </div>
              <div className="form-actions">
                <button type="submit" className="button coral" disabled={saving}>Simpan</button>
                <button type="button" className="button light" onClick={() => setEditing(null)}>Batal</button>
              </div>
            </form>
          </section>
        )}

        {cardStudent && (
          <section className="record-editor" aria-label="Pratinjau kartu ID">
            <h3>Kartu ID — {cardStudent.name}</h3>
            <p className="preview-note">Portrait 54 × 85,6 mm · periksa foto, identitas, dan QR sebelum mencetak.</p>
            <div className="id-preview-grid">
              <StudentCard
                school={school}
                student={{ ...cardStudent, className: classNameOf(cardStudent) }}
              />
            </div>
            <div className="form-actions">
              <Link href={`/kartu?studentId=${encodeURIComponent(cardStudent.id)}`} className="button coral">
                Buka halaman Kartu ID
              </Link>
              <button type="button" className="button light" onClick={() => setCardStudent(null)}>Tutup</button>
            </div>
          </section>
        )}

        <DataTable
          columns={[
            { key: 'nis', label: 'NIS' },
            { key: 'name', label: 'Nama siswa' },
            { key: 'class', label: 'Kelas', render: (row) => classNameOf(row) },
            { key: 'guardianName', label: 'Nama wali' },
            { key: 'guardianPhone', label: 'Telepon/WA wali' },
            { key: 'guardianRelation', label: 'Hubungan' },
            { key: 'active', label: 'Status', render: (row) => (row.active ? 'Aktif' : 'Nonaktif') },
            {
              key: 'actions',
              label: 'Tindakan',
              render: (row) => (
                <div className="row-actions">
                  {isAdmin && (
                    <>
                      <button type="button" className="button light" onClick={() => openEditor(row)}>Edit</button>
                      <button type="button" className="button light" onClick={() => handleDeactivate(row)} disabled={!row.active}>
                        Nonaktifkan
                      </button>
                    </>
                  )}
                  <button type="button" className="button light" onClick={() => setCardStudent(row)} disabled={!row.active}>
                    Kartu ID
                  </button>
                </div>
              ),
            },
          ]}
          rows={rows}
          emptyText="Belum ada siswa yang cocok dengan filter."
        />

        <div className="pagination">
          <span>{total} siswa · Halaman {page} dari {pages}</span>
          <button
            type="button"
            className="button light"
            disabled={page <= 1}
            onClick={() => {
              const p = Math.max(1, page - 1);
              setPage(p);
              load(p);
            }}
          >
            Sebelumnya
          </button>
          <button
            type="button"
            className="button light"
            disabled={page >= pages}
            onClick={() => {
              const p = page + 1;
              setPage(p);
              load(p);
            }}
          >
            Berikutnya
          </button>
        </div>
      </section>
    </>
  );
}
