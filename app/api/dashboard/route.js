import { createClient } from '@/lib/supabase/server';
import {
  getCurrentProfile,
  isAdmin,
  getAccessibleClassIds,
} from '@/lib/auth';
import {
  ok,
  fail,
  handleError,
  dateInput,
  todayJakarta,
  idInput,
} from '@/lib/validation';

/**
 * GET /api/dashboard?date=&classId=
 * Porting dashboard_() di 30_Dashboard.gs.
 * Mengembalikan: tanggal, cakupan, stats { students, classes,
 * attendanceRate, sessions, journals }, composition (ringkasan hari itu),
 * weekly (7 hari Senin–Minggu: { date, rate, total }).
 * rate = null bila tanpa catatan. Guru hanya melihat kelas dalam
 * cakupannya; classId di luar cakupan → 403.
 */
export async function GET(request) {
  try {
    const supabase = createClient();
    const { profile } = await getCurrentProfile(supabase);
    const params = new URL(request.url).searchParams;
    const date = dateInput(params.get('date') || todayJakarta());
    const classId = params.get('classId') ? idInput(params.get('classId')) : '';

    const accessible = await getAccessibleClassIds(supabase, profile);
    if (classId && !isAdmin(profile) && !accessible.includes(classId)) {
      fail('FORBIDDEN', 'Kelas tidak tersedia untuk akun ini.');
    }

    let classQuery = supabase
      .from('kelas')
      .select('id')
      .eq('aktif', true);
    if (classId) classQuery = classQuery.eq('id', classId);
    if (!isAdmin(profile)) classQuery = classQuery.in('id', accessible);
    const { data: classes, error: cErr } = await classQuery;
    if (cErr) fail('INTERNAL', 'Gagal membaca daftar kelas.');
    const classIds = (classes || []).map((c) => c.id);

    // Jumlah siswa aktif pada kelas dalam cakupan.
    let studentCount = 0;
    if (classIds.length) {
      const { data: memberships, error: mErr } = await supabase
        .from('keanggotaan_kelas')
        .select('siswa_id')
        .in('kelas_id', classIds)
        .eq('aktif', true);
      if (mErr) fail('INTERNAL', 'Gagal membaca keanggotaan kelas.');
      const memberIds = [...new Set((memberships || []).map((m) => m.siswa_id))];
      if (memberIds.length) {
        const { count, error: sErr } = await supabase
          .from('siswa')
          .select('id', { count: 'exact', head: true })
          .in('id', memberIds)
          .eq('aktif', true);
        if (sErr) fail('INTERNAL', 'Gagal menghitung siswa.');
        studentCount = count || 0;
      }
    }

    // Minggu berjalan (Senin–Minggu) dari tanggal yang diminta.
    const monday = new Date(`${date}T00:00:00Z`);
    monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
    const week = Array.from({ length: 7 }, (_, i) => {
      const day = new Date(monday.getTime());
      day.setUTCDate(day.getUTCDate() + i);
      return day.toISOString().slice(0, 10);
    });

    // Sesi dalam cakupan pada minggu berjalan + sesi hari ini.
    let sessions = [];
    if (classIds.length) {
      const { data, error } = await supabase
        .from('sesi_absensi')
        .select('id, kelas_id, tanggal')
        .in('kelas_id', classIds)
        .in('tanggal', week);
      if (error) fail('INTERNAL', 'Gagal membaca sesi absensi.');
      sessions = data || [];
    }
    const sessionMap = new Map(sessions.map((s) => [s.id, s]));

    let attendance = [];
    if (sessionMap.size) {
      const { data, error } = await supabase
        .from('absensi')
        .select('sesi_id, status')
        .in('sesi_id', [...sessionMap.keys()]);
      if (error) fail('INTERNAL', 'Gagal membaca catatan absensi.');
      attendance = (data || [])
        .filter((a) => ['H', 'S', 'I', 'A'].includes(a.status))
        .map((a) => ({ date: sessionMap.get(a.sesi_id).tanggal, status: a.status }));
    }

    // Sesi hari ini (semua sesi tanggal itu, bukan hanya minggu berjalan —
    // sama dengan minggu berjalan bila tanggal di dalam minggu itu).
    let sessionsToday = sessions.filter((s) => s.tanggal === date).length;
    if (!week.includes(date)) {
      const { count } = await supabase
        .from('sesi_absensi')
        .select('id', { count: 'exact', head: true })
        .in('kelas_id', classIds.length ? classIds : ['__none__'])
        .eq('tanggal', date);
      sessionsToday = count || 0;
    }

    const { count: journalsToday } = classIds.length
      ? await supabase
          .from('jurnal')
          .select('id', { count: 'exact', head: true })
          .in('kelas_id', classIds)
          .eq('tanggal', date)
      : { count: 0 };

    function summary(items) {
      const counts = { H: 0, S: 0, I: 0, A: 0 };
      items.forEach((item) => {
        counts[item.status] += 1;
      });
      return {
        counts,
        total: items.length,
        rate: items.length ? Math.round((counts.H / items.length) * 100) : null,
      };
    }

    const daily = summary(attendance.filter((a) => a.date === date));
    return ok({
      date,
      scope: isAdmin(profile) ? 'Seluruh kelas aktif' : 'Kelas penugasan Anda',
      stats: {
        students: studentCount,
        classes: classIds.length,
        attendanceRate: daily.rate,
        sessions: sessionsToday,
        journals: journalsToday || 0,
      },
      composition: daily,
      weekly: week.map((day) => {
        const result = summary(attendance.filter((a) => a.date === day));
        return { date: day, rate: result.rate, total: result.total };
      }),
    });
  } catch (error) {
    return handleError(error);
  }
}
