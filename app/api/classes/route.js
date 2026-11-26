import { createClient } from '@/lib/supabase/server';
import {
  getCurrentProfile,
  isAdmin,
  requireRole,
  getAccessibleClassIds,
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
  statusFilterInput,
  searchInput,
  computeRevision,
} from '@/lib/validation';
import { writeAudit } from '@/lib/audit';

/**
 * GET /api/classes — daftar kelas.
 * Query: q (cari nama), status=active|inactive|all (nonaktif hanya admin),
 * yearId, level (1–12). Guru hanya menerima kelas aktif yang dia walikan /
 * ditugaskan. Porting listClasses / queryClasses_ (21_Classes.gs).
 */
export async function GET(request) {
  try {
    const supabase = createClient();
    const { profile } = await getCurrentProfile(supabase);
    const params = new URL(request.url).searchParams;
    const status = statusFilterInput(params.get('status'), isAdmin(profile));
    const q = searchInput(params.get('q') || '');
    const yearId = params.get('yearId')
      ? idInput(params.get('yearId'))
      : '';
    const levelRaw = params.get('level') || '';
    if (levelRaw && !/^(?:[1-9]|1[0-2])$/.test(levelRaw)) {
      fail('INVALID_ARGUMENT', 'Tingkat harus 1–12.');
    }

    let query = supabase
      .from('kelas')
      .select('id, nama, tingkat, tahun_ajaran_id, wali_user_id, aktif')
      .order('nama', { ascending: true });
    if (status === 'active') query = query.eq('aktif', true);
    if (status === 'inactive') query = query.eq('aktif', false);
    if (yearId) query = query.eq('tahun_ajaran_id', yearId);
    if (levelRaw) query = query.eq('tingkat', Number(levelRaw));
    if (q) query = query.ilike('nama', `%${q}%`);

    const { data, error } = await query;
    if (error) fail('INTERNAL', 'Gagal membaca daftar kelas.');

    let rows = data || [];
    if (!isAdmin(profile)) {
      // Guru: hanya kelas aktif dalam cakupannya (wali / penugasan).
      const allowed = new Set(await getAccessibleClassIds(supabase, profile));
      rows = rows.filter((r) => r.aktif !== false && allowed.has(r.id));
    }
    const items = rows.map((r) => ({
      ...classDto(r),
      revision: computeRevision([
        r.id, r.nama, r.tingkat, r.tahun_ajaran_id, r.wali_user_id, r.aktif,
      ]),
    }));
    // ?meta=1: sertakan metadata form (tahun ajaran + daftar wali) seperti
    // getRosterOptions GAS. Tanpa meta, respons tetap array (dipakai
    // listClasses di halaman). Meta hanya diisi penuh untuk Admin.
    if (params.get('meta') === '1') {
      let years = [];
      let teachers = [];
      if (isAdmin(profile)) {
        const { data: yearRows } = await supabase
          .from('tahun_ajaran')
          .select('id, nama, aktif')
          .order('nama', { ascending: true });
        years = (yearRows || []).map((y) => ({
          id: y.id, name: y.nama, active: y.aktif !== false,
        }));
        const { data: teacherRows } = await supabase
          .from('profiles')
          .select('id, nama')
          .eq('aktif', true)
          .order('nama', { ascending: true });
        teachers = (teacherRows || []).map((t) => ({ id: t.id, name: t.nama }));
      }
      return ok({ items, meta: { years, teachers } });
    }
    return ok(items);
  } catch (error) {
    return handleError(error);
  }
}

/**
 * POST /api/classes — tambah kelas. Khusus Admin.
 * Body: { name, level (1–12), yearId, homeroomId? }.
 * Aturan GAS: nama unik per tahun ajaran (termasuk kelas nonaktif),
 * tahun tujuan harus aktif, wali harus akun aktif ber-role GURU/ADMIN.
 */
export async function POST(request) {
  try {
    const supabase = createClient();
    const { profile } = await getCurrentProfile(supabase);
    requireRole(profile, 'ADMIN_KEPALA_SEKOLAH');
    const body = await parseJsonBody(request);
    rejectUnknownFields(body, ['name', 'level', 'yearId', 'homeroomId']);

    const name = textInput(body.name, 'Nama kelas', 60);
    const yearId = idInput(body.yearId);
    const level = levelInput(body.level);
    const homeroomId = body.homeroomId ? idInput(body.homeroomId) : '';

    const { data: year, error: yearErr } = await supabase
      .from('tahun_ajaran')
      .select('id, aktif')
      .eq('id', yearId)
      .maybeSingle();
    if (yearErr) fail('INTERNAL', 'Gagal membaca tahun ajaran.');
    if (!year) fail('NOT_FOUND', 'Tahun ajaran tidak ditemukan.');
    if (year.aktif === false) {
      fail('INVALID_ARGUMENT', 'Tahun ajaran tidak aktif.');
    }

    if (homeroomId) {
      const { data: teacher, error: tErr } = await supabase
        .from('profiles')
        .select('id, role, aktif')
        .eq('id', homeroomId)
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

    // Nama unik per tahun (case-insensitive, termasuk nonaktif).
    const { data: siblings, error: sErr } = await supabase
      .from('kelas')
      .select('nama')
      .eq('tahun_ajaran_id', yearId);
    if (sErr) fail('INTERNAL', 'Gagal memeriksa nama kelas.');
    if (
      (siblings || []).some(
        (r) => String(r.nama).trim().toLocaleLowerCase() === name.toLocaleLowerCase()
      )
    ) {
      fail(
        'DUPLICATE',
        'Nama kelas sudah dipakai pada tahun ajaran tersebut, termasuk kelas nonaktif.'
      );
    }

    const { data: created, error } = await supabase
      .from('kelas')
      .insert({
        nama: name,
        tingkat: level,
        tahun_ajaran_id: yearId,
        wali_user_id: homeroomId || null,
        aktif: true,
      })
      .select('id, nama, tingkat, tahun_ajaran_id, wali_user_id, aktif')
      .single();
    if (error) {
      if (error.code === '23505') {
        fail(
          'DUPLICATE',
          'Nama kelas sudah dipakai pada tahun ajaran tersebut, termasuk kelas nonaktif.'
        );
      }
      fail('INTERNAL', 'Gagal menyimpan kelas.');
    }

    await writeAudit({
      actorId: profile.id,
      action: 'CREATE_CLASS',
      entity: 'Kelas',
      entityId: created.id,
    });
    return ok(
      {
        ...classDto(created),
        revision: computeRevision([
          created.id, created.nama, created.tingkat, created.tahun_ajaran_id,
          created.wali_user_id, created.aktif,
        ]),
      },
      201
    );
  } catch (error) {
    return handleError(error);
  }
}
