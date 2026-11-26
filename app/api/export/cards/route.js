import { randomUUID } from 'crypto';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import QRCode from 'qrcode';
import { createClient, createServiceClient } from '@/lib/supabase/server';
import {
  getCurrentProfile,
  isAdmin,
  getAccessibleClassIds,
  getClassRoster,
} from '@/lib/auth';
import { fail, handleError, idInput } from '@/lib/validation';
import { writeAudit } from '@/lib/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Ukuran kartu ID: 54 × 85,6 mm portrait (1 mm = 2,83465 pt). */
const CARD_W = 54 * 2.83465;
const CARD_H = 85.6 * 2.83465;

const ROYAL_BLUE = rgb(0.09, 0.26, 0.71);
const DARK_BLUE = rgb(0.05, 0.14, 0.42);
const YELLOW = rgb(0.98, 0.8, 0.12);
const WHITE = rgb(1, 1, 1);
const DARK = rgb(0.1, 0.1, 0.1);
const GREY = rgb(0.45, 0.45, 0.45);

function fitText(font, text, maxSize, maxWidth) {
  let size = maxSize;
  while (size > 6 && font.widthOfTextAtSize(text, size) > maxWidth) size -= 0.5;
  return size;
}

function truncate(font, text, size, maxWidth) {
  if (font.widthOfTextAtSize(text, size) <= maxWidth) return text;
  let out = text;
  while (out.length > 1 && font.widthOfTextAtSize(`${out}…`, size) > maxWidth) {
    out = out.slice(0, -1);
  }
  return `${out}…`;
}

/** Unduh foto dari URL (Storage) untuk ditempel ke kartu; gagal → null. */
async function fetchPhoto(pdf, url) {
  if (!url || typeof url !== 'string' || !/^https?:\/\//.test(url)) return null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const type = (res.headers.get('content-type') || '').toLowerCase();
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (type.includes('png')) return await pdf.embedPng(bytes);
    if (type.includes('jpeg') || type.includes('jpg')) return await pdf.embedJpg(bytes);
    return null;
  } catch {
    return null;
  }
}

/**
 * GET /api/export/cards?classId= — PDF kartu ID, satu kartu per halaman
 * ukuran 54 × 85,6 mm portrait (porting stage-3.md).
 * Alternatif: ?studentIds=id1,id2 (maks 500). Token QR dibuat bila belum
 * ada (tetap sama saat cetak ulang). Hanya siswa aktif dalam cakupan.
 * Foto/NISN kosong diberi penanda jelas, bukan data rekaan.
 */
export async function GET(request) {
  try {
    const supabase = createClient();
    const { profile } = await getCurrentProfile(supabase);
    const params = new URL(request.url).searchParams;
    const classId = params.get('classId')
      ? idInput(params.get('classId'))
      : '';
    const studentIdsParam = params.get('studentIds') || '';
    if (classId && studentIdsParam) {
      fail('INVALID_ARGUMENT', 'Pilih kelas atau siswa individual, bukan keduanya.');
    }
    if (!classId && !studentIdsParam) {
      fail('INVALID_ARGUMENT', 'Pilih satu kelas atau 1–500 siswa.');
    }

    let students;
    let classNameById = new Map();
    if (classId) {
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
      students = await getClassRoster(supabase, classId);
      classNameById.set(classId, kelas.nama);
    } else {
      const ids = [...new Set(studentIdsParam.split(',').map((s) => s.trim()).filter(Boolean))];
      if (!ids.length || ids.length > 500) {
        fail('INVALID_ARGUMENT', 'Pilih 1–500 siswa atau satu kelas.');
      }
      ids.forEach((id) => idInput(id));
      const allowed = isAdmin(profile)
        ? null
        : new Set(await getAccessibleClassIds(supabase, profile));
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
      const { data: profiles } = await supabase
        .from('profil_siswa')
        .select('siswa_id, wali_nama, wali_telepon, wali_hubungan, foto_url, qr_token')
        .in('siswa_id', ids);
      const profileById = new Map((profiles || []).map((p) => [p.siswa_id, p]));
      const membershipById = new Map();
      (memberships || []).forEach((m) => {
        if (!membershipById.has(m.siswa_id)) membershipById.set(m.siswa_id, []);
        membershipById.get(m.siswa_id).push(m.kelas_id);
      });
      students = (rows || [])
        .map((row) => {
          const p = profileById.get(row.id);
          return {
            id: row.id,
            name: row.nama,
            nis: String(row.nis),
            nisn: row.nisn ? String(row.nisn) : '',
            active: row.aktif !== false,
            classIds: membershipById.get(row.id) || [],
            photo: p?.foto_url || '',
            qrToken: p?.qr_token || '',
          };
        })
        .filter((s) => {
          if (!s.active) return false;
          if (allowed === null) return s.classIds.length > 0;
          return s.classIds.some((c) => allowed.has(c));
        });
      if (students.length !== ids.length) {
        fail('FORBIDDEN', 'Siswa harus aktif dan berada di kelas yang dapat diakses.');
      }
    }

    if (!students.length || students.length > 500) {
      fail('INVALID_ARGUMENT', 'Tidak ada siswa aktif atau jumlah kartu melebihi 500.');
    }

    // Token QR (service client — alasan sama seperti /api/cards).
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
          foto_url: existing?.foto_url || student.photo || '',
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
      address: byKey.get('school_address') || '',
      identity: byKey.get('school_identity') || '',
    };

    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const fontBold = await pdf.embedFont(StandardFonts.HelveticaBold);

    for (const student of students) {
      const prof = profileById.get(student.id);
      const page = pdf.addPage([CARD_W, CARD_H]);
      const margin = 8;

      // Header biru royal + garis kuning.
      page.drawRectangle({ x: 0, y: CARD_H - 26, width: CARD_W, height: 26, color: ROYAL_BLUE });
      page.drawRectangle({ x: 0, y: CARD_H - 28, width: CARD_W, height: 2, color: YELLOW });
      const schoolSize = fitText(fontBold, school.name.toUpperCase(), 9, CARD_W - margin * 2);
      page.drawText(school.name.toUpperCase(), {
        x: margin, y: CARD_H - 13, size: schoolSize, font: fontBold, color: WHITE,
      });
      page.drawText('KARTU ID SISWA', {
        x: margin, y: CARD_H - 23, size: 7, font: fontBold, color: YELLOW,
      });

      // Foto (kiri) atau penanda kosong.
      const photoBox = { x: margin, y: CARD_H - 78, w: 42, h: 48 };
      const photo = await fetchPhoto(pdf, prof?.foto_url || student.photo || '');
      if (photo) {
        page.drawImage(photo, { ...photoBox, width: photoBox.w, height: photoBox.h });
      } else {
        page.drawRectangle({ ...photoBox, borderColor: GREY, borderWidth: 0.5, color: rgb(0.95, 0.95, 0.95) });
        page.drawText('Foto', { x: photoBox.x + 13, y: photoBox.y + 26, size: 8, font, color: GREY });
        page.drawText('belum ada', { x: photoBox.x + 5, y: photoBox.y + 15, size: 7, font, color: GREY });
      }

      // Nama + NIS + NISN + kelas (kanan foto).
      const textX = margin + 48;
      const textW = CARD_W - textX - margin;
      const nameSize = fitText(fontBold, student.name, 10, textW);
      page.drawText(truncate(fontBold, student.name, nameSize, textW), {
        x: textX, y: CARD_H - 42, size: nameSize, font: fontBold, color: DARK,
      });
      page.drawText(`NIS  ${student.nis}`, { x: textX, y: CARD_H - 55, size: 8, font, color: DARK });
      page.drawText(`NISN  ${student.nisn || '(belum diisi)'}`, {
        x: textX, y: CARD_H - 66, size: 8, font, color: student.nisn ? DARK : GREY,
      });
      const className = student.classIds.map((c) => classNameById.get(c)).filter(Boolean).join(', ');
      page.drawText(`Kelas  ${className || '-'}`, { x: textX, y: CARD_H - 77, size: 8, font, color: DARK });

      // QR (kanan bawah) + footer alamat.
      const qrText = `SIA-ID:1:${prof?.qr_token || ''}`;
      const qrBuffer = await QRCode.toBuffer(qrText, { width: 180, margin: 0 });
      const qrImage = await pdf.embedPng(qrBuffer);
      const qrSize = 52;
      page.drawImage(qrImage, {
        x: CARD_W - margin - qrSize, y: 30, width: qrSize, height: qrSize,
      });
      page.drawText('Pindai untuk absensi', {
        x: CARD_W - margin - qrSize, y: 22, size: 6, font, color: GREY,
      });
      const footer = school.address || school.identity || '';
      if (footer) {
        page.drawText(truncate(font, footer, 6, CARD_W - qrSize - margin * 3), {
          x: margin, y: 34, size: 6, font, color: GREY,
        });
      }
      page.drawRectangle({ x: 0, y: 0, width: CARD_W, height: 14, color: DARK_BLUE });
      page.drawText(school.identity || school.name, {
        x: margin, y: 5, size: 6, font, color: WHITE,
      });
    }

    const bytes = await pdf.save();
    return new Response(bytes, {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="kartu-siswa-${classId || 'pilihan'}.pdf"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (error) {
    return handleError(error);
  }
}
