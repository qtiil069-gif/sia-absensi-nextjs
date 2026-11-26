import { createClient } from '@/lib/supabase/server';
import { getCurrentProfile, requireRole } from '@/lib/auth';
import {
  ok,
  fail,
  handleError,
  parseJsonBody,
  rejectUnknownFields,
  textInput,
  computeRevision,
  checkRevisionIfPresent,
} from '@/lib/validation';
import { writeAudit } from '@/lib/audit';

/**
 * Pengaturan sekolah — porting 24_School.gs (schoolSettings_/updateSchool_).
 *
 * Tabel pengaturan (key/value): school_name, school_logo, school_address,
 * school_identity, semester_label. Key lain dipertahankan (tidak dihapus
 * saat PATCH). Hanya Admin Kepala Sekolah.
 *
 * Catatan porting: di GAS logo disimpan sebagai data URL PNG/JPEG maks
 * 28 KB di sel Sheets. Di Next.js ini logo disimpan sebagai URL (mis.
 * URL publik file di Storage) — PATCH menerima string URL maks 500
 * karakter. Bila tim frontend masih mengirim data URL, nilai itu tetap
 * disimpan apa adanya selama ≤500 karakter; unggah berkas logo adalah
 * tanggung jawab tim frontend/Storage.
 */

const KEYS = {
  school_name: 'name',
  school_logo: 'logo',
  school_address: 'address',
  school_identity: 'identity',
  semester_label: 'semester',
};

async function loadSettings(supabase) {
  const { data, error } = await supabase
    .from('pengaturan')
    .select('key, value');
  if (error) fail('INTERNAL', 'Gagal membaca pengaturan sekolah.');
  const byKey = new Map((data || []).map((r) => [r.key, r.value ?? '']));
  const dto = {
    name: byKey.get('school_name') || 'SIA Sekolah',
    logo: byKey.get('school_logo') || '',
    address: byKey.get('school_address') || '',
    identity: byKey.get('school_identity') || '',
    semester: byKey.get('semester_label') || 'Semester aktif',
  };
  dto.revision = computeRevision(
    ['school_name', 'school_logo', 'school_address', 'school_identity'].map(
      (k) => byKey.get(k) ?? null
    )
  );
  return dto;
}

/** GET /api/settings — pengaturan sekolah.
 *  Baca boleh untuk semua peran yang sudah login (getBootstrap frontend
 *  membutuhkannya untuk menampilkan nama sekolah; guru tidak bisa PATCH).
 *  PATCH tetap khusus Admin. */
export async function GET() {
  try {
    const supabase = createClient();
    await getCurrentProfile(supabase);
    return ok(await loadSettings(supabase));
  } catch (error) {
    return handleError(error);
  }
}

/**
 * PATCH /api/settings — ubah pengaturan sekolah (Admin saja).
 * Body: { name?, logo?, address?, identity?, semester?, expectedRevision? }.
 * Bila expectedRevision dikirim dan tidak cocok → 409 CONFLICT.
 */
export async function PATCH(request) {
  try {
    const supabase = createClient();
    const { profile } = await getCurrentProfile(supabase);
    requireRole(profile, 'ADMIN_KEPALA_SEKOLAH');
    const body = await parseJsonBody(request);
    rejectUnknownFields(body, [
      'name', 'logo', 'address', 'identity', 'semester', 'expectedRevision',
    ]);
    const current = await loadSettings(supabase);
    checkRevisionIfPresent(body.expectedRevision, current.revision);

    const values = {};
    if (body.name !== undefined) {
      values.school_name = textInput(body.name, 'Nama sekolah', 120);
    }
    if (body.logo !== undefined) {
      values.school_logo = textInput(body.logo, 'Logo sekolah', 500, true);
    }
    if (body.address !== undefined) {
      values.school_address = textInput(body.address, 'Alamat sekolah', 500, true, true);
    }
    if (body.identity !== undefined) {
      values.school_identity = textInput(body.identity, 'Identitas sekolah', 200, true);
    }
    if (body.semester !== undefined) {
      values.semester_label = textInput(body.semester, 'Semester', 120, true);
    }
    if (!Object.keys(values).length) {
      fail('INVALID_ARGUMENT', 'Tidak ada perubahan yang dikirim.');
    }

    for (const [key, value] of Object.entries(values)) {
      const { error } = await supabase
        .from('pengaturan')
        .upsert({ key, value }, { onConflict: 'key' });
      if (error) fail('INTERNAL', 'Gagal menyimpan pengaturan sekolah.');
    }

    await writeAudit({
      actorId: profile.id,
      action: 'UPDATE_SCHOOL',
      entity: 'Pengaturan',
      entityId: 'school',
    });
    return ok(await loadSettings(supabase));
  } catch (error) {
    return handleError(error);
  }
}
