import { randomUUID } from 'crypto';
import { createClient, createServiceClient } from '@/lib/supabase/server';
import {
  getCurrentProfile,
  isAdmin,
  getAccessibleClassIds,
  getClassRoster,
} from '@/lib/auth';
import {
  ok,
  fail,
  handleError,
  idInput,
} from '@/lib/validation';
import { writeAudit } from '@/lib/audit';

/**
 * GET /api/cards?classId= — data kartu ID siswa (porting prepareCards_
 * di 25_CardsQr.gs). Alternatif: ?studentIds=id1,id2 (maks 500).
 *
 * Mengembalikan { school: { name, logo, address, identity, semester },
 *   cards: [{ id, name, nis, nisn, photo, className, qr }] }.
 * qr = 'SIA-ID:1:<token>' — token dibuat server (UUID) bila belum ada dan
 * TETAP SAMA saat cetak ulang. Hanya siswa aktif dalam cakupan akun;
 * guru hanya kelas yang dia walikan/ditugaskan.
 * Foto/NISN yang kosong dikembalikan kosong (bukan data rekaan).
 */
export async function GET(request) {
  try {
    const supabase = createClient();
    const { profile } = await getCurrentProfile(supabase);
    const params = new URL(request.url).searchParams;
    const classId = params.get('classId')
      ? idInput(params.get('classId'))
      : '';
    // prepareStudentCards juga memakai studentId tunggal.
    const studentIdsParam =
      params.get('studentIds') || params.get('studentId') || '';
    if (classId && studentIdsParam) {
      fail('INVALID_ARGUMENT', 'Pilih kelas atau siswa individual, bukan keduanya.');
    }

    let students;
    let classNameById = new Map();
    if (classId) {
      // Cakupan: admin semua kelas; guru hanya kelas yang bisa diakses.
      if (!isAdmin(profile)) {
        const allowed = await getAccessibleClassIds(supabase, profile);
        if (!allowed.includes(classId)) {
          fail('FORBIDDEN', 'Kelas tidak tersedia untuk akun ini.');
        }
      }
      const { data: kelas, error: kErr } = await supabase
        .from('kelas')
        .select('id, nama, aktif')
        .eq('id', classId)
        .maybeSingle();
      if (kErr) fail('INTERNAL', 'Gagal membaca data kelas.');
      if (!kelas) fail('NOT_FOUND', 'Kelas tidak ditemukan.');
      if (kelas.aktif === false && !isAdmin(profile)) {
        fail('FORBIDDEN', 'Kelas tidak tersedia untuk akun ini.');
      }
      students = await getClassRoster(supabase, classId);
      classNameById.set(classId, kelas.nama);
    } else {
      if (!studentIdsParam) {
        fail('INVALID_ARGUMENT', 'Pilih satu kelas atau 1–500 siswa.');
      }
      const ids = [...new Set(studentIdsParam.split(',').map((s) => s.trim()).filter(Boolean))];
      if (!ids.length || ids.length > 500) {
        fail('INVALID_ARGUMENT', 'Pilih 1–500 siswa atau satu kelas.');
      }
      ids.forEach((id) => idInput(id));
      const { data: rows, error } = await supabase
        .from('siswa')
        .select('id, nama, nis, nisn, aktif')
        .in('id', ids);
      if (error) fail('INTERNAL', 'Gagal membaca data siswa.');
      const { data: memberships } = await supabase
        .from('keanggotaan_kelas')
        .select('siswa_id, kelas_id')
        .in('siswa_id', ids)
        .eq('aktif', true);
      const { data: kelasRows } = await supabase
        .from('kelas')
        .select('id, nama');
      classNameById = new Map((kelasRows || []).map((k) => [k.id, k.nama]));
      const allowed = isAdmin(profile)
        ? null
        : new Set(await getAccessibleClassIds(supabase, profile));
      const membershipById = new Map();
      (memberships || []).forEach((m) => {
        if (!membershipById.has(m.siswa_id)) membershipById.set(m.siswa_id, []);
        membershipById.get(m.siswa_id).push(m.kelas_id);
      });
      const { data: profiles } = await supabase
        .from('profil_siswa')
        .select('siswa_id, wali_nama, wali_telepon, wali_hubungan, foto_url, qr_token')
        .in('siswa_id', ids);
      const profileById = new Map((profiles || []).map((p) => [p.siswa_id, p]));
      students = (rows || []).map((row) => {
        const p = profileById.get(row.id);
        return {
          id: row.id,
          name: row.nama,
          nis: String(row.nis),
          nisn: row.nisn ? String(row.nisn) : '',
          active: row.aktif !== false,
          classIds: membershipById.get(row.id) || [],
          guardianName: p?.wali_nama || '',
          guardianPhone: p?.wali_telepon || '',
          guardianRelation: p?.wali_hubungan || '',
          photo: p?.foto_url || '',
          qrToken: p?.qr_token || '',
        };
      });
      const inScope = students.filter((s) => {
        if (!s.active) return false;
        if (allowed === null) return s.classIds.length > 0;
        return s.classIds.some((c) => allowed.has(c));
      });
      if (inScope.length !== ids.length) {
        fail('FORBIDDEN', 'Siswa harus aktif dan berada di kelas yang dapat diakses.');
      }
      students = inScope;
    }

    if (!students.length || students.length > 500) {
      fail('INVALID_ARGUMENT', 'Tidak ada siswa aktif atau jumlah kartu melebihi 500.');
    }

    // Buat qr_token (UUID) bagi siswa yang belum punya — token lama
    // dipertahankan. Penulisan memakai service client agar pembuatan token
    // tidak bergantung pada kebijakan RLS profil_siswa; otorisasi +
    // cakupan sudah diperiksa di atas.
    const service = createServiceClient();
    const { data: existingProfiles } = await service
      .from('profil_siswa')
      .select('siswa_id, wali_nama, wali_telepon, wali_hubungan, foto_url, qr_token')
      .in('siswa_id', students.map((s) => s.id));
    const profileById = new Map(
      (existingProfiles || []).map((p) => [p.siswa_id, p])
    );
    const tokens = new Set(
      (existingProfiles || []).map((p) => p.qr_token).filter(Boolean)
    );
    let issued = 0;
    for (const student of students) {
      const existing = profileById.get(student.id);
      if (existing?.qr_token) continue;
      let token = randomUUID();
      while (tokens.has(token)) token = randomUUID();
      tokens.add(token);
      const { error } = await service.from('profil_siswa').upsert(
        {
          siswa_id: student.id,
          wali_nama: existing?.wali_nama || '',
          wali_telepon: existing?.wali_telepon || '',
          wali_hubungan: existing?.wali_hubungan || '',
          foto_url: existing?.foto_url || '',
          qr_token: token,
        },
        { onConflict: 'siswa_id' }
      );
      if (error) fail('INTERNAL', 'Gagal membuat token QR kartu.');
      profileById.set(student.id, { ...existing, qr_token: token });
      issued += 1;
    }
    if (issued) {
      await writeAudit({
        actorId: profile.id,
        action: 'ISSUE_STUDENT_CARDS',
        entity: 'ProfilSiswa',
        entityId: 'batch',
      });
    }

    const { data: settings } = await supabase
      .from('pengaturan')
      .select('key, value');
    const byKey = new Map((settings || []).map((r) => [r.key, r.value ?? '']));
    const school = {
      name: byKey.get('school_name') || 'SIA Sekolah',
      logo: byKey.get('school_logo') || '',
      address: byKey.get('school_address') || '',
      identity: byKey.get('school_identity') || '',
      semester: byKey.get('semester_label') || 'Semester aktif',
    };

    const cards = students.map((student) => {
      const prof = profileById.get(student.id);
      return {
        id: student.id,
        name: student.name,
        nis: student.nis,
        nisn: student.nisn || '',
        photo: prof?.foto_url || student.photo || '',
        className: student.classIds
          .map((c) => classNameById.get(c))
          .filter(Boolean)
          .join(', '),
        qr: `SIA-ID:1:${prof?.qr_token || ''}`,
      };
    });
    return ok({ school, cards });
  } catch (error) {
    return handleError(error);
  }
}
