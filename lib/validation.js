import { createHash } from 'crypto';
import { NextResponse } from 'next/server';

/**
 * Validasi + envelope respons API, porting dari 02_Validation.gs.
 * Semua route mengembalikan { ok:true, data } atau
 * { ok:false, error:{ code, message } } dengan status HTTP yang sesuai.
 * Pesan error berbahasa Indonesia dan aman ditampilkan ke pengguna
 * (tanpa stack trace / detail internal).
 */

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

export class ApiError extends Error {
  constructor(code, message, status) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

const STATUS_BY_CODE = {
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  DUPLICATE: 409,
  CONFLICT: 409,
  INVALID_ARGUMENT: 400,
  BUSY: 409,
  DATA_INVALID: 422,
  MIGRATION_REQUIRED: 428,
  CONFIG_REQUIRED: 500,
  WRITE_FAILED: 500,
  INTERNAL: 500,
};

/** Lempar error API dengan kode kontrak GAS (lihat docs/backend-contracts.md). */
export function fail(code, message, status) {
  throw new ApiError(code, message, status || STATUS_BY_CODE[code] || 400);
}

export function ok(data, status = 200) {
  return NextResponse.json({ ok: true, data }, { status });
}

/** Ubah error apa pun (termasuk dari Supabase) menjadi respons envelope. */
export function handleError(error) {
  if (error instanceof ApiError) {
    return NextResponse.json(
      { ok: false, error: { code: error.code, message: error.message } },
      { status: error.status }
    );
  }
  // Sembunyikan detail internal (pesan Supabase mentah, stack trace).
  console.error('SIA backend: kegagalan layanan internal.', error);
  return NextResponse.json(
    {
      ok: false,
      error: {
        code: 'INTERNAL',
        message: 'Layanan mengalami gangguan. Hubungi administrator.',
      },
    },
    { status: 500 }
  );
}

/** Baca body JSON; body kosong / bukan objek / bukan JSON → INVALID_ARGUMENT. */
export async function parseJsonBody(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    fail('INVALID_ARGUMENT', 'Isi permintaan harus berupa JSON yang valid.');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    fail('INVALID_ARGUMENT', 'Isi permintaan harus berupa objek JSON.');
  }
  return body;
}

/** Tolak field yang tidak dikenal — seperti inputObject_() di GAS. */
export function rejectUnknownFields(body, allowed) {
  const unknown = Object.keys(body).filter((k) => !allowed.includes(k));
  if (unknown.length) {
    fail(
      'INVALID_ARGUMENT',
      `Kolom tidak dikenal pada permintaan: ${unknown.join(', ')}.`
    );
  }
}

// ---------------------------------------------------------------------------
// Teks & ID (porting textInput_ / idInput_)
// ---------------------------------------------------------------------------

const CONTROL_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f]/;

/**
 * Teks wajib/opsional: trim, batas panjang, tolak karakter kontrol dan
 * awalan formula (=, +, -, @) seperti validasi GAS.
 */
export function textInput(value, label, max, optional = false, multiline = false) {
  if (optional && (value === undefined || value === null || value === '')) return '';
  if (typeof value !== 'string') {
    fail('INVALID_ARGUMENT', `${label} harus berupa teks.`);
  }
  const text = value.trim();
  const control = multiline
    ? /[\u0000-\u0009\u000b-\u001f\u007f]/
    : CONTROL_CHARS;
  if (
    (!optional && !text) ||
    text.length > max ||
    control.test(text) ||
    /^[=+@-]/.test(text)
  ) {
    fail(
      'INVALID_ARGUMENT',
      `${label} kosong, terlalu panjang, atau mengandung awalan formula/karakter terlarang.`
    );
  }
  return text;
}

/** ID teks: huruf/angka/garis bawah/tanda hubung, maks 100 karakter. */
export function idInput(value, optional = false) {
  const text = textInput(value, 'ID', 100, optional);
  if (text && !/^[A-Za-z0-9_-]+$/.test(text)) {
    fail('INVALID_ARGUMENT', 'Format ID tidak valid.');
  }
  return text;
}

/** UUID (dipakai untuk id / qr_token yang dikirim klien — bila ada). */
export function uuidInput(value, optional = false) {
  const text = textInput(value, 'ID', 100, optional);
  if (
    text &&
    !/^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$/.test(text)
  ) {
    fail('INVALID_ARGUMENT', 'Format ID tidak valid.');
  }
  return text;
}

// ---------------------------------------------------------------------------
// Validasi domain
// ---------------------------------------------------------------------------

/** Tanggal ISO YYYY-MM-DD yang benar-benar ada di kalender. */
export function dateInput(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    fail('INVALID_ARGUMENT', 'Tanggal harus berformat YYYY-MM-DD.');
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    fail('INVALID_ARGUMENT', 'Tanggal tidak valid.');
  }
  return value;
}

/** Hari ini (Asia/Jakarta) dalam format YYYY-MM-DD. */
export function todayJakarta() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jakarta' });
}

/** Status absensi: H (Hadir), S (Sakit), I (Izin), A (Alfa). */
export const ATTENDANCE_STATUSES = ['H', 'S', 'I', 'A'];

export function statusInput(value) {
  if (!ATTENDANCE_STATUSES.includes(value)) {
    fail(
      'INVALID_ARGUMENT',
      'Status harus H (Hadir), S (Sakit), I (Izin), atau A (Alfa).'
    );
  }
  return value;
}

/** Jenis sesi absensi. */
export function kindInput(value) {
  const kind = value === undefined ? 'HARIAN' : value;
  if (!['HARIAN', 'MAPEL'].includes(kind)) {
    fail('INVALID_ARGUMENT', 'Jenis sesi harus HARIAN atau MAPEL.');
  }
  return kind;
}

/**
 * NIS: teks (nol awal dipertahankan), huruf/angka/titik/garis miring/
 * garis bawah/tanda hubung, maks 30 karakter (porting 22_Students.gs).
 */
export function nisInput(value) {
  const nis = textInput(value, 'NIS', 30);
  if (!/^[A-Za-z0-9][A-Za-z0-9./_-]*$/.test(nis)) {
    fail(
      'INVALID_ARGUMENT',
      'NIS hanya boleh berisi huruf, angka, titik, garis miring, garis bawah, atau tanda hubung.'
    );
  }
  return nis;
}

/** NISN kosong atau tepat 10 digit. */
export function nisnInput(value) {
  const nisn = textInput(value, 'NISN', 10, true);
  if (nisn && !/^\d{10}$/.test(nisn)) {
    fail('INVALID_ARGUMENT', 'NISN harus 10 digit atau dikosongkan.');
  }
  return nisn;
}

/** Nomor wali: 8–18 digit, kode negara opsional diawali +. */
export function guardianPhoneInput(value) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string' || value.length > 30 || !/^[+0-9 ()-]*$/.test(value)) {
    fail('INVALID_ARGUMENT', 'Format nomor wali tidak valid.');
  }
  const phone = value.trim().replace(/[ ()-]/g, '');
  if (phone && !/^\+?\d{8,18}$/.test(phone)) {
    fail(
      'INVALID_ARGUMENT',
      'Nomor telepon/WhatsApp wali harus 8–18 digit dengan kode negara opsional.'
    );
  }
  return phone;
}

/** Tingkat kelas: bilangan bulat 1–12. */
export function levelInput(value) {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > 12
  ) {
    fail('INVALID_ARGUMENT', 'Tingkat harus bilangan bulat 1–12.');
  }
  return value;
}

/** Filter status master: active (default) / inactive / all. */
export function statusFilterInput(value, isAdmin) {
  const status = value === undefined || value === '' ? 'active' : value;
  if (!['active', 'inactive', 'all'].includes(status)) {
    fail('INVALID_ARGUMENT', 'Filter status tidak valid.');
  }
  if (status !== 'active' && !isAdmin) {
    fail('FORBIDDEN', 'Hanya Admin yang dapat melihat data nonaktif.');
  }
  return status;
}

/** Pagination GAS: page 1–10000, pageSize hanya 10/25/50/100, default 1/25. */
export function parsePagination(searchParams) {
  const rawPage = searchParams.get('page');
  const rawSize = searchParams.get('pageSize') || searchParams.get('limit');
  const page = rawPage === null ? 1 : Number(rawPage);
  const pageSize = rawSize === null ? 25 : Number(rawSize);
  if (
    !Number.isInteger(page) ||
    page < 1 ||
    page > 10000 ||
    ![10, 25, 50, 100].includes(pageSize)
  ) {
    fail(
      'INVALID_ARGUMENT',
      'Pagination tidak valid. Ukuran halaman: 10, 25, 50, atau 100.'
    );
  }
  return { page, pageSize };
}

/** Pencarian bebas: maks 100 karakter, kembalikan huruf kecil. */
export function searchInput(value) {
  return textInput(value, 'Pencarian', 100, true).toLocaleLowerCase();
}

/**
 * Cek NIS unik (case-insensitive, termasuk siswa nonaktif) ke DB.
 * Dipakai sebelum insert/update siswa — porting cek DUPLICATE di GAS.
 */
export async function assertNisUnique(supabase, nis, excludeId = null) {
  const { data, error } = await supabase
    .from('siswa')
    .select('id, nis');
  if (error) fail('INTERNAL', 'Gagal memeriksa keunikan NIS.');
  const clash = (data || []).some(
    (row) =>
      row.id !== excludeId &&
      String(row.nis).trim().toLocaleLowerCase() === nis.toLocaleLowerCase()
  );
  if (clash) {
    fail('DUPLICATE', 'NIS sudah digunakan, termasuk oleh siswa nonaktif.');
  }
}

// ---------------------------------------------------------------------------
// Revision (optimistic concurrency — porting revision_ / checkRevision_)
// ---------------------------------------------------------------------------

/** SHA-256 hex dari snapshot JSON — sama perannya dengan revision_() GAS. */
export function computeRevision(value) {
  return createHash('sha256')
    .update(JSON.stringify(value), 'utf8')
    .digest('hex');
}

/**
 * expectedRevision wajib (bila diminta route) dan harus cocok dengan
 * revision snapshot saat ini; bila tidak cocok → 409 CONFLICT.
 */
export function checkRevision(expected, actual) {
  if (typeof expected !== 'string' || !/^[a-f0-9]{64}$/.test(expected)) {
    fail(
      'INVALID_ARGUMENT',
      'Versi data wajib disertakan. Muat ulang data sebelum menyimpan.'
    );
  }
  if (expected !== actual) {
    fail(
      'CONFLICT',
      'Data telah berubah. Muat ulang dan periksa perubahan sebelum menyimpan kembali.'
    );
  }
}

/** Revision opsional: hanya diperiksa bila klien mengirimkannya. */
export function checkRevisionIfPresent(expected, actual) {
  if (expected === undefined || expected === null || expected === '') return;
  checkRevision(expected, actual);
}
