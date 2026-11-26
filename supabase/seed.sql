-- ============================================================================
-- SIA Absensi Sekolah — seed.sql (data contoh SINTETIS)
-- SEMUA nama siswa/guru/wali di bawah ini FIKTIF (bukan data asli).
-- Nama sekolah "SD Muhammadiyah 4 Kerek" dipakai sebagai nama contoh karena
-- itu identitas proyek ini (lihat konteks proyek); bukan data pribadi.
--
-- PENTING — user auth TIDAK dibuat oleh seed ini:
--   1. Buat 2 user demo lewat Supabase Dashboard -> Authentication -> Users
--      (atau lewat Supabase Auth API): satu admin, satu guru.
--   2. Trigger on_auth_user_created (0001) otomatis membuat baris profiles
--      (role default GURU). Ubah role admin lewat SQL berikut, ganti
--      <auth-user-id-...> dengan UUID user dari Dashboard:
--
--      -- Jadikan user pertama sebagai Admin Kepala Sekolah:
--      UPDATE public.profiles
--         SET nama = 'Admin Contoh', role = 'ADMIN_KEPALA_SEKOLAH'
--       WHERE id = '<auth-user-id-admin>';
--
--      -- Lengkapi profil guru (nama + pastikan role GURU):
--      UPDATE public.profiles
--         SET nama = 'Guru Contoh', role = 'GURU'
--       WHERE id = '<auth-user-id-guru>';
--
--      -- Tetapkan guru sebagai wali kelas 1A dan penugasannya:
--      UPDATE public.kelas
--         SET wali_user_id = '<auth-user-id-guru>'
--       WHERE id = '40000000-0000-4000-8000-000000000001';
--
--      INSERT INTO public.penugasan_guru (user_id, kelas_id, mapel_id, aktif)
--      VALUES ('<auth-user-id-guru>',
--              '40000000-0000-4000-8000-000000000001',
--              '30000000-0000-4000-8000-000000000001', true)
--      ON CONFLICT DO NOTHING;
--
--   3. Tanpa langkah di atas, seed tetap jalan: wali_user_id kelas dibiarkan
--      NULL dan tidak ada baris penugasan_guru (sesi/absensi memakai
--      created_by/recorded_by NULL).
--
-- IDEMPOTEN: semua UUID dibuat tetap (deterministik) dan setiap INSERT
-- memakai ON CONFLICT DO NOTHING, jadi seed aman dijalankan berulang kali.
-- Jalankan SETELAH 0001_init.sql (dan 0002_storage.sql bila perlu foto).
-- ============================================================================

-- --- Pengaturan --------------------------------------------------------------
INSERT INTO public.pengaturan (key, value, description) VALUES
  ('school_name',    'SD Muhammadiyah 4 Kerek', 'Nama sekolah'),
  ('semester_label', 'Ganjil 2026/2027',        'Label semester aktif'),
  ('school_address', 'Kerek, Tuban, Jawa Timur', 'Alamat sekolah'),
  ('school_identity','Sekolah Dasar Islam',      'Identitas tambahan sekolah')
ON CONFLICT (key) DO NOTHING;

-- --- Tahun ajaran aktif 2026/2027 -------------------------------------------
INSERT INTO public.tahun_ajaran (id, nama, tanggal_mulai, tanggal_selesai, aktif)
VALUES ('10000000-0000-4000-8000-000000000001', '2026/2027', '2026-07-14', '2027-06-30', true)
ON CONFLICT (id) DO NOTHING;

-- --- Semester Ganjil (aktif) -------------------------------------------------
INSERT INTO public.semester (semester_id, tahun_ajaran_id, nama, tanggal_mulai, tanggal_selesai, aktif)
VALUES ('20000000-0000-4000-8000-000000000001',
        '10000000-0000-4000-8000-000000000001',
        'Ganjil', '2026-07-14', '2026-12-19', true)
ON CONFLICT (semester_id) DO NOTHING;

-- --- Mapel contoh ------------------------------------------------------------
INSERT INTO public.mapel (id, nama, aktif)
VALUES ('30000000-0000-4000-8000-000000000001', 'Matematika', true)
ON CONFLICT (id) DO NOTHING;

-- --- Kelas 1A dan 2B (wali_user_id NULL sampai user demo dibuat, lihat atas) --
INSERT INTO public.kelas (id, tahun_ajaran_id, nama, tingkat, wali_user_id, aktif)
VALUES
  ('40000000-0000-4000-8000-000000000001',
   '10000000-0000-4000-8000-000000000001', '1A', 1, NULL, true),
  ('40000000-0000-4000-8000-000000000002',
   '10000000-0000-4000-8000-000000000001', '2B', 2, NULL, true)
ON CONFLICT (id) DO NOTHING;

-- --- Siswa fiktif (5 per kelas), NIS unik ------------------------------------
INSERT INTO public.siswa (id, nis, nisn, nama, aktif) VALUES
  ('50000000-0000-4000-8000-000000000001', '2026001', '0101234561', 'Ahmad Fauzi Ramadhan', true),
  ('50000000-0000-4000-8000-000000000002', '2026002', '0101234562', 'Dewi Lestari Putri',   true),
  ('50000000-0000-4000-8000-000000000003', '2026003', '0101234563', 'Raka Pradana Wijaya',  true),
  ('50000000-0000-4000-8000-000000000004', '2026004', '0101234564', 'Nadia Safitri',        true),
  ('50000000-0000-4000-8000-000000000005', '2026005', '0101234565', 'Fajar Nugroho',        true),
  ('50000000-0000-4000-8000-000000000006', '2026006', '0101234566', 'Aisyah Rahmawati',     true),
  ('50000000-0000-4000-8000-000000000007', '2026007', '0101234567', 'Dimas Angga Saputra',  true),
  ('50000000-0000-4000-8000-000000000008', '2026008', '0101234568', 'Putri Ayu Lestari',    true),
  ('50000000-0000-4000-8000-000000000009', '2026009', '0101234569', 'Yusuf Maulana',        true),
  ('50000000-0000-4000-8000-000000000010', '2026010', '0101234570', 'Kirana Dewi Anggraini', true)
ON CONFLICT (id) DO NOTHING;

-- --- Keanggotaan kelas --------------------------------------------------------
INSERT INTO public.keanggotaan_kelas (id, siswa_id, kelas_id, aktif) VALUES
  ('60000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000001', true),
  ('60000000-0000-4000-8000-000000000002', '50000000-0000-4000-8000-000000000002', '40000000-0000-4000-8000-000000000001', true),
  ('60000000-0000-4000-8000-000000000003', '50000000-0000-4000-8000-000000000003', '40000000-0000-4000-8000-000000000001', true),
  ('60000000-0000-4000-8000-000000000004', '50000000-0000-4000-8000-000000000004', '40000000-0000-4000-8000-000000000001', true),
  ('60000000-0000-4000-8000-000000000005', '50000000-0000-4000-8000-000000000005', '40000000-0000-4000-8000-000000000001', true),
  ('60000000-0000-4000-8000-000000000006', '50000000-0000-4000-8000-000000000006', '40000000-0000-4000-8000-000000000002', true),
  ('60000000-0000-4000-8000-000000000007', '50000000-0000-4000-8000-000000000007', '40000000-0000-4000-8000-000000000002', true),
  ('60000000-0000-4000-8000-000000000008', '50000000-0000-4000-8000-000000000008', '40000000-0000-4000-8000-000000000002', true),
  ('60000000-0000-4000-8000-000000000009', '50000000-0000-4000-8000-000000000009', '40000000-0000-4000-8000-000000000002', true),
  ('60000000-0000-4000-8000-000000000010', '50000000-0000-4000-8000-000000000010', '40000000-0000-4000-8000-000000000002', true)
ON CONFLICT (id) DO NOTHING;

-- --- Profil siswa fiktif (wali + token QR stabil) -----------------------------
-- qr_token: UUID stabil per siswa; payload QR = "SIA-ID:1:<token>".
-- foto_url NULL (foto diunggah Admin ke bucket 'siswa-foto' bila perlu).
INSERT INTO public.profil_siswa (siswa_id, wali_nama, wali_telepon, wali_hubungan, foto_data_url, foto_url, qr_token) VALUES
  ('50000000-0000-4000-8000-000000000001', 'Bapak Fauzi',  '081234567001', 'Ayah', NULL, NULL, '90000000-0000-4000-8000-000000000001'),
  ('50000000-0000-4000-8000-000000000002', 'Ibu Lestari',  '081234567002', 'Ibu',  NULL, NULL, '90000000-0000-4000-8000-000000000002'),
  ('50000000-0000-4000-8000-000000000003', 'Bapak Wijaya', '081234567003', 'Ayah', NULL, NULL, '90000000-0000-4000-8000-000000000003'),
  ('50000000-0000-4000-8000-000000000004', 'Ibu Safitri',  '081234567004', 'Ibu',  NULL, NULL, '90000000-0000-4000-8000-000000000004'),
  ('50000000-0000-4000-8000-000000000005', 'Bapak Nugroho','081234567005', 'Ayah', NULL, NULL, '90000000-0000-4000-8000-000000000005'),
  ('50000000-0000-4000-8000-000000000006', 'Ibu Rahma',    '081234567006', 'Ibu',  NULL, NULL, '90000000-0000-4000-8000-000000000006'),
  ('50000000-0000-4000-8000-000000000007', 'Bapak Saputra','081234567007', 'Ayah', NULL, NULL, '90000000-0000-4000-8000-000000000007'),
  ('50000000-0000-4000-8000-000000000008', 'Ibu Ayu',      '081234567008', 'Ibu',  NULL, NULL, '90000000-0000-4000-8000-000000000008'),
  ('50000000-0000-4000-8000-000000000009', 'Bapak Maulana','081234567009', 'Ayah', NULL, NULL, '90000000-0000-4000-8000-000000000009'),
  ('50000000-0000-4000-8000-000000000010', 'Ibu Kirana',   '081234567010', 'Ibu',  NULL, NULL, '90000000-0000-4000-8000-000000000010')
ON CONFLICT (siswa_id) DO NOTHING;

-- --- Sesi absensi harian kelas 1A dan 2B, 25 Nov 2026 ------------------------
-- Dua sesi (satu per kelas) karena satu sesi hanya berisi siswa kelasnya.
INSERT INTO public.sesi_absensi (id, kelas_id, tanggal, jenis, mapel_id, created_by)
VALUES
  ('70000000-0000-4000-8000-000000000001',
   '40000000-0000-4000-8000-000000000001',
   '2026-11-25', 'HARIAN', NULL, NULL),
  ('70000000-0000-4000-8000-000000000002',
   '40000000-0000-4000-8000-000000000002',
   '2026-11-25', 'HARIAN', NULL, NULL)
ON CONFLICT (id) DO NOTHING;

-- --- Absensi: campuran H/S/I/A ----------------------------------------------
-- Kelas 1A: 4 H, 1 S. Kelas 2B: 3 H, 1 I, 1 A. Total 7 H, 1 S, 1 I, 1 A.
INSERT INTO public.absensi (id, sesi_id, siswa_id, status, catatan, recorded_by) VALUES
  ('80000000-0000-4000-8000-000000000001', '70000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000001', 'H', NULL,            NULL),
  ('80000000-0000-4000-8000-000000000002', '70000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000002', 'H', NULL,            NULL),
  ('80000000-0000-4000-8000-000000000003', '70000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000003', 'H', NULL,            NULL),
  ('80000000-0000-4000-8000-000000000004', '70000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000004', 'S', 'Demam',         NULL),
  ('80000000-0000-4000-8000-000000000005', '70000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000005', 'H', NULL,            NULL),
  ('80000000-0000-4000-8000-000000000006', '70000000-0000-4000-8000-000000000002', '50000000-0000-4000-8000-000000000006', 'H', NULL,            NULL),
  ('80000000-0000-4000-8000-000000000007', '70000000-0000-4000-8000-000000000002', '50000000-0000-4000-8000-000000000007', 'I', 'Izin keluarga', NULL),
  ('80000000-0000-4000-8000-000000000008', '70000000-0000-4000-8000-000000000002', '50000000-0000-4000-8000-000000000008', 'H', NULL,            NULL),
  ('80000000-0000-4000-8000-000000000009', '70000000-0000-4000-8000-000000000002', '50000000-0000-4000-8000-000000000009', 'A', NULL,            NULL),
  ('80000000-0000-4000-8000-000000000010', '70000000-0000-4000-8000-000000000002', '50000000-0000-4000-8000-000000000010', 'H', NULL,            NULL)
ON CONFLICT (id) DO NOTHING;

-- ============================================================================
-- Akhir seed.sql — ringkasan isi:
--   1 tahun ajaran aktif (2026/2027) + 1 semester aktif (Ganjil)
--   2 kelas (1A, 2B) + 1 mapel (Matematika)
--   10 siswa fiktif + 10 keanggotaan + 10 profil siswa (wali + token QR)
--   1 sesi harian per kelas (1A + 2B, 2026-11-25) + 10 baris absensi (7 H, 1 S, 1 I, 1 A)
--   4 baris pengaturan
-- Belum ada: user auth/profiles, wali kelas, penugasan_guru, penilaian,
-- nilai, jurnal, audit_log — dibuat manual / menyusul modul tahap 4.
-- ============================================================================
