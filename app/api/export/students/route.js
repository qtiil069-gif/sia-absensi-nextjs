import ExcelJS from 'exceljs';
import { createClient, createServiceClient } from '@/lib/supabase/server';
import {
  getCurrentProfile,
  isAdmin,
  getAccessibleClassIds,
} from '@/lib/auth';
import {
  fail,
  handleError,
  idInput,
  searchInput,
  statusFilterInput,
} from '@/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/export/students?classId=&q=&status=
 * Unduh data siswa sebagai .xlsx — porting exportStudentData (25_CardsQr.gs).
 * Maksimal 500 siswa (lebih dari itu → 400, pakai filter kelas).
 * NIS / NISN / nomor wali ditulis sebagai TEKS (bukan angka/formula) agar
 * nol awal tidak hilang. TIDAK menyertakan token QR atau foto.
 * Pembacaan memakai service client setelah cakupan diperiksa di kode
 * (role + kelas yang boleh diakses), agar ekspor tidak bergantung pada
 * kebijakan RLS baris profil.
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

    const permitted = admin ? null : await getAccessibleClassIds(supabase, profile);
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

    const service = createServiceClient();
    let query = service
      .from('siswa')
      .select('id, nama, nis, nisn, aktif')
      .order('nama', { ascending: true });
    if (status === 'active') query = query.eq('aktif', true);
    if (status === 'inactive') query = query.eq('aktif', false);
    if (q) query = query.or(`nama.ilike.%${q}%,nis.ilike.%${q}%`);
    const { data: rows, error } = await query;
    if (error) fail('INTERNAL', 'Gagal membaca data siswa.');

    const ids = (rows || []).map((r) => r.id);
    const { data: memberships } = ids.length
      ? await service
          .from('keanggotaan_kelas')
          .select('siswa_id, kelas_id')
          .in('siswa_id', ids)
          .eq('aktif', true)
      : { data: [] };
    const { data: profiles } = ids.length
      ? await service
          .from('profil_siswa')
          .select('siswa_id, wali_nama, wali_telepon, wali_hubungan')
          .in('siswa_id', ids)
      : { data: [] };
    const { data: kelasRows } = await service
      .from('kelas')
      .select('id, nama');
    const classNameById = new Map((kelasRows || []).map((k) => [k.id, k.nama]));
    const membershipById = new Map();
    (memberships || []).forEach((m) => {
      if (!membershipById.has(m.siswa_id)) membershipById.set(m.siswa_id, []);
      membershipById.get(m.siswa_id).push(m.kelas_id);
    });
    const profileById = new Map((profiles || []).map((p) => [p.siswa_id, p]));

    let items = (rows || []).map((row) => {
      const classIds = (membershipById.get(row.id) || []).filter((c) =>
        permitted === null ? true : permitted.includes(c)
      );
      return {
        ...row,
        classIds,
        className: classIds.map((c) => classNameById.get(c)).filter(Boolean).join(', '),
        profile: profileById.get(row.id),
      };
    });
    if (!admin) {
      items = items.filter((it) => it.classIds.length > 0);
    }
    if (classId) items = items.filter((it) => it.classIds.includes(classId));
    if (items.length > 500) {
      fail('INVALID_ARGUMENT', 'Ekspor maksimal 500 siswa. Gunakan filter kelas.');
    }

    const { data: settings } = await service
      .from('pengaturan')
      .select('key, value');
    const schoolName =
      (settings || []).find((s) => s.key === 'school_name')?.value ||
      'SIA Sekolah';

    const workbook = new ExcelJS.Workbook();
    workbook.creator = schoolName;
    const sheet = workbook.addWorksheet('Siswa');
    sheet.columns = [
      { header: 'Nama', key: 'name', width: 32 },
      { header: 'NIS', key: 'nis', width: 16 },
      { header: 'NISN', key: 'nisn', width: 14 },
      { header: 'Kelas', key: 'className', width: 18 },
      { header: 'Nama Wali', key: 'guardianName', width: 28 },
      { header: 'Telepon Wali', key: 'guardianPhone', width: 18 },
      { header: 'Hubungan Wali', key: 'guardianRelation', width: 16 },
      { header: 'Status', key: 'active', width: 10 },
    ];
    sheet.getRow(1).font = { bold: true };
    for (const it of items) {
      const row = sheet.addRow({
        name: it.nama,
        nis: String(it.nis),
        nisn: it.nisn ? String(it.nisn) : '',
        className: it.className,
        guardianName: it.profile?.wali_nama || '',
        guardianPhone: it.profile?.wali_telepon
          ? String(it.profile.wali_telepon).replace(/^'(?=\+)/, '')
          : '',
        guardianRelation: it.profile?.wali_hubungan || '',
        active: it.aktif !== false ? 'Aktif' : 'Nonaktif',
      });
      // Paksa format teks untuk NIS/NISN/telepon (kolom B, C, F).
      ['B', 'C', 'F'].forEach((col) => {
        row.getCell(col).numFmt = '@';
      });
    }

    const buffer = await workbook.xlsx.writeBuffer();
    return new Response(buffer, {
      status: 200,
      headers: {
        'Content-Type':
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="data-siswa-${classId || 'semua'}.xlsx"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (error) {
    return handleError(error);
  }
}
