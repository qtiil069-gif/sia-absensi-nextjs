import { randomUUID } from 'crypto';
import { createClient } from '@/lib/supabase/server';
import {
  getCurrentProfile,
  isAdmin,
  requireRole,
  getAccessibleClassIds,
  studentDto,
} from '@/lib/auth';
import {
  ok,
  fail,
  handleError,
  parseJsonBody,
  rejectUnknownFields,
  textInput,
  idInput,
  nisInput,
  nisnInput,
  guardianPhoneInput,
  assertNisUnique,
  parsePagination,
  statusFilterInput,
  searchInput,
} from '@/lib/validation';
import { writeAudit } from '@/lib/audit';

/** Ambil peta keanggotaan aktif + profil untuk sekumpulan siswa. */
async function enrichStudents(supabase, rows) {
  const ids = rows.map((r) => r.id);
  if (!ids.length) return { membershipsById: new Map(), profileById: new Map() };
  const { data: memberships } = await supabase
    .from('keanggotaan_kelas')
    .select('siswa_id, kelas_id')
    .in('siswa_id', ids)
    .eq('aktif', true);
  const { data: profiles } = await supabase
    .from('profil_siswa')
    .select('siswa_id, wali_nama, wali_telepon, wali_hubungan, foto_url, qr_token')
    .in('siswa_id', ids);
  const membershipsById = new Map();
  (memberships || []).forEach((m) => {
    if (!membershipsById.has(m.siswa_id)) membershipsById.set(m.siswa_id, []);
    membershipsById.get(m.siswa_id).push(m.kelas_id);
  });
  const profileById = new Map((profiles || []).map((p) => [p.siswa_id, p]));
  return { membershipsById, profileById };
}

async function loadActiveClass(supabase, classId) {
  const { data, error } = await supabase
    .from('kelas')
    .select('id, aktif')
    .eq('id', classId)
    .maybeSingle();
  if (error) fail('INTERNAL', 'Gagal membaca data kelas.');
  if (!data) fail('NOT_FOUND', 'Kelas tidak ditemukan.');
  if (data.aktif === false) {
    fail('INVALID_ARGUMENT', 'Kelas tujuan harus aktif.');
  }
  return data;
}

/**
 * GET /api/students — daftar siswa + pagination.
 * Query: q (nama/NIS), classId, status=active|inactive|all (nonaktif
 * hanya admin), page, pageSize (10/25/50/100). Guru hanya siswa aktif
 * pada kelas yang dia walikan/ditugaskan; memilih kelas lain → 403.
 * Halaman yang melewati halaman terakhir dikembalikan ke halaman terakhir
 * (perilaku GAS queryStudents_).
 */
export async function GET(request) {
  try {
    const supabase = createClient();
    const { profile } = await getCurrentProfile(supabase);
    const params = new URL(request.url).searchParams;
    const admin = isAdmin(profile);
    const status = statusFilterInput(params.get('status'), admin);
    const q = searchInput(params.get('q') || '');
    const classId = params.get('classId') ? idInput(params.get('classId')) : '';
    const { page: reqPage, pageSize } = parsePagination(params);

    const permitted = admin
      ? null
      : await getAccessibleClassIds(supabase, profile);
    if (classId) {
      if (admin) {
        const { data, error } = await supabase
          .from('kelas')
          .select('id')
          .eq('id', classId)
          .maybeSingle();
        if (error) fail('INTERNAL', 'Gagal membaca data kelas.');
        if (!data) fail('FORBIDDEN', 'Kelas tidak tersedia untuk akun ini.');
      } else if (!permitted.includes(classId)) {
        fail('FORBIDDEN', 'Kelas tidak tersedia untuk akun ini.');
      }
    }

    let query = supabase
      .from('siswa')
      .select('id, nama, nis, nisn, aktif')
      .order('nama', { ascending: true });
    if (status === 'active') query = query.eq('aktif', true);
    if (status === 'inactive') query = query.eq('aktif', false);
    if (q) query = query.or(`nama.ilike.%${q}%,nis.ilike.%${q}%`);
    const { data: rows, error } = await query;
    if (error) fail('INTERNAL', 'Gagal membaca daftar siswa.');

    const { membershipsById, profileById } = await enrichStudents(
      supabase,
      rows || []
    );
    let items = (rows || [])
      .map((row) =>
        studentDto(
          row,
          membershipsById.get(row.id) || [],
          profileById.get(row.id),
          admin
        )
      )
      .filter((dto) => {
        if (!admin && dto.classIds.length === 0) return false;
        if (!admin) {
          dto.classIds = dto.classIds.filter((c) => permitted.includes(c));
          if (dto.classIds.length === 0) return false;
        }
        if (classId && !dto.classIds.includes(classId)) return false;
        return true;
      });

    const total = items.length;
    const pages = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(reqPage, pages);
    items = items.slice((page - 1) * pageSize, page * pageSize);
    return ok({ items, total, page, pageSize, pages });
  } catch (error) {
    return handleError(error);
  }
}

const PROFILE_FIELDS = [
  'guardianName',
  'guardianPhone',
  'guardianRelation',
  'photo',
];

/**
 * POST /api/students — tambah siswa. Khusus Admin.
 * Body: { name, nis, nisn?, classId, guardianName?, guardianPhone?,
 * guardianRelation?, photo? (URL foto di Storage) }.
 * NIS unik (case-insensitive, termasuk nonaktif); NISN 10 digit/ kosong;
 * kelas tujuan harus aktif; nomor wali 8–18 digit.
 */
export async function POST(request) {
  try {
    const supabase = createClient();
    const { profile } = await getCurrentProfile(supabase);
    requireRole(profile, 'ADMIN_KEPALA_SEKOLAH');
    const body = await parseJsonBody(request);
    rejectUnknownFields(body, [
      'name', 'nis', 'nisn', 'classId', ...PROFILE_FIELDS,
    ]);

    const name = textInput(body.name, 'Nama siswa', 120);
    const nis = nisInput(body.nis);
    const nisn = nisnInput(body.nisn);
    const classId = idInput(body.classId);
    await assertNisUnique(supabase, nis);
    await loadActiveClass(supabase, classId);

    const hasProfile = PROFILE_FIELDS.some((k) =>
      Object.prototype.hasOwnProperty.call(body, k)
    );
    let profileFields = null;
    if (hasProfile) {
      profileFields = {
        wali_nama:
          body.guardianName !== undefined
            ? textInput(body.guardianName, 'Nama wali', 120, true)
            : '',
        wali_telepon:
          body.guardianPhone !== undefined
            ? guardianPhoneInput(body.guardianPhone)
            : '',
        wali_hubungan:
          body.guardianRelation !== undefined
            ? textInput(body.guardianRelation, 'Hubungan wali', 60, true)
            : '',
        foto_url:
          body.photo !== undefined
            ? textInput(body.photo, 'Foto', 500, true)
            : '',
      };
    }

    const { data: created, error } = await supabase
      .from('siswa')
      .insert({ nama: name, nis, nisn: nisn || null, aktif: true })
      .select('id, nama, nis, nisn, aktif')
      .single();
    if (error) {
      if (error.code === '23505') {
        fail('DUPLICATE', 'NIS sudah digunakan, termasuk oleh siswa nonaktif.');
      }
      fail('INTERNAL', 'Gagal menyimpan siswa.');
    }

    const { error: mErr } = await supabase
      .from('keanggotaan_kelas')
      .insert({ siswa_id: created.id, kelas_id: classId, aktif: true });
    if (mErr) fail('INTERNAL', 'Gagal menyimpan keanggotaan kelas.');

    let savedProfile = null;
    if (profileFields) {
      const { data, error: pErr } = await supabase
        .from('profil_siswa')
        .upsert(
          {
            siswa_id: created.id,
            ...profileFields,
            qr_token: randomUUID(),
          },
          { onConflict: 'siswa_id' }
        )
        .select()
        .single();
      if (pErr) fail('INTERNAL', 'Gagal menyimpan profil siswa.');
      savedProfile = data;
    }

    await writeAudit({
      actorId: profile.id,
      action: 'CREATE_STUDENT',
      entity: 'Siswa',
      entityId: created.id,
    });
    return ok(studentDto(created, [classId], savedProfile, true), 201);
  } catch (error) {
    return handleError(error);
  }
}
