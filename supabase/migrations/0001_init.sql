-- ============================================================================
-- SIA Absensi Sekolah — Migrasi 0001: skema inti (porting dari skema v2)
-- Sumber: database/schema.json (v2, 16 tabel) + docs/database.md + docs/stage-3.md
-- Repo sumber: qtiil069-gif/sia-absensi-sekolah (branch main, HANYA BACA)
-- Target: Supabase (PostgreSQL 15), skema public
--
-- PEMETAAN NAMA (Sheets -> Postgres, snake_case):
--   Pengaturan        -> pengaturan        (key tetap PK text)
--   Pengguna          -> profiles          (id = auth.users.id, lihat bawah)
--   TahunAjaran       -> tahun_ajaran      (PK id)
--   Semester          -> semester          (PK semester_id)
--   Kelas             -> kelas             (PK id)
--   Siswa             -> siswa             (PK id)
--   KeanggotaanKelas  -> keanggotaan_kelas (PK id)
--   Mapel             -> mapel             (PK id)
--   PenugasanGuru     -> penugasan_guru    (PK id)
--   SesiAbsensi       -> sesi_absensi      (PK id)
--   Absensi           -> absensi           (PK id)
--   Penilaian         -> penilaian         (PK assessment_id)
--   Nilai             -> nilai             (PK grade_id)
--   Jurnal            -> jurnal            (PK journal_id)
--   AuditLog          -> audit_log         (PK audit_id)
--   ProfilSiswa       -> profil_siswa      (siswa_id sebagai PK)
-- Konvensi: PK tabel operasional bernama `id` (uuid); kolom FK memakai
-- nama Indonesia tabel induk + _id (kelas_id, siswa_id, tahun_ajaran_id,
-- mapel_id, sesi_id). Pengecualian: tabel tahap 4 (semester, penilaian,
-- nilai, jurnal, audit_log) mempertahankan nama PK asli schema.json.
-- Kolom lain di-snake_case-kan (tanggal_mulai, wali_user_id, created_by).
--
-- KEPUTUSAN UMUM:
-- - PK uuid DEFAULT gen_random_uuid(), kecuali pengaturan (PK key text)
--   dan profil_siswa (PK siswa_id, relasi 1:1 ke siswa).
-- - created_at / updated_at timestamptz DEFAULT now(); updated_at
--   dijaga trigger set_updated_at() (lihat bawah).
-- - FK: ON DELETE RESTRICT sebagai default (lindungi riwayat: tahun ajaran,
--   kelas, siswa, mapel, semester tidak boleh terhapus selama masih dirujuk).
--   CASCADE hanya untuk baris anak yang hidup-matinya melekat pada induk:
--     * profil_siswa -> siswa (perpanjangan 1:1 dari siswa)
--     * absensi -> sesi_absensi (catatan milik sesi)
--     * nilai -> penilaian (nilai milik penilaian)
--   SET NULL untuk kolom pelacak aktor (created_by, recorded_by, updated_by,
--   teacher_user_id, actor_user_id): audit/jejak tetap ada walau akun
--   pembuatnya dihapus.
-- - NIS unik penuh (bukan hanya siswa aktif), sesuai aturan asli:
--   "NIS unik termasuk siswa nonaktif" (docs/database.md). Siswa nonaktif
--   tetap mengunci NIS-nya; pakai NIS baru bila perlu.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 0. Fungsi utilitas
-- ----------------------------------------------------------------------------

-- Menjaga updated_at otomatis pada UPDATE.
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- ----------------------------------------------------------------------------
-- 1. profiles — pemetaan tabel Pengguna ke Supabase Auth
--    Satu baris per akun auth.users; id = auth.users.id (bukan UUID bebas).
--    Dibuat OTOMATIS oleh trigger bila user dibuat via Dashboard/API
--    (lihat trigger di akhir file), atau manual lewat SQL (lihat seed.sql).
--    Role: ADMIN_KEPALA_SEKOLAH atau GURU (sesuai schema asli).
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.profiles (
  id         uuid PRIMARY KEY REFERENCES auth.users (id) ON DELETE CASCADE,
  email      text NOT NULL UNIQUE,
  nama       text NOT NULL,
  role       text NOT NULL DEFAULT 'GURU'
             CHECK (role IN ('ADMIN_KEPALA_SEKOLAH', 'GURU')),
  aktif      boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_profiles_email ON public.profiles (email);
CREATE INDEX IF NOT EXISTS idx_profiles_role  ON public.profiles (role);

-- Trigger: setiap user auth baru otomatis mendapat baris profiles GURU
-- nonaktif? Tidak — default role GURU + aktif = true, admin mengubah
-- role/aktif lewat SQL/Dashboard. Email diambil dari auth.users.
CREATE OR REPLACE FUNCTION public.handle_new_auth_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (id, email, nama, role, aktif)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data ->> 'nama', split_part(NEW.email, '@', 1)),
    COALESCE(NEW.raw_user_meta_data ->> 'role', 'GURU'),
    true
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_auth_user();

DROP TRIGGER IF EXISTS trg_profiles_updated_at ON public.profiles;
CREATE TRIGGER trg_profiles_updated_at
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ----------------------------------------------------------------------------
-- 2. pengaturan — key/value (school_name, semester_label, school_logo,
--    school_address, school_identity, dst.). PK key text, sesuai aslinya.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.pengaturan (
  key         text PRIMARY KEY,
  value       text,
  description text,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS trg_pengaturan_updated_at ON public.pengaturan;
CREATE TRIGGER trg_pengaturan_updated_at
  BEFORE UPDATE ON public.pengaturan
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ----------------------------------------------------------------------------
-- 3. tahun_ajaran
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.tahun_ajaran (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nama           text NOT NULL,                       -- mis. "2026/2027"
  tanggal_mulai  date NOT NULL,
  tanggal_selesai date NOT NULL,
  aktif          boolean NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (tanggal_selesai >= tanggal_mulai)
);
-- Hanya SATU tahun ajaran boleh aktif dalam satu waktu.
CREATE UNIQUE INDEX IF NOT EXISTS uq_tahun_ajaran_satu_aktif
  ON public.tahun_ajaran (aktif) WHERE aktif;
CREATE INDEX IF NOT EXISTS idx_tahun_ajaran_aktif ON public.tahun_ajaran (aktif);

DROP TRIGGER IF EXISTS trg_tahun_ajaran_updated_at ON public.tahun_ajaran;
CREATE TRIGGER trg_tahun_ajaran_updated_at
  BEFORE UPDATE ON public.tahun_ajaran
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ----------------------------------------------------------------------------
-- 4. semester
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.semester (
  semester_id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tahun_ajaran_id        uuid NOT NULL REFERENCES public.tahun_ajaran (id)
                   ON DELETE RESTRICT,
  nama           text NOT NULL,                       -- mis. "Ganjil", "Genap"
  tanggal_mulai  date NOT NULL,
  tanggal_selesai date NOT NULL,
  aktif          boolean NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (tanggal_selesai >= tanggal_mulai)
);
-- Hanya SATU semester aktif per tahun ajaran.
CREATE UNIQUE INDEX IF NOT EXISTS uq_semester_satu_aktif_per_tahun
  ON public.semester (tahun_ajaran_id) WHERE aktif;
CREATE INDEX IF NOT EXISTS idx_semester_year_id ON public.semester (tahun_ajaran_id);

DROP TRIGGER IF EXISTS trg_semester_updated_at ON public.semester;
CREATE TRIGGER trg_semester_updated_at
  BEFORE UPDATE ON public.semester
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ----------------------------------------------------------------------------
-- 5. mapel
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.mapel (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nama       text NOT NULL,
  aktif      boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mapel_nama ON public.mapel (nama);

DROP TRIGGER IF EXISTS trg_mapel_updated_at ON public.mapel;
CREATE TRIGGER trg_mapel_updated_at
  BEFORE UPDATE ON public.mapel
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ----------------------------------------------------------------------------
-- 6. kelas — satu rombel untuk satu tahun ajaran (nama unik per tahun).
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.kelas (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tahun_ajaran_id     uuid NOT NULL REFERENCES public.tahun_ajaran (id)
                ON DELETE RESTRICT,
  nama        text NOT NULL,                          -- mis. "1A"
  tingkat     integer NOT NULL CHECK (tingkat BETWEEN 1 AND 6),
  wali_user_id uuid REFERENCES public.profiles (id) ON DELETE RESTRICT,
  aktif       boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
-- Nama kelas unik per tahun (aturan asli, docs/database.md).
CREATE UNIQUE INDEX IF NOT EXISTS uq_kelas_nama_per_tahun
  ON public.kelas (tahun_ajaran_id, nama);
CREATE INDEX IF NOT EXISTS idx_kelas_year_id ON public.kelas (tahun_ajaran_id);
CREATE INDEX IF NOT EXISTS idx_kelas_wali    ON public.kelas (wali_user_id);

DROP TRIGGER IF EXISTS trg_kelas_updated_at ON public.kelas;
CREATE TRIGGER trg_kelas_updated_at
  BEFORE UPDATE ON public.kelas
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ----------------------------------------------------------------------------
-- 7. siswa — identitas stabil lintas tahun (NIS/NISN format teks agar
--    nol awal tidak hilang, sesuai aturan asli).
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.siswa (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nis        text NOT NULL UNIQUE,                    -- unik incl. nonaktif
  nisn       text,
  nama       text NOT NULL,
  aktif      boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_siswa_nis  ON public.siswa (nis);
CREATE INDEX IF NOT EXISTS idx_siswa_nama ON public.siswa (nama);
-- NISN unik bila diisi (satu siswa = satu NISN).
CREATE UNIQUE INDEX IF NOT EXISTS uq_siswa_nisn
  ON public.siswa (nisn) WHERE nisn IS NOT NULL AND nisn <> '';

DROP TRIGGER IF EXISTS trg_siswa_updated_at ON public.siswa;
CREATE TRIGGER trg_siswa_updated_at
  BEFORE UPDATE ON public.siswa
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ----------------------------------------------------------------------------
-- 8. keanggotaan_kelas — histori perpindahan tanpa mengganti siswa_id;
--    perpindahan = nonaktifkan keanggotaan lama, buat yang baru.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.keanggotaan_kelas (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  siswa_id    uuid NOT NULL REFERENCES public.siswa (id)
                  ON DELETE RESTRICT,
  kelas_id      uuid NOT NULL REFERENCES public.kelas (id)
                  ON DELETE RESTRICT,
  aktif         boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
-- Pasangan siswa-kelas AKTIF harus unik (aturan asli).
CREATE UNIQUE INDEX IF NOT EXISTS uq_keanggotaan_aktif
  ON public.keanggotaan_kelas (siswa_id, kelas_id) WHERE aktif;
CREATE INDEX IF NOT EXISTS idx_keanggotaan_student ON public.keanggotaan_kelas (siswa_id);
CREATE INDEX IF NOT EXISTS idx_keanggotaan_class   ON public.keanggotaan_kelas (kelas_id);

DROP TRIGGER IF EXISTS trg_keanggotaan_updated_at ON public.keanggotaan_kelas;
CREATE TRIGGER trg_keanggotaan_updated_at
  BEFORE UPDATE ON public.keanggotaan_kelas
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ----------------------------------------------------------------------------
-- 9. penugasan_guru — guru mengajar mapel di kelas (aktif).
--    mapel_id NULLABLE: memungkinkan penugasan kelas saja (mis. wali
--    kelas tanpa mapel tertentu); bila diisi harus merujuk mapel aktif.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.penugasan_guru (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES public.profiles (id)
                  ON DELETE RESTRICT,
  kelas_id      uuid NOT NULL REFERENCES public.kelas (id)
                  ON DELETE RESTRICT,
  mapel_id    uuid REFERENCES public.mapel (id)
                  ON DELETE RESTRICT,
  aktif         boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
-- Satu guru tidak boleh ditugaskan ganda (aktif) untuk kombinasi
-- kelas+mapel yang sama.
CREATE UNIQUE INDEX IF NOT EXISTS uq_penugasan_aktif
  ON public.penugasan_guru (user_id, kelas_id, COALESCE(mapel_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE aktif;
CREATE INDEX IF NOT EXISTS idx_penugasan_user  ON public.penugasan_guru (user_id);
CREATE INDEX IF NOT EXISTS idx_penugasan_class ON public.penugasan_guru (kelas_id);

DROP TRIGGER IF EXISTS trg_penugasan_updated_at ON public.penugasan_guru;
CREATE TRIGGER trg_penugasan_updated_at
  BEFORE UPDATE ON public.penugasan_guru
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ----------------------------------------------------------------------------
-- 10. sesi_absensi — jenis HARIAN atau MAPEL (sesuai rancangan asli).
--     Sesi harian unik per kelas-tanggal; sesi mapel unik per
--     kelas-tanggal-mapel. mapel_id NULL untuk HARIAN.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.sesi_absensi (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kelas_id   uuid NOT NULL REFERENCES public.kelas (id)
               ON DELETE RESTRICT,
  tanggal    date NOT NULL,
  jenis      text NOT NULL DEFAULT 'HARIAN'
             CHECK (jenis IN ('HARIAN', 'MAPEL')),
  mapel_id uuid REFERENCES public.mapel (id)
               ON DELETE RESTRICT,
  created_by uuid REFERENCES public.profiles (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- Unik per (kelas_id, tanggal, jenis, mapel_id) dengan NULL ditangani
-- lewat COALESCE (NULL tidak dianggap sama oleh UNIQUE biasa, jadi
-- dua sesi HARIAN yang sama tetap bisa lolos tanpa trik ini).
CREATE UNIQUE INDEX IF NOT EXISTS uq_sesi_absensi
  ON public.sesi_absensi (
    kelas_id, tanggal, jenis,
    COALESCE(mapel_id, '00000000-0000-0000-0000-000000000000'::uuid)
  );
CREATE INDEX IF NOT EXISTS idx_sesi_class   ON public.sesi_absensi (kelas_id);
CREATE INDEX IF NOT EXISTS idx_sesi_tanggal ON public.sesi_absensi (tanggal);
CREATE INDEX IF NOT EXISTS idx_sesi_class_tanggal ON public.sesi_absensi (kelas_id, tanggal);

-- ----------------------------------------------------------------------------
-- 11. absensi — status H/S/I/A, unik per (sesi_id, siswa_id).
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.absensi (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sesi_id    uuid NOT NULL REFERENCES public.sesi_absensi (id)
                  ON DELETE CASCADE,
  siswa_id    uuid NOT NULL REFERENCES public.siswa (id)
                  ON DELETE RESTRICT,
  status        text NOT NULL CHECK (status IN ('H', 'S', 'I', 'A')),
  catatan       text,
  recorded_by   uuid REFERENCES public.profiles (id) ON DELETE SET NULL,
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_absensi_sesi_siswa
  ON public.absensi (sesi_id, siswa_id);
CREATE INDEX IF NOT EXISTS idx_absensi_session ON public.absensi (sesi_id);
CREATE INDEX IF NOT EXISTS idx_absensi_student ON public.absensi (siswa_id);

DROP TRIGGER IF EXISTS trg_absensi_updated_at ON public.absensi;
CREATE TRIGGER trg_absensi_updated_at
  BEFORE UPDATE ON public.absensi
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ----------------------------------------------------------------------------
-- 12. penilaian — modul tahap 4 (belum ada UI). jenis: TUGAS/ULANGAN/UJIAN.
--     Aturan 0 <= nilai <= nilai_maks ditegakkan di aplikasi karena
--     CHECK lintas tabel tidak dimungkinkan; bobot & nilai_maks > 0.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.penilaian (
  assessment_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kelas_id      uuid NOT NULL REFERENCES public.kelas (id)
                  ON DELETE RESTRICT,
  mapel_id    uuid NOT NULL REFERENCES public.mapel (id)
                  ON DELETE RESTRICT,
  semester_id   uuid NOT NULL REFERENCES public.semester (semester_id)
                  ON DELETE RESTRICT,
  nama          text NOT NULL,
  jenis         text NOT NULL
                CHECK (jenis IN ('TUGAS', 'ULANGAN', 'UJIAN', 'LAINNYA')),
  bobot         numeric NOT NULL CHECK (bobot > 0),
  nilai_maks    numeric NOT NULL CHECK (nilai_maks > 0),
  created_by    uuid REFERENCES public.profiles (id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_penilaian_class    ON public.penilaian (kelas_id);
CREATE INDEX IF NOT EXISTS idx_penilaian_semester ON public.penilaian (semester_id);

DROP TRIGGER IF EXISTS trg_penilaian_updated_at ON public.penilaian;
CREATE TRIGGER trg_penilaian_updated_at
  BEFORE UPDATE ON public.penilaian
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ----------------------------------------------------------------------------
-- 13. nilai — satu nilai per (assessment_id, siswa_id).
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.nilai (
  grade_id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  assessment_id uuid NOT NULL REFERENCES public.penilaian (assessment_id)
                  ON DELETE CASCADE,
  siswa_id    uuid NOT NULL REFERENCES public.siswa (id)
                  ON DELETE RESTRICT,
  nilai         numeric NOT NULL CHECK (nilai >= 0),
  updated_by    uuid REFERENCES public.profiles (id) ON DELETE SET NULL,
  updated_at    timestamptz NOT NULL DEFAULT now()
  -- Batas atas nilai (<= penilaian.nilai_maks) ditegakkan di aplikasi.
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_nilai_penilaian_siswa
  ON public.nilai (assessment_id, siswa_id);
CREATE INDEX IF NOT EXISTS idx_nilai_assessment ON public.nilai (assessment_id);
CREATE INDEX IF NOT EXISTS idx_nilai_student    ON public.nilai (siswa_id);

DROP TRIGGER IF EXISTS trg_nilai_updated_at ON public.nilai;
CREATE TRIGGER trg_nilai_updated_at
  BEFORE UPDATE ON public.nilai
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ----------------------------------------------------------------------------
-- 14. jurnal — modul tahap 4 (belum ada UI).
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.jurnal (
  journal_id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kelas_id        uuid NOT NULL REFERENCES public.kelas (id)
                    ON DELETE RESTRICT,
  mapel_id      uuid REFERENCES public.mapel (id)
                    ON DELETE RESTRICT,
  tanggal         date NOT NULL,
  materi          text NOT NULL,
  catatan         text,
  teacher_user_id uuid REFERENCES public.profiles (id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_jurnal_class   ON public.jurnal (kelas_id);
CREATE INDEX IF NOT EXISTS idx_jurnal_tanggal ON public.jurnal (tanggal);
CREATE INDEX IF NOT EXISTS idx_jurnal_teacher ON public.jurnal (teacher_user_id);

DROP TRIGGER IF EXISTS trg_jurnal_updated_at ON public.jurnal;
CREATE TRIGGER trg_jurnal_updated_at
  BEFORE UPDATE ON public.jurnal
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ----------------------------------------------------------------------------
-- 15. audit_log — jejak mutasi (rencana audit perubahan, docs/database.md).
--     entity_id disimpan text karena merujuk berbagai tabel.
--     Ditulis aplikasi/service role; RLS: hanya admin yang membaca.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.audit_log (
  audit_id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id uuid REFERENCES public.profiles (id) ON DELETE SET NULL,
  action        text NOT NULL,                        -- mis. "INSERT","UPDATE"
  entity        text NOT NULL,                        -- nama tabel/entitas
  entity_id     text,
  timestamp     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_actor     ON public.audit_log (actor_user_id);
CREATE INDEX IF NOT EXISTS idx_audit_entity    ON public.audit_log (entity, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON public.audit_log (timestamp);

-- ----------------------------------------------------------------------------
-- 16. profil_siswa — data wali + foto + token QR (tahap 3).
--     PK siswa_id (1:1 dengan siswa). foto_data_url dipertahankan dari
--     schema asli (data URL kecil, legacy Sheets); foto_url adalah kolom
--     BARU untuk porting ini: path objek di bucket Storage 'siswa-foto'
--     (lihat 0002_storage.sql) dan menjadi cara penyimpanan yang utama.
--     Token QR stabil (UUID), payload "SIA-ID:1:<token>"; BUKAN autentikasi.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.profil_siswa (
  siswa_id       uuid PRIMARY KEY REFERENCES public.siswa (id)
                   ON DELETE CASCADE,
  wali_nama      text,
  wali_telepon   text
                 CHECK (wali_telepon IS NULL
                        OR wali_telepon ~ '^\+?[0-9]{8,18}$'),
  wali_hubungan  text,
  foto_data_url  text,                                -- legacy (Sheets)
  foto_url      text,                                -- Storage: {siswa_id}/{file}
  qr_token       text UNIQUE,
  updated_at     timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS trg_profil_siswa_updated_at ON public.profil_siswa;
CREATE TRIGGER trg_profil_siswa_updated_at
  BEFORE UPDATE ON public.profil_siswa
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Helper RLS (LANGUAGE sql, divalidasi saat dibuat) — HARUS setelah
-- semua tabel di atas, karena fungsinya membaca tabel-tabel itu.

-- Peran pengguna login, dibaca dari public.profiles.
-- SECURITY DEFINER agar RLS pada profiles tidak memblokir pembacaan ini
-- (dan agar policy tidak rekursif). Mengembalikan NULL bila belum login
-- atau belum ada baris profiles.
CREATE OR REPLACE FUNCTION public.app_role()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT role FROM public.profiles WHERE id = auth.uid();
$$;

-- TRUE bila pengguna login adalah Admin Kepala Sekolah.
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.app_role() = 'ADMIN_KEPALA_SEKOLAH';
$$;

-- TRUE bila kelas p_class_id berada dalam cakupan guru yang login:
-- dia wali kelasnya ATAU ditugaskan aktif di kelas itu (penugasan_guru).
-- SECURITY DEFINER: membaca kelas/penugasan_guru tanpa tunduk pada RLS,
-- sehingga policy yang memakainya tidak rekursif.
CREATE OR REPLACE FUNCTION public.is_my_class(p_class_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.kelas k
    WHERE k.id = p_class_id
      AND k.wali_user_id = auth.uid()
  )
  OR EXISTS (
    SELECT 1 FROM public.penugasan_guru pg
    WHERE pg.kelas_id = p_class_id
      AND pg.user_id = auth.uid()
      AND pg.aktif
  );
$$;

-- TRUE bila siswa p_student_id terdaftar aktif di salah satu kelas guru.
CREATE OR REPLACE FUNCTION public.is_my_student(p_student_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.keanggotaan_kelas kk
    WHERE kk.siswa_id = p_student_id
      AND kk.aktif
      AND public.is_my_class(kk.kelas_id)
  );
$$;

-- ============================================================================
-- ROW LEVEL SECURITY
-- Prinsip: RLS AKTIF di semua tabel. Admin (ADMIN_KEPALA_SEKOLAH) bisa
-- baca/tulis semua. Guru hanya dalam cakupannya: kelas yang dia walikan
-- (kelas.wali_user_id = auth.uid()) atau yang ditugaskan aktif lewat
-- penugasan_guru — dicek lewat helper public.is_my_class() /
-- public.is_my_student() (SECURITY DEFINER, anti-rekursi).
-- Guru TIDAK BOLEH mutasi master: kelas, siswa, pengaturan, tahun_ajaran,
-- semester, mapel, keanggotaan_kelas, penugasan_guru (hanya baca sesuai
-- cakupan). Guru BOLEH kelola sesi_absensi + absensi di kelasnya.
-- Penilaian / nilai / jurnal (modul tahap 4, belum ada UI): admin penuh,
-- guru hanya BACA kelasnya.
-- Tanpa login (anon) tidak ada policy -> tidak bisa apa-apa.
-- Catatan: service_role melewati RLS (untuk job server/admin backend).
-- ============================================================================

ALTER TABLE public.profiles         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pengaturan       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tahun_ajaran     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.semester         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mapel            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.kelas            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.siswa            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.keanggotaan_kelas ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.penugasan_guru   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sesi_absensi     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.absensi          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.penilaian        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.nilai            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.jurnal           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_log        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profil_siswa     ENABLE ROW LEVEL SECURITY;

-- --- profiles ---------------------------------------------------------------
-- Admin: penuh. Setiap user: baca barisnya sendiri (agar UI tahu role/nama).
CREATE POLICY profiles_admin_all ON public.profiles
  FOR ALL TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());
CREATE POLICY profiles_select_own ON public.profiles
  FOR SELECT TO authenticated USING (id = auth.uid());

-- --- pengaturan -------------------------------------------------------------
-- Admin: penuh. Semua login: baca (UI butuh school_name/semester_label).
CREATE POLICY pengaturan_admin_all ON public.pengaturan
  FOR ALL TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());
CREATE POLICY pengaturan_select_auth ON public.pengaturan
  FOR SELECT TO authenticated USING (true);

-- --- tahun_ajaran / semester / mapel (master referensi, baca semua login) ---
CREATE POLICY tahun_ajaran_admin_all ON public.tahun_ajaran
  FOR ALL TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());
CREATE POLICY tahun_ajaran_select_auth ON public.tahun_ajaran
  FOR SELECT TO authenticated USING (true);

CREATE POLICY semester_admin_all ON public.semester
  FOR ALL TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());
CREATE POLICY semester_select_auth ON public.semester
  FOR SELECT TO authenticated USING (true);

CREATE POLICY mapel_admin_all ON public.mapel
  FOR ALL TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());
CREATE POLICY mapel_select_auth ON public.mapel
  FOR SELECT TO authenticated USING (true);

-- --- kelas ------------------------------------------------------------------
-- Admin: penuh. Guru: baca hanya kelas dalam cakupannya.
CREATE POLICY kelas_admin_all ON public.kelas
  FOR ALL TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());
CREATE POLICY kelas_select_guru ON public.kelas
  FOR SELECT TO authenticated USING (public.is_my_class(id));

-- --- siswa ------------------------------------------------------------------
-- Admin: penuh. Guru: baca hanya siswa yang terdaftar aktif di kelasnya.
CREATE POLICY siswa_admin_all ON public.siswa
  FOR ALL TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());
CREATE POLICY siswa_select_guru ON public.siswa
  FOR SELECT TO authenticated USING (public.is_my_student(id));

-- --- keanggotaan_kelas ------------------------------------------------------
-- Admin: penuh. Guru: baca hanya keanggotaan di kelasnya.
CREATE POLICY keanggotaan_admin_all ON public.keanggotaan_kelas
  FOR ALL TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());
CREATE POLICY keanggotaan_select_guru ON public.keanggotaan_kelas
  FOR SELECT TO authenticated USING (public.is_my_class(kelas_id));

-- --- penugasan_guru ---------------------------------------------------------
-- Admin: penuh. Guru: baca hanya penugasannya sendiri.
CREATE POLICY penugasan_admin_all ON public.penugasan_guru
  FOR ALL TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());
CREATE POLICY penugasan_select_own ON public.penugasan_guru
  FOR SELECT TO authenticated USING (user_id = auth.uid());

-- --- sesi_absensi -----------------------------------------------------------
-- Admin: penuh. Guru: baca + kelola (buat/ubah/hapus) sesi di kelasnya.
CREATE POLICY sesi_admin_all ON public.sesi_absensi
  FOR ALL TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());
CREATE POLICY sesi_select_guru ON public.sesi_absensi
  FOR SELECT TO authenticated USING (public.is_my_class(kelas_id));
CREATE POLICY sesi_insert_guru ON public.sesi_absensi
  FOR INSERT TO authenticated WITH CHECK (public.is_my_class(kelas_id));
CREATE POLICY sesi_update_guru ON public.sesi_absensi
  FOR UPDATE TO authenticated USING (public.is_my_class(kelas_id))
  WITH CHECK (public.is_my_class(kelas_id));
CREATE POLICY sesi_delete_guru ON public.sesi_absensi
  FOR DELETE TO authenticated USING (public.is_my_class(kelas_id));

-- --- absensi ----------------------------------------------------------------
-- Admin: penuh. Guru: baca + kelola catatan untuk sesi di kelasnya.
CREATE POLICY absensi_admin_all ON public.absensi
  FOR ALL TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());
CREATE POLICY absensi_select_guru ON public.absensi
  FOR SELECT TO authenticated USING (
    EXISTS (SELECT 1 FROM public.sesi_absensi s
            WHERE s.id = absensi.sesi_id
              AND public.is_my_class(s.kelas_id))
  );
CREATE POLICY absensi_insert_guru ON public.absensi
  FOR INSERT TO authenticated WITH CHECK (
    EXISTS (SELECT 1 FROM public.sesi_absensi s
            WHERE s.id = absensi.sesi_id
              AND public.is_my_class(s.kelas_id))
  );
CREATE POLICY absensi_update_guru ON public.absensi
  FOR UPDATE TO authenticated USING (
    EXISTS (SELECT 1 FROM public.sesi_absensi s
            WHERE s.id = absensi.sesi_id
              AND public.is_my_class(s.kelas_id))
  ) WITH CHECK (
    EXISTS (SELECT 1 FROM public.sesi_absensi s
            WHERE s.id = absensi.sesi_id
              AND public.is_my_class(s.kelas_id))
  );
CREATE POLICY absensi_delete_guru ON public.absensi
  FOR DELETE TO authenticated USING (
    EXISTS (SELECT 1 FROM public.sesi_absensi s
            WHERE s.id = absensi.sesi_id
              AND public.is_my_class(s.kelas_id))
  );

-- --- penilaian / nilai / jurnal (tahap 4, belum ada UI) --------------------
-- Admin: penuh. Guru: hanya BACA di kelasnya (tulis dikunci sampai UI ada).
CREATE POLICY penilaian_admin_all ON public.penilaian
  FOR ALL TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());
CREATE POLICY penilaian_select_guru ON public.penilaian
  FOR SELECT TO authenticated USING (public.is_my_class(kelas_id));

CREATE POLICY nilai_admin_all ON public.nilai
  FOR ALL TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());
CREATE POLICY nilai_select_guru ON public.nilai
  FOR SELECT TO authenticated USING (
    EXISTS (SELECT 1 FROM public.penilaian p
            WHERE p.assessment_id = nilai.assessment_id
              AND public.is_my_class(p.kelas_id))
  );

CREATE POLICY jurnal_admin_all ON public.jurnal
  FOR ALL TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());
CREATE POLICY jurnal_select_guru ON public.jurnal
  FOR SELECT TO authenticated USING (public.is_my_class(kelas_id));

-- --- audit_log --------------------------------------------------------------
-- Hanya admin yang membaca; penulisan oleh admin/aplikasi (service_role
-- melewati RLS). Guru tidak mendapat akses sama sekali.
CREATE POLICY audit_admin_select ON public.audit_log
  FOR SELECT TO authenticated USING (public.is_admin());
CREATE POLICY audit_admin_insert ON public.audit_log
  FOR INSERT TO authenticated WITH CHECK (public.is_admin());

-- --- profil_siswa -----------------------------------------------------------
-- Admin: penuh. Guru: baca hanya profil siswa di kelasnya (data wali
-- adalah data pribadi; tidak ada tulis untuk guru).
CREATE POLICY profil_siswa_admin_all ON public.profil_siswa
  FOR ALL TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());
CREATE POLICY profil_siswa_select_guru ON public.profil_siswa
  FOR SELECT TO authenticated USING (public.is_my_student(siswa_id));

-- ============================================================================
-- Akhir 0001_init.sql — 16 tabel + helper + trigger + RLS.
-- Lanjut: 0002_storage.sql (bucket foto siswa), lalu supabase/seed.sql.
-- ============================================================================
