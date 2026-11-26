import { createClient } from '@/lib/supabase/server';
import {
  getCurrentProfile,
  isAdmin,
  requireClassAccess,
  requireSubjectAccess,
  getClassRoster,
} from '@/lib/auth';
import {
  ok,
  fail,
  handleError,
  parseJsonBody,
  rejectUnknownFields,
  idInput,
  dateInput,
  kindInput,
  statusInput,
  textInput,
  computeRevision,
  checkRevision,
} from '@/lib/validation';
import { writeAudit } from '@/lib/audit';

/**
 * Absensi manual — porting 23_Attendance.gs (getAttendance_/saveAttendance_).
 *
 * ASUMSI SKEMA:
 *   sesi_absensi: id, kelas_id, tanggal, jenis ('HARIAN'|'MAPEL'),
 *     mapel_id (null untuk HARIAN), created_by, created_at.
 *     Unik (kelas_id, tanggal, jenis, mapel_id) — satu sesi MAPEL per
 *     mapel per hari; belum ada slot jam (sesuai kontrak tahap 2).
 *   absensi: id, sesi_id, siswa_id, status ('H'|'S'|'I'|'A'), catatan,
 *     recorded_by, updated_at. Unik (sesi_id, siswa_id).
 *
 * Aturan yang ditegakkan:
 * - GET mengembalikan roster aktif + sesi (bila ada) + ringkasan + revision.
 * - POST wajib seluruh roster aktif (1–500), tanpa duplikat/siswa asing/
 *   status kosong; catatan maks 500 karakter.
 * - expectedRevision wajib dan harus cocok → bila tidak, 409 CONFLICT
 *   (tolak overwrite buta; muat ulang dulu).
 * - Sesi dibuat bila belum ada; duplikat sesi bersamaan → 409.
 * - Kelas nonaktif tidak bisa dipakai untuk pencatatan baru; guru MAPEL
 *   wajib punya penugasan mapel yang cocok.
 */

async function loadSession(supabase, key) {
  let query = supabase
    .from('sesi_absensi')
    .select('id, kelas_id, tanggal, jenis, mapel_id, created_by, created_at')
    .eq('kelas_id', key.classId)
    .eq('tanggal', key.date)
    .eq('jenis', key.kind);
  query = key.kind === 'HARIAN'
    ? query.is('mapel_id', null)
    : query.eq('mapel_id', key.subjectId);
  const { data, error } = await query;
  if (error) fail('INTERNAL', 'Gagal membaca sesi absensi.');
  if ((data || []).length > 1) {
    fail('DATA_INVALID', 'Sesi kelas, tanggal, jenis, dan mapel duplikat. Hubungi administrator.');
  }
  return data?.[0] || null;
}

async function loadState(supabase, key) {
  const session = await loadSession(supabase, key);
  let records = [];
  if (session) {
    const { data, error } = await supabase
      .from('absensi')
      .select('id, sesi_id, siswa_id, status, catatan')
      .eq('sesi_id', session.id);
    if (error) fail('INTERNAL', 'Gagal membaca catatan absensi.');
    records = data || [];
    const seen = new Set();
    for (const r of records) {
      if (!r.id || !r.siswa_id || seen.has(r.siswa_id) || !['H', 'S', 'I', 'A'].includes(r.status)) {
        fail('DATA_INVALID', 'ID/status absensi tidak valid atau siswa-sesi duplikat.');
      }
      seen.add(r.siswa_id);
    }
  }

  const roster = await getClassRoster(supabase, key.classId);
  const byStudent = new Map(records.map((r) => [r.siswa_id, r]));
  const summary = { H: 0, S: 0, I: 0, A: 0, pending: 0 };
  const entries = roster.map((student) => {
    const row = byStudent.get(student.id);
    summary[row ? row.status : 'pending'] += 1;
    return {
      studentId: student.id,
      name: student.name,
      nis: student.nis,
      status: row ? row.status : null,
      note: row ? String(row.catatan || '') : '',
    };
  });
  const retainedCount = records.filter(
    (r) => !roster.some((s) => s.id === r.siswa_id)
  ).length;

  const dto = {
    classId: key.classId,
    date: key.date,
    kind: key.kind,
    jenis: key.kind, // frontend memakai nama "jenis" (selectionMatches)
    subjectId: key.subjectId,
    sessionId: session ? session.id : null,
    entries,
    summary,
    retainedCount,
    revision: computeRevision([
      key,
      session,
      records,
      roster.map((r) => r.id).sort(),
    ]),
  };
  return { dto, session, records: byStudent, key };
}

/** Validasi kunci sesi (kelas/tanggal/jenis/mapel) + cakupan akun.
 *  Menerima "jenis" (dipakai frontend) maupun "kind" (kontrak task). */
async function parseAttendanceKey(supabase, profile, input) {
  const classId = idInput(input.classId);
  await requireClassAccess(supabase, profile, classId);
  const date = dateInput(input.date);
  const kind = kindInput(input.kind ?? input.jenis);
  const subjectId = input.subjectId ? idInput(input.subjectId) : '';
  if (kind === 'HARIAN' && subjectId) {
    fail('INVALID_ARGUMENT', 'Sesi harian tidak memakai mata pelajaran.');
  }
  if (kind === 'MAPEL') {
    if (!subjectId) {
      fail('INVALID_ARGUMENT', 'Sesi mapel wajib memilih mata pelajaran.');
    }
    await requireSubjectAccess(supabase, profile, classId, subjectId);
  }
  return { classId, date, kind, subjectId };
}

/**
 * GET /api/attendance?classId=&date=&jenis=HARIAN&subjectId=
 * Roster + sesi + ringkasan + revision (untuk expectedRevision saat simpan).
 * Dengan ?options=1 mengembalikan { subjects: [{ id, name }] } untuk
 * getAttendanceOptions (guru hanya mapel yang ditugaskan padanya).
 */
export async function GET(request) {
  try {
    const supabase = createClient();
    const { profile } = await getCurrentProfile(supabase);
    const params = new URL(request.url).searchParams;

    if (params.get('options') === '1') {
      const classId = idInput(params.get('classId'));
      await requireClassAccess(supabase, profile, classId);
      let assigned = null;
      if (!isAdmin(profile)) {
        const { data, error } = await supabase
          .from('penugasan_guru')
          .select('mapel_id')
          .eq('user_id', profile.id)
          .eq('kelas_id', classId)
          .eq('aktif', true);
        if (error) fail('INTERNAL', 'Gagal membaca penugasan guru.');
        assigned = (data || []).map((r) => r.mapel_id);
      }
      let query = supabase
        .from('mapel')
        .select('id, nama')
        .eq('aktif', true)
        .order('nama', { ascending: true });
      if (assigned) query = query.in('id', assigned.length ? assigned : ['__none__']);
      const { data, error } = await query;
      if (error) fail('INTERNAL', 'Gagal membaca mata pelajaran.');
      return ok({
        subjects: (data || []).map((r) => ({ id: r.id, name: r.nama })),
      });
    }

    const key = await parseAttendanceKey(supabase, profile, {
      classId: params.get('classId'),
      date: params.get('date'),
      kind: params.get('kind') || undefined,
      jenis: params.get('jenis') || undefined,
      subjectId: params.get('subjectId') || undefined,
    });
    const { dto } = await loadState(supabase, key);
    return ok(dto);
  } catch (error) {
    return handleError(error);
  }
}

/**
 * POST /api/attendance — simpan satu sesi absensi.
 * Body: { classId, date, kind?, subjectId?, expectedRevision,
 *         entries: [{ studentId, status, note? }] }.
 */
export async function POST(request) {
  try {
    const supabase = createClient();
    const { profile } = await getCurrentProfile(supabase);
    const body = await parseJsonBody(request);
    rejectUnknownFields(body, [
      'classId', 'date', 'kind', 'jenis', 'subjectId', 'expectedRevision', 'entries',
    ]);
    const key = await parseAttendanceKey(supabase, profile, body);

    // Kelas nonaktif tidak dapat dipakai untuk pencatatan baru.
    const { data: kelas } = await supabase
      .from('kelas')
      .select('aktif')
      .eq('id', key.classId)
      .maybeSingle();
    if (kelas && kelas.aktif === false) {
      fail('INVALID_ARGUMENT', 'Kelas nonaktif tidak dapat dipakai untuk pencatatan absensi baru.');
    }

    const state = await loadState(supabase, key);
    checkRevision(body.expectedRevision, state.dto.revision);

    if (
      !Array.isArray(body.entries) ||
      !body.entries.length ||
      body.entries.length > 500 ||
      body.entries.length !== state.dto.entries.length
    ) {
      fail(
        'INVALID_ARGUMENT',
        'Isi absensi seluruh siswa aktif (maksimal 500) pada kelas dan sesi yang dipilih.'
      );
    }
    const allowed = new Set(state.dto.entries.map((e) => e.studentId));
    const seen = new Set();
    const cleaned = body.entries.map((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        fail('INVALID_ARGUMENT', 'Format entri absensi tidak valid.');
      }
      rejectUnknownFields(entry, ['studentId', 'status', 'note']);
      const id = idInput(entry.studentId);
      if (!allowed.has(id) || seen.has(id)) {
        fail(
          'INVALID_ARGUMENT',
          'Siswa tidak terdaftar aktif pada kelas atau tercantum lebih dari sekali.'
        );
      }
      seen.add(id);
      return {
        id,
        status: statusInput(entry.status),
        note: textInput(entry.note, 'Catatan', 500, true, true),
      };
    });

    const now = new Date().toISOString();
    let sessionId = state.session ? state.session.id : null;
    if (!sessionId) {
      const { data: session, error: sErr } = await supabase
        .from('sesi_absensi')
        .insert({
          kelas_id: key.classId,
          tanggal: key.date,
          jenis: key.kind,
          mapel_id: key.kind === 'MAPEL' ? key.subjectId : null,
          created_by: profile.id,
        })
        .select('id')
        .single();
      if (sErr) {
        if (sErr.code === '23505') {
          fail(
            'CONFLICT',
            'Sesi sudah dibuat bersamaan oleh pengguna lain. Muat ulang dan periksa sebelum menyimpan kembali.'
          );
        }
        fail('INTERNAL', 'Gagal membuat sesi absensi.');
      }
      sessionId = session.id;
    }

    for (const entry of cleaned) {
      const existing = state.records.get(entry.id);
      const row = {
        sesi_id: sessionId,
        siswa_id: entry.id,
        status: entry.status,
        catatan: entry.note,
        recorded_by: profile.id,
        updated_at: now,
      };
      const { error } = existing
        ? await supabase.from('absensi').update(row).eq('id', existing.id)
        : await supabase.from('absensi').insert(row);
      if (error) {
        if (error.code === '23505') {
          fail(
            'CONFLICT',
            'Catatan absensi sudah berubah bersamaan. Muat ulang dan periksa sebelum menyimpan kembali.'
          );
        }
        fail('INTERNAL', 'Gagal menyimpan absensi.');
      }
    }

    await writeAudit({
      actorId: profile.id,
      action: state.session ? 'UPDATE_ATTENDANCE' : 'CREATE_ATTENDANCE',
      entity: 'SesiAbsensi',
      entityId: sessionId,
    });

    const fresh = await loadState(supabase, key);
    return ok(fresh.dto);
  } catch (error) {
    return handleError(error);
  }
}
