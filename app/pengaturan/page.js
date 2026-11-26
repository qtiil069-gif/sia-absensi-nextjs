// Pengaturan Sekolah (porting pages/settings.js asli, tanpa migrasi GAS).
// Identitas/logo/alamat hanya untuk Admin Kepala Sekolah.
// Migrasi tahap 3 adalah konsep GAS; di porting ini migrasi = SQL di
// supabase/migrations/, sehingga tidak ada tombol migrasi di halaman ini.
'use client';

import { useEffect, useState } from 'react';
import api from '@/lib/api';
import { useProfile } from '@/lib/useProfile';
import { useToast } from '@/components/Toast';

const MAX_LOGO_BYTES = 5 * 1024 * 1024;

export default function PengaturanPage() {
  const toast = useToast();
  const { isAdmin, loading: profileLoading } = useProfile();
  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const [identity, setIdentity] = useState('');
  const [logo, setLogo] = useState('');
  const [revision, setRevision] = useState(undefined);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [isError, setIsError] = useState(false);

  useEffect(() => {
    api.getSchoolSettings()
      .then((settings) => {
        setName(settings?.name || '');
        setAddress(settings?.address || '');
        setIdentity(settings?.identity || '');
        setLogo(settings?.logo || '');
        setRevision(settings?.revision);
      })
      .catch((err) => {
        setMessage(err?.message || 'Pengaturan sekolah belum dapat dimuat.');
        setIsError(true);
      })
      .finally(() => setLoading(false));
  }, []);

  function handleLogoChange(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > MAX_LOGO_BYTES) {
      setMessage('Ukuran logo maksimal 5 MB.');
      setIsError(true);
      return;
    }
    // Logo disimpan sebagai data URL PNG agar transparansi terjaga
    // (sama seperti versi asli); unggah ulang PNG transparan bila logo
    // lama masih JPEG.
    const reader = new FileReader();
    reader.onload = () => setLogo(String(reader.result || ''));
    reader.onerror = () => {
      setMessage('Logo tidak dapat dibaca.');
      setIsError(true);
    };
    reader.readAsDataURL(file);
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (saving || !isAdmin) return;
    setSaving(true);
    setMessage('');
    setIsError(false);
    try {
      const result = await api.updateSchoolSettings({
        name: name.trim(),
        address: address.trim(),
        identity: identity.trim(),
        logo,
        expectedRevision: revision,
      });
      setRevision(result?.revision ?? revision);
      setMessage('Pengaturan sekolah disimpan. Preview dan cetak kartu berikutnya memakai identitas terbaru.');
      toast.success('Pengaturan sekolah berhasil diperbarui.');
    } catch (err) {
      setMessage(err?.message || 'Gagal menyimpan pengaturan sekolah.');
      setIsError(true);
      toast.error(err?.message || 'Gagal menyimpan pengaturan sekolah.');
    } finally {
      setSaving(false);
    }
  }

  if (!profileLoading && !isAdmin) {
    return (
      <>
        <header className="topbar">
          <div className="page-heading">
            <div>
              <p className="eyebrow">RUANG SEKOLAH</p>
              <h1>Pengaturan Sekolah</h1>
            </div>
          </div>
        </header>
        <section className="module-panel">
          <p className="page-feedback is-error" role="alert">
            Pengaturan Sekolah hanya dapat diubah oleh Admin Kepala Sekolah.
          </p>
        </section>
      </>
    );
  }

  return (
    <>
      <header className="topbar">
        <div className="page-heading">
          <div>
            <p className="eyebrow">RUANG SEKOLAH</p>
            <h1>Pengaturan Sekolah</h1>
          </div>
        </div>
      </header>
      <section className="module-panel" aria-label="Pengaturan sekolah">
        <p className="eyebrow">RUANG SEKOLAH</p>
        <h2>Pengaturan Sekolah</h2>
        <p>Identitas sekolah dipakai di dashboard, kartu ID, dan ekspor data.</p>
        {loading && <p className="notice">Memuat pengaturan sekolah…</p>}
        {message && (
          <p className={`page-feedback${isError ? ' is-error' : ''}`} role={isError ? 'alert' : 'status'}>{message}</p>
        )}
        <form className="record-form settings-form" onSubmit={handleSubmit}>
          <label className="form-field">
            <span>Nama sekolah</span>
            <input value={name} maxLength={120} required onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="form-field">
            <span>Identitas tambahan sekolah</span>
            <input value={identity} maxLength={200} onChange={(e) => setIdentity(e.target.value)} />
          </label>
          <label className="form-field">
            <span>Alamat sekolah</span>
            <textarea value={address} maxLength={500} onChange={(e) => setAddress(e.target.value)} />
          </label>
          <div className="form-field image-field">
            <span>Logo sekolah</span>
            {logo && <img src={logo} alt="Logo sekolah saat ini" />}
            <input type="file" accept="image/png,image/jpeg,image/webp" onChange={handleLogoChange} />
            <span>
              PNG transparan disarankan agar logo tampil bersih di kartu ID. JPEG lama tidak dapat dikembalikan
              transparansinya; unggah ulang berkas PNG aslinya bila perlu.
            </span>
          </div>
          <div className="form-actions">
            <button type="submit" className="button coral" disabled={saving || loading}>
              Simpan pengaturan sekolah
            </button>
          </div>
        </form>
      </section>
    </>
  );
}
