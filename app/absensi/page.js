// Absensi Siswa (porting pages/attendance.js asli): pilih tanggal/kelas/sesi
// harian atau mapel, roster aktif, H/S/I/A + catatan, simpan/edit, ringkasan,
// pencegahan duplikasi (server menolak revision lama). Tab "Scan QR" membuka
// pemindai; draft manual yang belum disimpan harus disimpan/muat ulang dulu.
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import api from '@/lib/api';
import { useToast } from '@/components/Toast';
import DataTable from '@/components/DataTable';
import QrScanner from '@/components/QrScanner';

const STATUS_OPTIONS = [
  ['', 'Belum diisi'],
  ['H', 'Hadir'],
  ['S', 'Sakit'],
  ['I', 'Izin'],
  ['A', 'Alfa'],
];

function todayId() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export default function AbsensiPage() {
  const toast = useToast();
  const [classes, setClasses] = useState([]);
  const [classId, setClassId] = useState('');
  const [date, setDate] = useState(todayId());
  const [jenis, setJenis] = useState('HARIAN');
  const [subjects, setSubjects] = useState([]);
  const [subjectId, setSubjectId] = useState('');
  const [loaded, setLoaded] = useState(null); // hasil getAttendance
  const [drafts, setDrafts] = useState([]);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [caption, setCaption] = useState('');
  const [message, setMessage] = useState('');
  const [isError, setIsError] = useState(false);
  const [tab, setTab] = useState('manual'); // manual | scan
  const scannerKeyRef = useRef(0);

  const showMessage = useCallback((text, error = false) => {
    setMessage(text);
    setIsError(error);
  }, []);

  const selection = useCallback(() => ({
    classId,
    date,
    jenis,
    subjectId: jenis === 'MAPEL' ? subjectId : '',
  }), [classId, date, jenis, subjectId]);

  const selectionMatches = useCallback(() => {
    if (!loaded) return false;
    const sel = selection();
    return ['classId', 'date', 'jenis', 'subjectId'].every(
      (k) => (loaded[k] ?? '') === (sel[k] ?? '')
    );
  }, [loaded, selection]);

  useEffect(() => {
    api.listClasses({ status: 'active' })
      .then((list) => {
        const items = Array.isArray(list) ? list : list?.items || [];
        setClasses(items);
        if (items.length && !classId) setClassId(items[0].id);
      })
      .catch((err) => showMessage(err?.message || 'Daftar kelas belum dapat dimuat.', true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refreshSubjects = useCallback(async (cid) => {
    if (!cid) {
      setSubjects([]);
      return;
    }
    try {
      const options = await api.getAttendanceOptions({ classId: cid });
      const list = options?.subjects || [];
      setSubjects(list);
      setSubjectId((prev) => (list.some((s) => s.id === prev) ? prev : list[0]?.id || ''));
    } catch (err) {
      setSubjects([]);
      showMessage(err?.message || 'Mata pelajaran belum tersedia.', true);
    }
  }, [showMessage]);

  useEffect(() => {
    if (classId) refreshSubjects(classId);
  }, [classId, refreshSubjects]);

  const load = useCallback(async () => {
    if (saving) return;
    if (dirty && !window.confirm('Muat ulang siswa? Perubahan absensi yang belum disimpan akan dilepas.')) return;
    if (jenis === 'MAPEL' && !subjectId) {
      showMessage('Pilih mata pelajaran yang ditugaskan.', true);
      return;
    }
    setLoaded(null);
    setDrafts([]);
    setDirty(false);
    setBlocked(false);
    setCaption('');
    showMessage('Memuat siswa dan absensi…');
    try {
      const data = await api.getAttendance(selection());
      setLoaded(data);
      setDrafts((data?.entries || []).map((row) => ({ ...row })));
      const className = classes.find((c) => c.id === data.classId)?.name || '';
      setCaption(
        `${className} · ${data.date} · ${data.jenis === 'HARIAN' || data.kind === 'HARIAN' ? 'Harian' : 'Mata pelajaran'} · ${(data?.entries || []).length} siswa aktif`
      );
      showMessage(
        data?.retainedCount
          ? `${data.retainedCount} catatan historis di luar roster aktif tetap tersimpan dan tidak diedit di sini.`
          : (data?.entries || []).length
            ? 'Pilih status setiap siswa. Tanpa catatan tidak otomatis dianggap alfa.'
            : 'Belum ada siswa aktif pada kelas ini.'
      );
    } catch (err) {
      showMessage(err?.message || 'Gagal memuat absensi.', true);
    }
  }, [saving, dirty, jenis, subjectId, selection, classes, showMessage]);

  // Muat roster pertama kali setelah kelas tersedia.
  useEffect(() => {
    if (classId && !loaded) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [classId]);

  const counts = { H: 0, S: 0, I: 0, A: 0, pending: 0 };
  drafts.forEach((row) => {
    counts[row.status || 'pending']++;
  });

  function changeTab(next) {
    if (saving) {
      showMessage('Tunggu proses yang sedang berjalan.', true);
      return;
    }
    if (next === 'scan' && dirty) {
      showMessage('Simpan atau muat ulang draft absensi manual sebelum membuka scan QR.', true);
      return;
    }
    if (next === 'manual') scannerKeyRef.current += 1; // lepas kamera
    setTab(next);
  }

  function updateDraft(index, patch) {
    setDrafts((prev) => prev.map((row, i) => (i === index ? { ...row, ...patch } : row)));
    setDirty(true);
  }

  async function saveEntries() {
    if (saving || blocked || !selectionMatches()) return;
    if (drafts.some((row) => !row.status)) {
      showMessage('Lengkapi status seluruh siswa sebelum menyimpan.', true);
      return;
    }
    setSaving(true);
    showMessage('Menyimpan absensi…');
    try {
      const data = await api.saveAttendance({
        ...selection(),
        expectedRevision: loaded.revision,
        entries: drafts.map((row) => ({ studentId: row.studentId, status: row.status, note: row.note || '' })),
      });
      setLoaded(data);
      setDrafts((data?.entries || []).map((row) => ({ ...row })));
      setDirty(false);
      showMessage('Absensi berhasil disimpan.');
      toast.success('Absensi berhasil tersimpan.');
    } catch (err) {
      if (['CONFLICT', 'RECOVERY_REQUIRED'].includes(err?.code)) setBlocked(true);
      showMessage(err?.message || 'Gagal menyimpan absensi.', true);
      toast.error(err?.message || 'Gagal menyimpan absensi.');
    } finally {
      setSaving(false);
    }
  }

  function handleQrSaved(data) {
    if (!data) return;
    setLoaded(data);
    setDrafts((data?.entries || []).map((row) => ({ ...row })));
    setDirty(false);
    setBlocked(false);
    setTab('manual');
  }

  const matches = selectionMatches();
  const controlsDisabled = saving || !matches;

  return (
    <>
      <header className="topbar">
        <div className="page-heading">
          <div>
            <p className="eyebrow">RUANG SEKOLAH</p>
            <h1>Absensi Siswa</h1>
          </div>
        </div>
      </header>
      <section className="module-panel" aria-label="Absensi siswa">
        <p className="eyebrow">RUANG SEKOLAH</p>
        <h2>Absensi Siswa</h2>
        <p>Tandai kehadiran harian atau per mata pelajaran. Simpan setelah semua status terisi.</p>

        <form
          className="page-tools attendance-filters"
          onSubmit={(e) => {
            e.preventDefault();
            load();
          }}
        >
          <label className="form-field">
            <span>Kelas absensi</span>
            <select value={classId} required onChange={(e) => setClassId(e.target.value)} disabled={saving}>
              {classes.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </label>
          <label className="form-field">
            <span>Tanggal absensi</span>
            <input type="date" value={date} required disabled={saving} onChange={(e) => setDate(e.target.value)} />
          </label>
          <label className="form-field">
            <span>Jenis sesi</span>
            <select value={jenis} disabled={saving} onChange={(e) => setJenis(e.target.value)}>
              <option value="HARIAN">Harian</option>
              <option value="MAPEL">Mata pelajaran</option>
            </select>
          </label>
          {jenis === 'MAPEL' && (
            <label className="form-field">
              <span>Mata pelajaran</span>
              <select value={subjectId} disabled={saving} onChange={(e) => setSubjectId(e.target.value)}>
                <option value="">Pilih mata pelajaran</option>
                {subjects.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            </label>
          )}
          <button type="submit" className="button coral" disabled={saving}>Tampilkan siswa</button>
        </form>

        {message && (
          <p className={`page-feedback${isError ? ' is-error' : ''}`} role={isError ? 'alert' : 'status'}>{message}</p>
        )}
        {!matches && loaded === null && (
          <p className="attendance-caption">Pilihan berubah. Klik Tampilkan siswa sebelum mengisi atau menyimpan.</p>
        )}
        {caption && <p className="attendance-caption">{caption}</p>}

        <div className="attendance-tabs" role="tablist" aria-label="Metode absensi">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'manual'}
            className="button light"
            onClick={() => changeTab('manual')}
          >
            Absensi Manual
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'scan'}
            className="button light"
            onClick={() => changeTab('scan')}
          >
            Scan QR
          </button>
        </div>

        {tab === 'manual' ? (
          <div role="tabpanel" aria-label="Absensi manual">
            <div className="attendance-summary" aria-live="polite">
              <span className="summary-chip status-H">Hadir: {counts.H}</span>
              <span className="summary-chip status-S">Sakit: {counts.S}</span>
              <span className="summary-chip status-I">Izin: {counts.I}</span>
              <span className="summary-chip status-A">Alfa: {counts.A}</span>
              <span className="summary-chip status-pending">Belum diisi: {counts.pending}</span>
            </div>
            <div className="form-actions">
              <button
                type="button"
                className="button light"
                disabled={controlsDisabled || blocked || !drafts.some((d) => !d.status)}
                onClick={() => {
                  setDrafts((prev) => prev.map((d) => (d.status ? d : { ...d, status: 'H' })));
                  setDirty(true);
                }}
              >
                Isi yang belum diisi: Hadir
              </button>
              <button type="button" className="button coral" disabled={controlsDisabled || blocked || !drafts.length} onClick={saveEntries}>
                Simpan absensi
              </button>
            </div>
            <DataTable
              columns={[
                { key: 'nis', label: 'NIS' },
                { key: 'name', label: 'Nama siswa' },
                {
                  key: 'status',
                  label: 'Status kehadiran',
                  render: (row) => {
                    const index = drafts.findIndex((d) => d.studentId === row.studentId);
                    return (
                      <select
                        aria-label={`Status ${row.name}`}
                        value={row.status || ''}
                        disabled={controlsDisabled || blocked}
                        onChange={(e) => updateDraft(index, { status: e.target.value || null })}
                      >
                        {STATUS_OPTIONS.map(([value, label]) => (
                          <option key={value} value={value}>{label}</option>
                        ))}
                      </select>
                    );
                  },
                },
                {
                  key: 'note',
                  label: 'Catatan',
                  render: (row) => {
                    const index = drafts.findIndex((d) => d.studentId === row.studentId);
                    return (
                      <input
                        type="text"
                        maxLength={500}
                        aria-label={`Catatan ${row.name}`}
                        value={row.note || ''}
                        disabled={controlsDisabled || blocked}
                        onChange={(e) => updateDraft(index, { note: e.target.value })}
                      />
                    );
                  },
                },
              ]}
              rows={drafts}
              emptyText="Klik Tampilkan siswa untuk memuat roster."
            />
          </div>
        ) : (
          <div role="tabpanel" aria-label="Scan QR Code">
            <QrScanner
              key={scannerKeyRef.current}
              selection={() => {
                if (!selectionMatches()) {
                  throw new Error('Klik Tampilkan siswa untuk memuat kelas, tanggal, dan sesi yang dipilih.');
                }
                return selection();
              }}
              onSaved={handleQrSaved}
            />
          </div>
        )}
      </section>
    </>
  );
}
