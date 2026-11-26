import { createClient } from '@/lib/supabase/server';
import {
  getCurrentProfile,
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
  computeRevision,
  checkRevision,
} from '@/lib/validation';
import { writeAudit } from '@/lib/audit';

/**
 * Absensi QR — porting 25_CardsQr.gs (validateQr_ / saveQr_).
 *
 * Alur dua langkah (validasi TIDAK menulis absensi):
 *  1. action:'validate' (default) — terima qr / qr_token / code, validasi
 *     token ke profil_siswa + siswa aktif + keanggotaan kelas + cakupan
 *     akun, kembalikan identitas siswa + status saat ini + expectedRevision.
 *  2. action:'confirm' — petugas menekan Konfirmasi Hadir; server
 *     memvalidasi ulang semuanya, lalu menyimpan satu catatan Hadir (H)
 *     untuk sesi hari ini. Siswa yang sudah tercatat → 409 DUPLICATE
 *     (tidak ditimpa; koreksi lewat Absensi Manual).
 *
 * Token QR: payload kartu 'SIA-ID:1:<uuid>' (tidak berisi nama/NIS/nomor
 * wali). QR adalah pengenal siswa, BUKAN autentikasi petugas.
 * Sesi dibuat bila belum ada; duplikat sesi bersamaan → muat ulang (409).
 */

function parseQrToken(value) {
  if (typeof value !== 'string' || !value.trim()) {
    fail('INVALID_ARGUMENT', 'Kode QR siswa wajib diisi.');
  }
  const raw = value.trim();
  const match = /^SIA-ID:1:([a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12})$/.exec(raw);
  if (match) return match[1];
  if (/^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$/.test(raw)) {
    return raw;
  }
  fail('INVALID_ARGUMENT', 'Format QR siswa tidak valid.');
  return '';
}

async function resolveQr(supabase, profile, input) {
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
  const key = { classId, date, kind, subjectId };
  const token = parseQrToken(input.qr ?? input.qr_token ?? input.code);

  const { data: profiles, error: pErr } = await supabase
    .from('profil_siswa')
    .select('siswa_id, foto_url, qr_token')
    .eq('qr_token', token);
  if (pErr) fail('INTERNAL', 'Gagal memvalidasi QR siswa.');
  if (!profiles || profiles.length !== 1) {
    fail('FORBIDDEN', 'QR tidak dikenal atau tidak dapat digunakan.');
  }
  const profileRow = profiles[0];

  // Sesi + catatan yang sudah ada (bila ada).
  let sessionQuery = supabase
    .from('sesi_absensi')
    .select('id, kelas_id, tanggal, jenis, mapel_id, created_by, created_at')
    .eq('kelas_id', classId)
    .eq('tanggal', date)
    .eq('jenis', kind);
  sessionQuery = kind === 'HARIAN'
    ? sessionQuery.is('mapel_id', null)
    : sessionQuery.eq('mapel_id', subjectId);
  const { data: sessions, error: sErr } = await sessionQuery;
  if (sErr) fail('INTERNAL', 'Gagal membaca sesi absensi.');
  if ((sessions || []).length > 1) {
    fail('DATA_INVALID', 'Sesi kelas, tanggal, jenis, dan mapel duplikat. Hubungi administrator.');
  }
  const session = sessions?.[0] || null;

  let records = [];
  if (session) {
    const { data, error } = await supabase
      .from('absensi')
      .select('id, siswa_id, status, catatan')
      .eq('sesi_id', session.id);
    if (error) fail('INTERNAL', 'Gagal membaca catatan absensi.');
    records = data || [];
  }

  const roster = await getClassRoster(supabase, classId);
  const student = roster.find((s) => s.id === profileRow.siswa_id);
  if (!student) {
    fail('FORBIDDEN', 'Siswa tidak aktif pada kelas dan sesi yang dipilih.');
  }
  const { data: kelas } = await supabase
    .from('kelas')
    .select('nama')
    .eq('id', classId)
    .maybeSingle();

  const existing = records.find((r) => r.siswa_id === student.id);
  const stateRevision = computeRevision([
    key,
    session,
    records,
    roster.map((r) => r.id).sort(),
  ]);
  return {
    key,
    session,
    records,
    roster,
    stateRevision,
    student: {
      id: student.id,
      name: student.name,
      nis: student.nis,
      nisn: student.nisn || '',
      photo: profileRow.foto_url || '',
      className: kelas?.nama || '',
    },
    status: existing ? existing.status : null,
  };
}

function attendanceDto(resolved) {
  const byStudent = new Map(
    resolved.records.map((r) => [r.siswa_id, r])
  );
  const summary = { H: 0, S: 0, I: 0, A: 0, pending: 0 };
  const entries = resolved.roster.map((student) => {
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
  return {
    classId: resolved.key.classId,
    date: resolved.key.date,
    kind: resolved.key.kind,
    jenis: resolved.key.kind,
    subjectId: resolved.key.subjectId,
    sessionId: resolved.session ? resolved.session.id : null,
    entries,
    summary,
    retainedCount: resolved.records.filter(
      (r) => !resolved.roster.some((s) => s.id === r.siswa_id)
    ).length,
    revision: resolved.stateRevision,
  };
}

/**
 * POST /api/attendance/qr
 * Body: { qr|qr_token|code, classId, date, kind?|jenis?, subjectId?,
 *         step?: 'validate'|'confirm', action?: 'validate'|'confirm',
 *         expectedRevision? (wajib untuk confirm) }
 * Frontend membedakan langkah lewat field "step"; "action" diterima juga.
 */
export async function POST(request) {
  try {
    const supabase = createClient();
    const { profile } = await getCurrentProfile(supabase);
    const body = await parseJsonBody(request);
    rejectUnknownFields(body, [
      'qr', 'qr_token', 'code', 'classId', 'date', 'kind', 'jenis', 'subjectId',
      'action', 'step', 'expectedRevision',
    ]);
    const action = body.step ?? body.action ?? 'validate';
    if (!['validate', 'confirm'].includes(action)) {
      fail('INVALID_ARGUMENT', 'Aksi harus validate atau confirm.');
    }

    const found = await resolveQr(supabase, profile, body);
    const expectedRevision = computeRevision([
      found.stateRevision,
      found.student,
    ]);

    if (action === 'validate') {
      return ok({
        student: found.student,
        status: found.status,
        expectedRevision,
        selection: { ...found.key, jenis: found.key.kind },
      });
    }

    // --- confirm: simpan Hadir ---
    if (found.status) {
      fail(
        'DUPLICATE',
        'Siswa sudah diabsen pada sesi ini. Gunakan Absensi Manual bila perlu koreksi.'
      );
    }
    checkRevision(body.expectedRevision, expectedRevision);

    const now = new Date().toISOString();
    let sessionId = found.session ? found.session.id : null;
    if (!sessionId) {
      const { data: session, error: sErr } = await supabase
        .from('sesi_absensi')
        .insert({
          kelas_id: found.key.classId,
          tanggal: found.key.date,
          jenis: found.key.kind,
          mapel_id: found.key.kind === 'MAPEL' ? found.key.subjectId : null,
          created_by: profile.id,
        })
        .select('id')
        .single();
      if (sErr) {
        if (sErr.code === '23505') {
          fail(
            'CONFLICT',
            'Sesi sudah dibuat bersamaan oleh pengguna lain. Pindai ulang QR siswa.'
          );
        }
        fail('INTERNAL', 'Gagal membuat sesi absensi.');
      }
      sessionId = session.id;
    }

    const { error: iErr } = await supabase.from('absensi').insert({
      sesi_id: sessionId,
      siswa_id: found.student.id,
      status: 'H',
      catatan: '',
      recorded_by: profile.id,
      updated_at: now,
    });
    if (iErr) {
      if (iErr.code === '23505') {
        fail(
          'DUPLICATE',
          'Siswa sudah diabsen pada sesi ini. Gunakan Absensi Manual bila perlu koreksi.'
        );
      }
      fail('INTERNAL', 'Gagal menyimpan kehadiran.');
    }

    await writeAudit({
      actorId: profile.id,
      action: 'QR_ATTENDANCE',
      entity: 'SesiAbsensi',
      entityId: sessionId,
    });

    // Muat ulang state agar respons berisi DTO absensi terbaru.
    const fresh = await resolveQr(supabase, profile, body);
    return ok(attendanceDto(fresh));
  } catch (error) {
    return handleError(error);
  }
}
