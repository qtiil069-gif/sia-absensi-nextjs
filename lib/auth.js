import { fail, computeRevision } from './validation';

/**
 * Otorisasi server — porting 20_Auth.gs (authorize_) + 10_Sheets.gs (classes_).
 *
 * Peran (sama seperti GAS):
 *   ADMIN_KEPALA_SEKOLAH — admin, akses semua kelas/siswa.
 *   GURU                  — hanya kelas yang dia walikan atau ditugaskan
 *                           via penugasan_guru aktif.
 * Alias 'ADMIN' diterima sebagai ADMIN_KEPALA_SEKOLAH (bila tim skema
 * memakai nama peran yang lebih pendek); peran lain ditolak.
 *
 * ASUMSI SKEMA (selaraskan dengan tim migrasi — supabase/migrations masih
 * kosong saat file ini ditulis):
 *   public.profiles: id (uuid, = auth.users.id), nama, role, aktif
 *   public.kelas: id, nama, tingkat, tahun_ajaran_id, wali_user_id, aktif
 *   public.penugasan_guru: id, user_id, kelas_id, mapel_id, aktif
 */

export const ROLE_ADMIN = 'ADMIN_KEPALA_SEKOLAH';
export const ROLE_TEACHER = 'GURU';

export function normalizeRole(role) {
  if (role === 'ADMIN' || role === 'ADMIN_KEPALA_SEKOLAH') return ROLE_ADMIN;
  if (role === 'GURU') return ROLE_TEACHER;
  return role;
}

export function isAdmin(profile) {
  return !!profile && normalizeRole(profile.role) === ROLE_ADMIN;
}

/**
 * Ambil user Supabase Auth dari cookie + baris public.profiles-nya.
 * @returns {{ user, profile }}
 * @throws 401 bila belum login, 403 bila profil tidak ada / nonaktif /
 *         role tidak diizinkan. Role/pencatat TIDAK PERNAH diambil dari
 *         input klien — selalu dari server.
 */
export async function getCurrentProfile(supabase) {
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();
  if (error || !user) {
    fail('UNAUTHENTICATED', 'Anda belum masuk. Silakan masuk kembali.');
  }

  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('id, nama, role, aktif')
    .eq('id', user.id)
    .maybeSingle();

  if (profileError) {
    fail('INTERNAL', 'Gagal membaca profil pengguna.');
  }
  if (!profile) {
    fail('FORBIDDEN', 'Akun belum terdaftar. Hubungi administrator.');
  }
  if (profile.aktif === false) {
    fail('FORBIDDEN', 'Akun tidak aktif. Hubungi administrator.');
  }
  const role = normalizeRole(profile.role);
  if (role !== ROLE_ADMIN && role !== ROLE_TEACHER) {
    fail('FORBIDDEN', 'Role akun tidak diizinkan. Hubungi administrator.');
  }
  return { user, profile: { ...profile, role } };
}

/** Batasi handler hanya untuk peran tertentu; bila tidak cocok → 403. */
export function requireRole(profile, ...roles) {
  const allowed = roles.map(normalizeRole);
  if (!profile || !allowed.includes(normalizeRole(profile.role))) {
    fail('FORBIDDEN', 'Anda tidak memiliki akses untuk tindakan ini.');
  }
  return profile;
}

/**
 * Daftar ID kelas yang boleh diakses user.
 * Admin → null (artinya "semua kelas", tanpa perlu enumerasi).
 * Guru   → kelas aktif yang dia walikan ATAU punya penugasan_guru aktif.
 */
export async function getAccessibleClassIds(supabase, profile) {
  if (isAdmin(profile)) return null;

  const { data: classes, error } = await supabase
    .from('kelas')
    .select('id')
    .eq('aktif', true)
    .or(`wali_user_id.eq.${profile.id}`);
  if (error) fail('INTERNAL', 'Gagal membaca daftar kelas.');

  const ids = new Set((classes || []).map((c) => c.id));

  const { data: assignments, error: assignError } = await supabase
    .from('penugasan_guru')
    .select('kelas_id')
    .eq('user_id', profile.id)
    .eq('aktif', true);
  if (assignError) fail('INTERNAL', 'Gagal membaca penugasan guru.');
  (assignments || []).forEach((a) => ids.add(a.kelas_id));

  return [...ids];
}

/**
 * Apakah profil boleh mengakses kelas ini?
 * Admin: semua kelas (aktif maupun nonaktif).
 * Guru: hanya kelas aktif yang dia walikan / ditugaskan.
 */
export async function canAccessClass(supabase, profile, classId) {
  if (!classId) return false;
  if (isAdmin(profile)) return true;
  const ids = await getAccessibleClassIds(supabase, profile);
  return ids.includes(classId);
}

/**
 * Seperti canAccessClass, tapi melempar 403 bila tidak boleh.
 * Juga memastikan kelasnya ada (404 bila tidak ada — admin) dan aktif
 * untuk guru. Dipakai semua route yang menerima classId dari klien.
 */
export async function requireClassAccess(supabase, profile, classId) {
  if (!classId) fail('INVALID_ARGUMENT', 'ID kelas wajib diisi.');
  const { data: kelas, error } = await supabase
    .from('kelas')
    .select('id, aktif')
    .eq('id', classId)
    .maybeSingle();
  if (error) fail('INTERNAL', 'Gagal membaca data kelas.');
  if (!kelas) fail('NOT_FOUND', 'Kelas tidak ditemukan.');
  if (isAdmin(profile)) return kelas;
  if (!kelas.aktif) {
    fail('FORBIDDEN', 'Kelas tidak tersedia untuk akun ini.');
  }
  const allowed = await canAccessClass(supabase, profile, classId);
  if (!allowed) {
    fail('FORBIDDEN', 'Kelas tidak tersedia untuk akun ini.');
  }
  return kelas;
}

/**
 * Untuk sesi MAPEL, guru wajib punya penugasan aktif (user + kelas + mapel).
 * Admin bebas semua mapel aktif. Porting attendanceKey_() di 23_Attendance.gs.
 */
export async function requireSubjectAccess(supabase, profile, classId, subjectId) {
  const { data: mapel, error } = await supabase
    .from('mapel')
    .select('id, aktif')
    .eq('id', subjectId)
    .maybeSingle();
  if (error) fail('INTERNAL', 'Gagal membaca data mata pelajaran.');
  if (!mapel) fail('NOT_FOUND', 'Mata pelajaran tidak ditemukan.');
  if (!mapel.aktif) {
    fail('INVALID_ARGUMENT', 'Mata pelajaran harus aktif.');
  }
  if (isAdmin(profile)) return mapel;
  const { data: assignment, error: assignError } = await supabase
    .from('penugasan_guru')
    .select('id')
    .eq('user_id', profile.id)
    .eq('kelas_id', classId)
    .eq('mapel_id', subjectId)
    .eq('aktif', true)
    .maybeSingle();
  if (assignError) fail('INTERNAL', 'Gagal membaca penugasan guru.');
  if (!assignment) {
    fail(
      'FORBIDDEN',
      'Mata pelajaran tidak ditugaskan kepada akun ini pada kelas tersebut.'
    );
  }
  return mapel;
}

// ---------------------------------------------------------------------------
// Pembantu data (DTO / roster) — padanan classes_() & students_() GAS.
// ---------------------------------------------------------------------------

/** DTO kelas untuk API (nama field mengikuti kontrak frontend). */
export function classDto(row) {
  return {
    id: row.id,
    name: row.nama,
    level: row.tingkat,
    yearId: row.tahun_ajaran_id,
    homeroomId: row.wali_user_id || '',
    active: row.aktif !== false,
  };
}

/**
 * Roster siswa aktif sebuah kelas, lengkap dengan classIds dan profil.
 * Mengembalikan array { id, name, nis, nisn, active, classIds,
 * guardianName, guardianPhone, guardianRelation, photo, qrToken }.
 * Siswa tanpa keanggotaan aktif di kelas ini tidak masuk roster.
 */
export async function getClassRoster(supabase, classId) {
  const { data: memberships, error: mErr } = await supabase
    .from('keanggotaan_kelas')
    .select('siswa_id')
    .eq('kelas_id', classId)
    .eq('aktif', true);
  if (mErr) fail('INTERNAL', 'Gagal membaca keanggotaan kelas.');
  const ids = (memberships || []).map((m) => m.siswa_id);
  if (!ids.length) return [];

  const { data: students, error: sErr } = await supabase
    .from('siswa')
    .select('id, nama, nis, nisn, aktif')
    .in('id', ids)
    .eq('aktif', true)
    .order('nama', { ascending: true });
  if (sErr) fail('INTERNAL', 'Gagal membaca data siswa.');

  const { data: allMemberships } = await supabase
    .from('keanggotaan_kelas')
    .select('siswa_id, kelas_id')
    .in('siswa_id', ids)
    .eq('aktif', true);

  const { data: profiles } = await supabase
    .from('profil_siswa')
    .select('siswa_id, wali_nama, wali_telepon, wali_hubungan, foto_url, qr_token')
    .in('siswa_id', ids);
  const profileById = new Map((profiles || []).map((p) => [p.siswa_id, p]));

  return (students || []).map((row) => {
    const profile = profileById.get(row.id);
    return {
      id: row.id,
      name: row.nama,
      nis: String(row.nis),
      nisn: row.nisn ? String(row.nisn) : '',
      active: row.aktif !== false,
      classIds: (allMemberships || [])
        .filter((m) => m.siswa_id === row.id)
        .map((m) => m.kelas_id),
      guardianName: profile?.wali_nama || '',
      guardianPhone: profile?.wali_telepon
        ? String(profile.wali_telepon).replace(/^'(?=\+)/, '')
        : '',
      guardianRelation: profile?.wali_hubungan || '',
      photo: profile?.foto_url || '',
      qrToken: profile?.qr_token || '',
    };
  });
}

/**
 * DTO siswa (porting studentDto_ di 22_Students.gs).
 * Admin menerima nisn + revision; guru hanya data dalam cakupannya.
 */
export function studentDto(row, classIds, profile, detailed) {
  const dto = {
    id: row.id,
    name: row.nama,
    nis: String(row.nis),
    active: row.aktif !== false,
    classIds: classIds || [],
    guardianName: profile?.wali_nama || '',
    guardianPhone: profile?.wali_telepon
      ? String(profile.wali_telepon).replace(/^'(?=\+)/, '')
      : '',
    guardianRelation: profile?.wali_hubungan || '',
    photo: profile?.foto_url || '',
  };
  if (detailed) {
    dto.nisn = row.nisn ? String(row.nisn) : '';
    dto.revision = computeRevision([
      { id: row.id, nama: row.nama, nis: row.nis, nisn: row.nisn, aktif: row.aktif },
      [...(classIds || [])].sort(),
      profile
        ? {
            wali_nama: profile.wali_nama,
            wali_telepon: profile.wali_telepon,
            wali_hubungan: profile.wali_hubungan,
            foto_url: profile.foto_url,
            qr_token: profile.qr_token,
          }
        : null,
    ]);
  }
  return dto;
}
