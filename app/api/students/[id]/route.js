import { randomUUID } from 'crypto';
import { createClient } from '@/lib/supabase/server';
import {
  getCurrentProfile,
  isAdmin,
  requireRole,
  canAccessClass,
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
  computeRevision,
  checkRevisionIfPresent,
} from '@/lib/validation';
import { writeAudit } from '@/lib/audit';

async function loadStudentFull(supabase, id) {
  const { data: row, error } = await supabase
    .from('siswa')
    .select('id, nama, nis, nisn, aktif')
    .eq('id', id)
    .maybeSingle();
  if (error) fail('INTERNAL', 'Gagal membaca data siswa.');
  if (!row) fail('NOT_FOUND', 'Siswa tidak ditemukan.');
  const { data: memberships } = await supabase
    .from('keanggotaan_kelas')
    .select('id, siswa_id, kelas_id, aktif')
    .eq('siswa_id', id)
    .eq('aktif', true);
  const { data: profile } = await supabase
    .from('profil_siswa')
    .select('siswa_id, wali_nama, wali_telepon, wali_hubungan, foto_url, qr_token')
    .eq('siswa_id', id)
    .maybeSingle();
  return {
    row,
    memberships: memberships || [],
    profile: profile || null,
  };
}

function studentRevision(full) {
  return computeRevision([
    {
      id: full.row.id, nama: full.row.nama, nis: full.row.nis,
      nisn: full.row.nisn, aktif: full.row.aktif,
    },
    full.memberships.map((m) => m.kelas_id).sort(),
    full.profile
      ? {
          wali_nama: full.profile.wali_nama,
          wali_telepon: full.profile.wali_telepon,
          wali_hubungan: full.profile.wali_hubungan,
          foto_url: full.profile.foto_url,
          qr_token: full.profile.qr_token,
        }
      : null,
  ]);
}

function toDto(full, detailed) {
  return studentDto(
    full.row,
    full.memberships.map((m) => m.kelas_id),
    full.profile,
    detailed
  );
}

/** Guru hanya boleh melihat siswa aktif di kelas yang dia akses. */
async function assertReadable(supabase, profile, full) {
  if (isAdmin(profile)) return;
  if (full.row.aktif === false) {
    fail('FORBIDDEN', 'Siswa tidak tersedia untuk akun ini.');
  }
  const inScope = await Promise.all(
    full.memberships.map((m) => canAccessClass(supabase, profile, m.kelas_id))
  );
  if (!inScope.some(Boolean)) {
    fail('FORBIDDEN', 'Siswa tidak tersedia untuk akun ini.');
  }
}

/** GET /api/students/[id] — detail satu siswa (dalam cakupan). */
export async function GET(request, { params }) {
  try {
    const supabase = createClient();
    const { profile } = await getCurrentProfile(supabase);
    const id = idInput(params.id);
    const full = await loadStudentFull(supabase, id);
    await assertReadable(supabase, profile, full);
    const dto = toDto(full, isAdmin(profile));
    if (!isAdmin(profile)) {
      // Guru hanya melihat classIds dalam cakupannya.
      const allowed = [];
      for (const c of dto.classIds) {
        if (await canAccessClass(supabase, profile, c)) allowed.push(c);
      }
      dto.classIds = allowed;
    }
    return ok(dto);
  } catch (error) {
    return handleError(error);
  }
}

/**
 * PATCH /api/students/[id] — ubah siswa / pindah kelas / nonaktifkan
 * lewat body { active:false }. Khusus Admin.
 * Pindah kelas: keanggotaan lama dinonaktifkan, keanggotaan baru dibuat;
 * riwayat keanggotaan & absensi tidak dihapus (porting saveStudent_ GAS).
 * Bila expectedRevision dikirim dan tidak cocok → 409 CONFLICT.
 */
export async function PATCH(request, { params }) {
  try {
    const supabase = createClient();
    const { profile } = await getCurrentProfile(supabase);
    requireRole(profile, 'ADMIN_KEPALA_SEKOLAH');
    const id = idInput(params.id);
    const body = await parseJsonBody(request);
    rejectUnknownFields(body, [
      'id', 'name', 'nis', 'nisn', 'classId', 'active',
      'guardianName', 'guardianPhone', 'guardianRelation', 'photo',
      'expectedRevision',
    ]);
    const full = await loadStudentFull(supabase, id);
    checkRevisionIfPresent(body.expectedRevision, studentRevision(full));

    const patch = {};
    if (body.name !== undefined) patch.nama = textInput(body.name, 'Nama siswa', 120);
    if (body.nis !== undefined) {
      patch.nis = nisInput(body.nis);
      await assertNisUnique(supabase, patch.nis, id);
    }
    if (body.nisn !== undefined) patch.nisn = nisnInput(body.nisn) || null;
    if (body.active !== undefined) {
      if (typeof body.active !== 'boolean') {
        fail('INVALID_ARGUMENT', 'Status aktif harus true atau false.');
      }
      patch.aktif = body.active;
    }

    let targetClassId = null;
    if (body.classId !== undefined) {
      targetClassId = idInput(body.classId);
      const { data: kelas, error: kErr } = await supabase
        .from('kelas')
        .select('id, aktif')
        .eq('id', targetClassId)
        .maybeSingle();
      if (kErr) fail('INTERNAL', 'Gagal membaca data kelas.');
      if (!kelas) fail('NOT_FOUND', 'Kelas tidak ditemukan.');
      if (kelas.aktif === false) {
        fail('INVALID_ARGUMENT', 'Kelas tujuan harus aktif.');
      }
    }

    const hasProfileField = ['guardianName', 'guardianPhone', 'guardianRelation', 'photo']
      .some((k) => Object.prototype.hasOwnProperty.call(body, k));
    let profileFields = null;
    if (hasProfileField) {
      profileFields = {
        wali_nama:
          body.guardianName !== undefined
            ? textInput(body.guardianName, 'Nama wali', 120, true)
            : (full.profile?.wali_nama || ''),
        wali_telepon:
          body.guardianPhone !== undefined
            ? guardianPhoneInput(body.guardianPhone)
            : (full.profile?.wali_telepon || ''),
        wali_hubungan:
          body.guardianRelation !== undefined
            ? textInput(body.guardianRelation, 'Hubungan wali', 60, true)
            : (full.profile?.wali_hubungan || ''),
        foto_url:
          body.photo !== undefined
            ? textInput(body.photo, 'Foto', 500, true)
            : (full.profile?.foto_url || ''),
        qr_token: full.profile?.qr_token || randomUUID(),
      };
    }

    if (Object.keys(patch).length) {
      const { error } = await supabase
        .from('siswa')
        .update(patch)
        .eq('id', id);
      if (error) {
        if (error.code === '23505') {
          fail('DUPLICATE', 'NIS sudah digunakan, termasuk oleh siswa nonaktif.');
        }
        fail('INTERNAL', 'Gagal menyimpan perubahan siswa.');
      }
    }

    if (profileFields) {
      const { error: pErr } = await supabase
        .from('profil_siswa')
        .upsert(
          { siswa_id: id, ...profileFields },
          { onConflict: 'siswa_id' }
        );
      if (pErr) fail('INTERNAL', 'Gagal menyimpan profil siswa.');
    }

    if (targetClassId) {
      const currentIds = full.memberships.map((m) => m.kelas_id);
      if (!currentIds.includes(targetClassId)) {
        // Nonaktifkan keanggotaan aktif lama, tambah yang baru.
        const { error: dErr } = await supabase
          .from('keanggotaan_kelas')
          .update({ aktif: false })
          .eq('siswa_id', id)
          .eq('aktif', true)
          .neq('kelas_id', targetClassId);
        if (dErr) fail('INTERNAL', 'Gagal memindahkan siswa.');
        const { error: iErr } = await supabase
          .from('keanggotaan_kelas')
          .insert({ siswa_id: id, kelas_id: targetClassId, aktif: true });
        if (iErr && iErr.code !== '23505') {
          fail('INTERNAL', 'Gagal menyimpan keanggotaan kelas.');
        }
      }
    }

    await writeAudit({
      actorId: profile.id,
      action: 'UPDATE_STUDENT',
      entity: 'Siswa',
      entityId: id,
    });
    const updated = await loadStudentFull(supabase, id);
    return ok(toDto(updated, true));
  } catch (error) {
    return handleError(error);
  }
}

/**
 * DELETE /api/students/[id] — NONAKTIFKAN siswa (aktif=false), BUKAN hapus
 * permanen. Khusus Admin. Keanggotaan & riwayat absensi tetap tersimpan.
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
    const full = await loadStudentFull(supabase, id);
    checkRevisionIfPresent(expectedRevision, studentRevision(full));

    if (full.row.aktif !== false) {
      const { error } = await supabase
        .from('siswa')
        .update({ aktif: false })
        .eq('id', id);
      if (error) fail('INTERNAL', 'Gagal menonaktifkan siswa.');
      await writeAudit({
        actorId: profile.id,
        action: 'DEACTIVATE_STUDENT',
        entity: 'Siswa',
        entityId: id,
      });
    }
    const updated = await loadStudentFull(supabase, id);
    return ok(toDto(updated, true));
  } catch (error) {
    return handleError(error);
  }
}
