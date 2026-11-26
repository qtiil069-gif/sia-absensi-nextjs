-- ============================================================================
-- SIA Absensi Sekolah — Migrasi 0002: Storage foto siswa
-- Prasyarat: 0001_init.sql (tabel profil_siswa + helper public.app_role()).
--
-- Bucket 'siswa-foto':
--   - public read  : siapa pun bisa membaca foto lewat URL publik
--                    (dibutuhkan kartu ID siswa / tampilan foto).
--   - authenticated write : hanya ADMIN yang boleh upload/update/hapus.
--   - Jalur file: {siswa_id}/{nama-file}
--     contoh: 50000000-0000-4000-8000-000000000001/foto.jpg
--     URL publik foto (dibuat frontend lewat getPublicUrl dari path di
--     atas) disimpan di kolom profil_siswa.foto_url.
--   - Batas aplikasi (ditegakkan di UI, bukan di Storage): JPEG/PNG/WebP,
--     maks 5 MB, diraster ulang/diperkecil sebelum upload (sesuai stage-3).
--   - Foto TIDAK disimpan sebagai data URL di Sheets lagi; kolom legacy
--     profil_siswa.foto_data_url dipertahankan hanya untuk data lama.
--
-- Catatan: policy storage.objects memakai helper public.app_role()
-- (SECURITY DEFINER) dari 0001. service_role melewati RLS Storage.
-- ============================================================================

-- Buat bucket (idempotent: bila sudah ada, pastikan tetap public).
INSERT INTO storage.buckets (id, name, public)
VALUES ('siswa-foto', 'siswa-foto', true)
ON CONFLICT (id) DO UPDATE SET public = true;

-- --- Baca: publik (anon + authenticated) boleh membaca foto siswa. ---------
DROP POLICY IF EXISTS "Foto siswa bisa dibaca publik" ON storage.objects;
CREATE POLICY "Foto siswa bisa dibaca publik"
  ON storage.objects FOR SELECT
  TO public
  USING (bucket_id = 'siswa-foto');

-- --- Upload: hanya Admin yang login. ---------------------------------------
DROP POLICY IF EXISTS "Admin bisa upload foto siswa" ON storage.objects;
CREATE POLICY "Admin bisa upload foto siswa"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'siswa-foto'
    AND public.app_role() = 'ADMIN_KEPALA_SEKOLAH'
  );

-- --- Update (ganti foto): hanya Admin. --------------------------------------
DROP POLICY IF EXISTS "Admin bisa update foto siswa" ON storage.objects;
CREATE POLICY "Admin bisa update foto siswa"
  ON storage.objects FOR UPDATE
  TO authenticated
  USING (
    bucket_id = 'siswa-foto'
    AND public.app_role() = 'ADMIN_KEPALA_SEKOLAH'
  )
  WITH CHECK (
    bucket_id = 'siswa-foto'
    AND public.app_role() = 'ADMIN_KEPALA_SEKOLAH'
  );

-- --- Hapus: hanya Admin. ----------------------------------------------------
DROP POLICY IF EXISTS "Admin bisa hapus foto siswa" ON storage.objects;
CREATE POLICY "Admin bisa hapus foto siswa"
  ON storage.objects FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'siswa-foto'
    AND public.app_role() = 'ADMIN_KEPALA_SEKOLAH'
  );

-- ============================================================================
-- Akhir 0002_storage.sql
-- ============================================================================
