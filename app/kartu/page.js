// Kartu ID siswa (porting components/student-cards.js asli):
// preview kartu portrait 54 x 85,6 mm per siswa / per kelas, unduh PDF kartu
// (GET /api/export/cards) dan ekspor Excel data siswa (GET /api/export/students).
// Cetak browser menata kartu di kertas A4 (skala 100%).
'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import api from '@/lib/api';
import { useToast } from '@/components/Toast';
import StudentCard from '@/components/StudentCard';

function KartuContent() {
  const toast = useToast();
  const searchParams = useSearchParams();
  const initialClass = searchParams.get('classId') || '';
  const initialStudent = searchParams.get('studentId') || '';
  const [classes, setClasses] = useState([]);
  const [classId, setClassId] = useState(initialClass);
  const [school, setSchool] = useState({});
  const [cards, setCards] = useState([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [isError, setIsError] = useState(false);

  const showMessage = useCallback((text, error = false) => {
    setMessage(text);
    setIsError(error);
  }, []);

  useEffect(() => {
    api.listClasses({ status: 'active' })
      .then((list) => setClasses(Array.isArray(list) ? list : list?.items || []))
      .catch(() => setClasses([]));
  }, []);

  const refresh = useCallback(async (selection) => {
    setLoading(true);
    showMessage('Menyiapkan identitas sekolah dan kartu…');
    try {
      const data = await api.prepareStudentCards(selection);
      const schoolData = data?.school || {};
      const list = data?.cards || data?.students || (Array.isArray(data) ? data : []);
      setSchool(schoolData);
      setCards(list);
      showMessage(`${list.length} kartu siap ditinjau. QR hanya berisi token, tanpa data pribadi.`);
    } catch (err) {
      setCards([]);
      showMessage(err?.message || 'Kartu belum dapat disiapkan.', true);
      toast.error(err?.message || 'Kartu belum dapat disiapkan.');
    } finally {
      setLoading(false);
    }
  }, [showMessage, toast]);

  useEffect(() => {
    if (initialStudent) refresh({ studentIds: [initialStudent] });
    else if (initialClass) refresh({ classId: initialClass });
    // Hanya saat pertama kali dibuka dari tautan (?classId / ?studentId).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleShow() {
    if (!classId) {
      showMessage('Pilih kelas untuk cetak massal.', true);
      return;
    }
    refresh({ classId });
  }

  async function handleDownloadPdf() {
    if (busy || !cards.length) return;
    setBusy(true);
    showMessage('Menyiapkan PDF kartu…');
    try {
      // Ambil ulang agar perubahan pengaturan sekolah ikut ke output.
      await refresh(classId ? { classId } : { studentIds: cards.map((c) => c.id).filter(Boolean) });
      const blob = await api.exportCards({ classId: classId || undefined });
      api.downloadBlob(blob, blob.filename || 'kartu-id-siswa.pdf');
      showMessage('PDF kartu siap diunduh.');
      toast.success('PDF kartu siap diunduh.');
    } catch (err) {
      showMessage(err?.message || 'Gagal mengunduh PDF kartu.', true);
      toast.error(err?.message || 'Gagal mengunduh PDF kartu.');
    } finally {
      setBusy(false);
    }
  }

  async function handleExportExcel() {
    if (busy) return;
    setBusy(true);
    showMessage('Menyiapkan berkas Excel…');
    try {
      const blob = await api.exportStudentData({ classId: classId || undefined });
      api.downloadBlob(blob, blob.filename || 'data-siswa.xlsx');
      showMessage('Berkas Excel siap diunduh.');
      toast.success('Berkas Excel siap diunduh.');
    } catch (err) {
      showMessage(err?.message || 'Gagal mengunduh data.', true);
      toast.error(err?.message || 'Gagal mengunduh data.');
    } finally {
      setBusy(false);
    }
  }

  function handlePrint() {
    document.body.classList.add('printing-cards');
    const cleanup = () => document.body.classList.remove('printing-cards');
    window.addEventListener('afterprint', cleanup, { once: true });
    window.print();
  }

  return (
    <>
      <header className="topbar">
        <div className="page-heading">
          <div>
            <p className="eyebrow">RUANG SEKOLAH</p>
            <h1>Kartu ID Siswa</h1>
          </div>
        </div>
      </header>
      <section className="module-panel card-print-area" aria-label="Kartu ID siswa">
        <p className="eyebrow">RUANG SEKOLAH</p>
        <h2>Kartu ID Siswa</h2>
        <p>Preview kartu portrait 54 × 85,6 mm. Periksa foto, identitas, dan QR sebelum mencetak (skala 100%).</p>

        <div className="page-tools">
          <label className="form-field">
            <span>Kelas cetak massal</span>
            <select value={classId} onChange={(e) => { setClassId(e.target.value); setCards([]); }}>
              <option value="">Pilih kelas aktif</option>
              {classes.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </label>
          <button type="button" className="button coral" onClick={handleShow} disabled={loading}>
            Tampilkan kartu
          </button>
          <button type="button" className="button light" onClick={handlePrint} disabled={!cards.length}>
            Cetak kartu
          </button>
          <button type="button" className="button light" onClick={handleDownloadPdf} disabled={busy || !cards.length}>
            Unduh PDF kartu
          </button>
          <button type="button" className="button light" onClick={handleExportExcel} disabled={busy}>
            Ekspor Excel
          </button>
        </div>

        {message && (
          <p className={`page-feedback${isError ? ' is-error' : ''}`} role={isError ? 'alert' : 'status'}>{message}</p>
        )}
        {loading && <p className="notice">Menyiapkan kartu…</p>}

        <p className="preview-note">Portrait 54 × 85,6 mm · periksa foto, identitas, dan QR sebelum mencetak.</p>
        <div className="id-preview-grid">
          {cards.map((card) => (
            <StudentCard key={card.id || card.nis || card.name} school={school} student={card} />
          ))}
        </div>
        {!loading && cards.length === 0 && (
          <p className="notice">Belum ada kartu ditampilkan. Pilih kelas lalu tekan Tampilkan kartu.</p>
        )}
      </section>
    </>
  );
}

// useSearchParams wajib berada di dalam batas Suspense (Next.js 14).
export default function KartuPage() {
  return (
    <Suspense fallback={<p className="notice">Memuat halaman kartu…</p>}>
      <KartuContent />
    </Suspense>
  );
}
