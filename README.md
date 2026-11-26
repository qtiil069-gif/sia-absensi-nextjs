# SIA Absensi Sekolah — Next.js 14 + Supabase

Porting aplikasi **SIA Absensi Sekolah tahap 3** dari Google Apps Script +
Google Sheets menjadi aplikasi web **Next.js 14 (App Router) + Supabase**.

Repo sumber (hanya dibaca, tidak diubah): `qtiil069-gif/sia-absensi-sekolah`
(branch `main`). Bahasa UI: Indonesia. Desain dipertahankan: sidebar hijau
pastel, banner peach, kartu statistik pastel.

## Fitur yang ter-porting

- **Dashboard** — statistik (siswa/kelas aktif, hadir hari ini, ringkasan
  H/S/I/A), grafik batang 7 hari + donat komposisi (CSS, tanpa lib chart).
- **Data Kelas** — daftar, cari/filter, tambah, edit, nonaktifkan. Mutasi
  hanya Admin Kepala Sekolah; Guru hanya melihat kelas wali/penugasan aktif.
- **Data Siswa** — daftar + cari nama/NIS + filter kelas/status + pagination
  server, tambah/edit/nonaktif/pindah kelas, NIS unik (termasuk nonaktif),
  upload foto ke Storage, pratinjau Kartu ID.
- **Absensi Siswa** — tanggal/kelas/sesi harian atau mapel, roster aktif,
  H/S/I/A + catatan, cegah duplikat (sesi unik + `expectedRevision`,
  409 bila konflik), simpan/edit, ringkasan.
- **Scan QR** — kamera via `@zxing/browser` (+ input kode manual), validasi
  backend, popup identitas sebelum Konfirmasi Hadir, cegah duplikat.
- **Kartu ID** — preview portrait 54 × 85,6 mm, unduh PDF (pdf-lib),
  ekspor Excel (ExcelJS), cetak browser.
- **Pengaturan Sekolah** — identitas/logo/alamat (hanya Admin).
- **Auth + peran** — Supabase Auth; peran `ADMIN_KEPALA_SEKOLAH` dan `GURU`
  ditegakkan di server (Route Handler) dan RLS Postgres, bukan hanya di UI.
- **Audit** — mutasi penting dicatat ke `audit_log` (kegagalan audit tidak
  menggagalkan operasi utama).

## Yang BELUM ter-porting / belum ada

- Modul tahap 4 asli (**Nilai & Leger, Jurnal Mengajar, Akun Guru, Laporan
  Kehadiran**) — di aplikasi asli pun masih placeholder "Fitur dalam
  pengembangan". Tabelnya sudah dibuat di migrasi + RLS dasar, tapi belum
  ada UI dan API-nya.
- Migrasi database Tahap 3 dari UI dan diagnostik HtmlService (`?diagnostic=
  render`) — konsep khusus GAS, tidak berlaku di sini; migrasi dilakukan
  lewat SQL di `supabase/migrations/`.
- Demo lokal dengan data sintetis dalam memori (seperti `npm run dev` versi
  GAS) — diganti `seed.sql` (lihat bawah).

## Menjalankan lokal

```sh
npm install
cp .env.example .env.local   # lalu isi kredensial Supabase (lihat bawah)
npm run dev                  # http://localhost:3000
npm run build                # build produksi (harus hijau sebelum deploy)
npm start                    # jalankan hasil build
```

Node.js 18.17+ (proyek ini dibangun dengan Node 24). Tanpa `.env.local`
yang valid, halaman login tetap tampil, tapi semua Route Handler `/api/*`
mengembalikan `UNAUTHENTICATED` / galat layanan karena tidak bisa
terhubung ke Supabase.

## Menyiapkan Supabase (butuh akun Lei)

1. Buat proyek baru di [Supabase](https://supabase.com/dashboard)
   (free tier cukup).
2. Jalankan migrasi lewat **SQL Editor** di Dashboard (urut):
   - `supabase/migrations/0001_init.sql` — 16 tabel + helper + trigger + RLS
   - `supabase/migrations/0002_storage.sql` — bucket `siswa-foto` + policy
   - `supabase/seed.sql` — data contoh sintetis (opsional, bisa dijalankan
     ulang dengan aman; lihat catatan di dalam file)
   
   Alternatif: Supabase CLI (`supabase link` lalu `supabase db push`).
3. Buat 2 user demo lewat **Authentication → Users** (satu admin, satu
   guru). Trigger `on_auth_user_created` otomatis membuat baris `profiles`
   (role default `GURU`). Ubah role admin + tetapkan wali kelas lewat SQL
   contoh di header `supabase/seed.sql`.
4. Salin kredensial dari **Project Settings → API** ke `.env.local`:
   `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
   `SUPABASE_SERVICE_ROLE_KEY`. **Jangan commit `.env.local`.**
   File `.env.example` hanya berisi placeholder.

### Skema (ringkas)

16 tabel: `profiles` (id = `auth.users.id`, role Admin/Guru), `pengaturan`
(key/value), `tahun_ajaran`, `semester`, `mapel`, `kelas`, `siswa`,
`keanggotaan_kelas`, `penugasan_guru`, `sesi_absensi`, `absensi`,
`penilaian`, `nilai`, `jurnal`, `audit_log`, `profil_siswa`.
Konvensi: PK tabel operasional bernama `id` (uuid); kolom FK memakai nama
Indonesia + `_id` (`kelas_id`, `siswa_id`, `tahun_ajaran_id`, `mapel_id`,
`sesi_id`). Pengecualian: tabel tahap 4 mempertahankan nama PK asli
(`semester_id`, `assessment_id`, `grade_id`, `journal_id`, `audit_id`).
Aturan kunci: NIS unik (termasuk nonaktif), sesi unik per
(kelas, tanggal, jenis, mapel), absensi unik per (sesi, siswa).
Foto siswa di bucket Storage `siswa-foto`, path `{student_id}/{nama-file}`;
kolom `profil_siswa.foto_url` menyimpan URL publik foto.

### Seed

`supabase/seed.sql`: 1 tahun ajaran aktif (2026/2027), 1 semester Ganjil,
2 kelas (1A, 2B), 1 mapel (Matematika), 10 siswa fiktif (NIS 2026001–
2026010) + wali fiktif + token QR, 2 sesi harian 25 Nov 2026 + 10 baris
absensi (7 H, 1 S, 1 I, 1 A), 4 baris pengaturan. Semua nama orang fiktif.
User auth TIDAK dibuat oleh seed (lihat langkah 3 di atas).

## Deploy ke Vercel (butuh akun Lei)

1. Push repo ini ke GitHub (atau import langsung dari folder), lalu import
   proyek di [Vercel](https://vercel.com/new).
2. Isi Environment Variables di Vercel dengan nilai yang sama seperti
   `.env.local` (`NEXT_PUBLIC_SUPABASE_URL`,
   `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`).
3. Deploy. Build command default (`npm run build`) sudah benar; tidak ada
   pengaturan lain yang diperlukan.

## Struktur proyek

```text
app/
  layout.js            # layout root (lang="id") + Sidebar + Toast
  globals.css          # palet asli: sidebar hijau pastel, banner peach
  page.js              # Dashboard
  login/page.js        # Login Supabase Auth
  kelas/page.js        # Data Kelas
  siswa/page.js        # Data Siswa (+ upload foto, kartu ID)
  absensi/page.js      # Absensi + Scan QR
  kartu/page.js        # Kartu ID (preview, PDF, Excel, cetak)
  pengaturan/page.js   # Pengaturan Sekolah (Admin)
  api/                 # Route Handlers (server-side, cek peran)
    classes/ students/ attendance/ attendance/qr/
    dashboard/ settings/ cards/ export/students/ export/cards/
components/            # Sidebar, StatCard, DataTable, Toast,
                       # QrScanner, StudentCard
lib/
  api.js               # adapter rpc(name, args) — permukaan sama seperti
                       # services/api.js asli, transport fetch ke /api/*
  useProfile.js        # hook profil + peran
  auth.js validation.js audit.js   # otorisasi, validasi, audit (server)
  supabase/            # client (browser), server, middleware
middleware.js          # lindungi semua route kecuali /login
supabase/
  migrations/0001_init.sql   # 16 tabel + RLS
  migrations/0002_storage.sql # bucket siswa-foto
  seed.sql                    # data contoh sintetis
```

## Yang BELUM terverifikasi live

- **Tidak ada database Supabase nyata yang pernah dipakai** — migrasi,
  seed, RLS, Auth, dan upload Storage belum dieksekusi/dites terhadap
  Supabase sungguhan (tidak ada kredensial saat porting). Setelah proyek
  Supabase dibuat, jalankan migrasi + seed lalu uji: login admin vs guru,
  RLS (guru hanya melihat kelasnya), simpan absensi, scan QR, unduh
  kartu/Excel.
- **Build lokal lolos** (`npm run build` hijau; smoke test: `/login` 200,
  `/` redirect 307 ke login, `/api/dashboard` tanpa sesi → 401
  `UNAUTHENTICATED`). Alur end-to-end dengan data nyata belum diuji.
- **Tidak ada jaminan keamanan/kesiapan produksi** — sama seperti status
  tahap 3 aslinya. Uji di proyek Supabase pengembangan dulu sebelum
  dipakai untuk data sekolah sungguhan.
