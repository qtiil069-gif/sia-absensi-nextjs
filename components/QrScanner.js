// Pemindai QR absensi (porting components/qr-scanner.js + lib/qr-camera.js).
// Kamera via @zxing/browser BrowserMultiFormatReader, dengan fallback input
// kode manual (pembaca USB / tempel kode). Kamera dilepas saat QR terbaca,
// saat tombol "Hentikan kamera", saat tab disembunyikan, dan saat komponen
// dilepas. Validasi TIDAK menyimpan absensi: identitas ditampilkan dulu dan
// petugas wajib menekan "Konfirmasi Hadir".
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { BrowserMultiFormatReader } from '@zxing/browser';
import api from '@/lib/api';
import { useToast } from '@/components/Toast';

const STATUS_LABEL = { H: 'Hadir', S: 'Sakit', I: 'Izin', A: 'Alfa' };

export default function QrScanner({ selection, onSaved }) {
  const toast = useToast();
  const videoRef = useRef(null);
  const readerRef = useRef(null);
  const controlsRef = useRef(null);
  const [facing, setFacing] = useState('environment');
  const [code, setCode] = useState('');
  const [message, setMessage] = useState('');
  const [isError, setIsError] = useState(false);
  const [opening, setOpening] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [validating, setValidating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState(null); // hasil validateStudentQr
  const [lastQr, setLastQr] = useState('');

  const showMessage = useCallback((text, error = false) => {
    setMessage(text);
    setIsError(error);
  }, []);

  const stop = useCallback(() => {
    try {
      controlsRef.current?.stop();
    } catch {
      // Abaikan: kontrol sudah berhenti.
    }
    controlsRef.current = null;
    try {
      readerRef.current?.reset();
    } catch {
      // Abaikan.
    }
    const video = videoRef.current;
    if (video?.srcObject) {
      video.srcObject.getTracks().forEach((track) => track.stop());
      video.srcObject = null;
    }
    setScanning(false);
  }, []);

  // Lepas kamera saat tab disembunyikan atau komponen dilepas.
  useEffect(() => {
    const onHidden = () => {
      if (document.hidden) stop();
    };
    document.addEventListener('visibilitychange', onHidden);
    return () => {
      document.removeEventListener('visibilitychange', onHidden);
      stop();
    };
  }, [stop]);

  const validate = useCallback(
    async (qr) => {
      const value = String(qr || '').trim();
      if (!value) {
        showMessage('Masukkan kode QR terlebih dahulu.', true);
        return;
      }
      if (validating || saving) return;
      let sel;
      try {
        sel = typeof selection === 'function' ? selection() : selection;
      } catch (err) {
        showMessage(err?.message || 'Pilih kelas, tanggal, dan sesi terlebih dahulu.', true);
        return;
      }
      setValidating(true);
      stop();
      setResult(null);
      showMessage('QR terbaca. Memvalidasi siswa…');
      try {
        const data = await api.validateStudentQr({ ...sel, qr: value });
        setResult(data);
        setLastQr(value);
        const student = data.student || {};
        if (data.status) {
          showMessage(
            `Siswa sudah tercatat (${STATUS_LABEL[data.status] || data.status}) pada sesi ini. Gunakan Absensi Manual untuk koreksi.`,
            true
          );
        } else {
          showMessage(`Periksa foto dan identitas ${student.name || 'siswa'}, lalu konfirmasi untuk menyimpan Hadir.`);
          toast.success('QR berhasil dipindai. Identitas siswa tervalidasi.');
        }
      } catch (err) {
        showMessage(err?.message || 'Kode QR tidak valid.', true);
        toast.error(err?.message || 'Kode QR tidak valid.');
      } finally {
        setValidating(false);
      }
    },
    [selection, stop, showMessage, toast, validating, saving]
  );

  async function startCamera() {
    if (validating || saving || opening) return;
    stop();
    setOpening(true);
    setResult(null);
    showMessage('Meminta izin kamera…');
    try {
      const reader = new BrowserMultiFormatReader();
      readerRef.current = reader;
      const devices = await BrowserMultiFormatReader.listVideoInputDevices();
      let deviceId;
      if (devices.length > 1) {
        const back = devices.find((d) => /back|rear|belakang|environment/i.test(d.label));
        const front = devices.find((d) => /front|depan|user|face/i.test(d.label));
        deviceId = (facing === 'environment' ? back || devices[0] : front || devices[0])?.deviceId;
      }
      setScanning(true);
      const controls = await reader.decodeFromVideoDevice(deviceId, videoRef.current, (scanResult) => {
        if (scanResult) validate(scanResult.getText());
      });
      controlsRef.current = controls;
      showMessage('Arahkan QR kartu siswa ke kamera. Hasil scan belum menyimpan absensi.');
    } catch (err) {
      setScanning(false);
      showMessage(
        'Kamera tidak dapat dibuka. Periksa izin perangkat/browser. Anda tetap dapat menggunakan pembaca USB/kode atau Absensi Manual.',
        true
      );
    } finally {
      setOpening(false);
    }
  }

  async function confirmAttendance() {
    if (saving || !result) return;
    let sel;
    try {
      sel = typeof selection === 'function' ? selection() : selection;
    } catch (err) {
      showMessage(err?.message || 'Pilihan sesi berubah. Muat ulang roster terlebih dahulu.', true);
      return;
    }
    setSaving(true);
    try {
      const data = await api.saveQrAttendance({
        ...sel,
        qr: lastQr,
        expectedRevision: result.expectedRevision,
      });
      const name = result.student?.name || 'Siswa';
      setResult(null);
      setCode('');
      showMessage(`Kehadiran ${name} berhasil disimpan.`);
      toast.success('Absensi berhasil tersimpan.');
      if (onSaved) onSaved(data);
    } catch (err) {
      showMessage(err?.message || 'Gagal menyimpan kehadiran.', true);
      toast.error(err?.message || 'Gagal menyimpan kehadiran.');
    } finally {
      setSaving(false);
    }
  }

  const student = result?.student || {};

  return (
    <div>
      <p className="attendance-caption">
        Pilih kelas, tanggal, dan sesi di atas. Identitas hasil scan harus dikonfirmasi petugas sebelum disimpan.
      </p>
      {message && (
        <p className={`page-feedback${isError ? ' is-error' : ''}`} role={isError ? 'alert' : 'status'}>
          {message}
        </p>
      )}
      <div className="page-tools">
        <label className="form-field">
          <span>Kamera</span>
          <select value={facing} onChange={(e) => setFacing(e.target.value)}>
            <option value="environment">Kamera belakang / utama</option>
            <option value="user">Kamera depan</option>
          </select>
        </label>
      </div>
      <video ref={videoRef} className="qr-video" autoPlay muted playsInline aria-label="Kamera pemindai QR" />
      <div className="page-tools">
        <label className="form-field">
          <span>Kode QR (alternatif pembaca USB atau tempel)</span>
          <input
            type="text"
            value={code}
            maxLength={100}
            placeholder="SIA-ID:1:…"
            onChange={(e) => setCode(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') validate(code);
            }}
          />
        </label>
      </div>
      <div className="form-actions">
        <button type="button" className="button coral" onClick={startCamera} disabled={opening || validating || saving}>
          {scanning ? 'Kamera aktif…' : 'Mulai kamera'}
        </button>
        <button type="button" className="button light" onClick={stop} disabled={!scanning && !opening}>
          Hentikan kamera
        </button>
        <button type="button" className="button light" onClick={() => validate(code)} disabled={validating || saving}>
          Validasi kode
        </button>
      </div>

      {result && (
        <section className="record-editor" aria-label="Konfirmasi absensi QR">
          <h3>Konfirmasi Absensi QR</h3>
          {student.photo && (
            <img className="confirmation-photo" src={student.photo} alt={`Foto ${student.name || ''}`} />
          )}
          <p><strong>{student.name || '—'}</strong></p>
          <p>NISN: {student.nisn || 'Belum diisi'}</p>
          <p>Kelas: {student.className || student.class || '—'}</p>
          {result.status ? (
            <p className="page-feedback is-error" role="alert">
              Siswa sudah tercatat ({STATUS_LABEL[result.status] || result.status}) pada sesi ini. Gunakan Absensi Manual untuk koreksi.
            </p>
          ) : (
            <p className="page-feedback" role="status">
              Periksa foto dan identitas siswa, lalu konfirmasi untuk menyimpan Hadir.
            </p>
          )}
          <div className="form-actions">
            <button
              type="button"
              className="button coral"
              onClick={confirmAttendance}
              disabled={saving || !!result.status}
            >
              Konfirmasi Hadir
            </button>
            <button type="button" className="button light" onClick={() => { setResult(null); setCode(''); }}>
              Batal
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
