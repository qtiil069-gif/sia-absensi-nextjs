import { createClient } from '@/lib/supabase/server';
import {
  getCurrentProfile,
  isAdmin,
  requireRole,
  canAccessClass,
  classDto,
} from '@/lib/auth';
import {
  ok,
  fail,
  handleError,
  parseJsonBody,
  rejectUnknownFields,
  textInput,
  idInput,
  levelInput,
  computeRevision,
  checkRevisionIfPresent,
} from '@/lib/validation';
import { writeAudit } from '@/lib/audit';

function classRevision(row) {
  return computeRevision([
    row.id, row.nama, row.tingkat, row.tahun_ajaran_id, row.wali_user_id, row.aktif,
  ]);
}

async function loadClass(supabase, id) {
  const { data, error } = await supabase
    .from('kelas')
    .select('id, nama, tingkat, tahun_ajaran_id, wali_user_id, aktif')
    .eq('id', id)
    .maybeSingle();
  if (error) fail('INTERNAL', 'Gagal membaca data kelas.');
  if (!data) fail('NOT_FOUND', 'Kelas tidak ditemukan.');
  return data;
}

/**
 * GET /api/classes/[id] — detail satu kelas (dalam cakupan).
 * Guru hanya boleh melihat kelas yang dia walikan / ditugaskan.
 */
export async function GET(request, { params }) {
  try {
    const supabase = createClient();
    const { profile } = await getCurrentProfile(supabase);
    const id = idInput(params.id);
    const row = await loadClass(supabase, id);
    if (!isAdmin(profile)) {
      const allowed = await canAccessClass(supabase, profile, id);
      if (!allowed || row.aktif === false) {
        fail('FORBIDDEN', 'Kelas tidak tersedia untuk akun ini.');
      }
    }
    return ok({ ...classDto(row), revision: classRevision(row) });
  } catch (error) {
    return handleError(error);
  }
}

/**
 * PATCH /api/classes/[id] — ubah kelas. Khusus Admin.
 * Body: { name?, level?, yearId?, homeroomId?, expectedRevision? }.
 * Bila expectedRevision dikirim dan tidak cocok → 409 CONFLICT.
 * Tahun baru harus aktif; nama tetap unik per tahun (termasuk nonaktif).
 */
export async function PATCH(request, { params }) {
  try {
    const supabase = createClient();
    const { profile } = await getCurrentProfile(supabase);
    requireRole(profile, 'ADMIN_KEPALA_SEKOLAH');
    const id = idInput(params.id);
    const body = await parseJsonBody(request);
    rejectUnknownFields(body, [
      'id', 'name', 'level', 'yearId', 'homeroomId', 'active', 'expectedRevision',
    ]);
    const current = await loadClass(supabase, id);
    checkRevisionIfPresent(body.expectedRevision, classRevision(current));

    const patch = {};
    if (body.name !== undefined) patch.nama = textInput(body.name, 'Nama kelas', 60);
    if (body.level !== undefined) patch.tingkat = levelInput(body.level);
    if (body.yearId !== undefined) patch.tahun_ajaran_id = idInput(body.yearId);
    if (body.homeroomId !== undefined) {
      patch.wali_user_id = body.homeroomId ? idInput(body.homeroomId) : null;
    }
    // Frontend menonaktifkan kelas lewat PATCH { active:false }.
    if (body.active !== undefined) {
      if (typeof body.active !== 'boolean') {
        fail('INVALID_ARGUMENT', 'Status aktif harus true atau false.');
      }
      patch.aktif = body.active;
    }
    if (!Object.keys(patch).length) {
      fail('INVALID_ARGUMENT', 'Tidak ada perubahan yang dikirim.');
    }

    const targetYearId = patch.tahun_ajaran_id || current.tahun_ajaran_id;
    const { data: year, error: yearErr } = await supabase
      .from('tahun_ajaran')
      .select('id, aktif')
      .eq('id', targetYearId)
      .maybeSingle();
    if (yearErr) fail('INTERNAL', 'Gagal membaca tahun ajaran.');
    if (!year) fail('NOT_FOUND', 'Tahun ajaran tidak ditemukan.');
    // Tahun baru harus aktif; tahun lama nonaktif boleh dipertahankan.
    if (year.aktif === false && targetYearId !== current.tahun_ajaran_id) {
      fail('INVALID_ARGUMENT', 'Tahun ajaran tidak aktif.');
    }

    if (patch.wali_user_id) {
      const { data: teacher, error: tErr } = await supabase
        .from('profiles')
        .select('id, role, aktif')
        .eq('id', patch.wali_user_id)
        .maybeSingle();
      if (tErr) fail('INTERNAL', 'Gagal membaca data wali kelas.');
      if (
        !teacher ||
        teacher.aktif === false ||
        !['GURU', 'ADMIN_KEPALA_SEKOLAH', 'ADMIN'].includes(teacher.role)
      ) {
        fail(
          'INVALID_ARGUMENT',
          'Wali kelas harus akun aktif dengan role yang diizinkan.'
        );
      }
    }

    const targetName = patch.nama || current.nama;
    const { data: siblings, error: sErr } = await supabase
      .from('kelas')
      .select('id, nama')
      .eq('tahun_ajaran_id', targetYearId)
      .neq('id', id);
    if (sErr) fail('INTERNAL', 'Gagal memeriksa nama kelas.');
    if (
      (siblings || []).some(
        (r) =>
          String(r.nama).trim().toLocaleLowerCase() ===
          targetName.toLocaleLowerCase()
      )
    ) {
      fail(
        'DUPLICATE',
        'Nama kelas sudah dipakai pada tahun ajaran tersebut, termasuk kelas nonaktif.'
      );
    }

    const { data: updated, error } = await supabase
      .from('kelas')
      .update(patch)
      .eq('id', id)
      .select('id, nama, tingkat, tahun_ajaran_id, wali_user_id, aktif')
      .single();
    if (error) {
      if (error.code === '23505') {
        fail(
          'DUPLICATE',
          'Nama kelas sudah dipakai pada tahun ajaran tersebut, termasuk kelas nonaktif.'
        );
      }
      fail('INTERNAL', 'Gagal menyimpan perubahan kelas.');
    }
    await writeAudit({
      actorId: profile.id,
      action: 'UPDATE_CLASS',
      entity: 'Kelas',
      entityId: id,
    });
    return ok({ ...classDto(updated), revision: classRevision(updated) });
  } catch (error) {
    return handleError(error);
  }
}

/**
 * DELETE /api/classes/[id] — NONAKTIFKAN kelas (aktif=false), BUKAN hapus
 * permanen. Khusus Admin. Siswa, penugasan, dan riwayat tetap tersimpan.
 * Body opsional: { expectedRevision? }.
 */
export async function DELETE(request, { params }) {
  try {
    const supabase = createClient();
    const { profile } = await getCurrentProfile(supabase);
    requireRole(profile, 'ADMIN_KEPALA_SEKOLAH');
    const id = idInput(params.id);
    let expectedRevision;
    try {
      const body = await request.json();
      if (body && typeof body === 'object') {
        rejectUnknownFields(body, ['expectedRevision']);
        expectedRevision = body.expectedRevision;
      }
    } catch {
      // Body DELETE boleh kosong.
    }
    const current = await loadClass(supabase, id);
    checkRevisionIfPresent(expectedRevision, classRevision(current));

    if (current.aktif === false) {
      return ok({ ...classDto(current), revision: classRevision(current) });
    }
    const { data: updated, error } = await supabase
      .from('kelas')
      .update({ aktif: false })
      .eq('id', id)
      .select('id, nama, tingkat, tahun_ajaran_id, wali_user_id, aktif')
      .single();
    if (error) fail('INTERNAL', 'Gagal menonaktifkan kelas.');
    await writeAudit({
      actorId: profile.id,
      action: 'DEACTIVATE_CLASS',
      entity: 'Kelas',
      entityId: id,
    });
    return ok({ ...classDto(updated), revision: classRevision(updated) });
  } catch (error) {
    return handleError(error);
  }
}
