// Kartu ID siswa portrait 54 x 85,6 mm (porting lib/card-layout.js +
// components/student-cards.js + docs/kartu-id-notifikasi.md).
// Palet kartu: biru royal #2354C5, biru tua #102B5C, kuning #F6C945,
// putih, biru muda #EEF3FC. QR dibuat dari token dengan payload
// "SIA-ID:1:<token>" (tanpa data pribadi) via qrcode.toDataURL.
'use client';

import { useEffect, useState } from 'react';
import QRCode from 'qrcode';

export const CARD_COLORS = {
  royal: '#2354C5',
  navy: '#102B5C',
  yellow: '#F6C945',
  white: '#FFFFFF',
  soft: '#EEF3FC',
};

export const CARD_WIDTH_MM = 54;
export const CARD_HEIGHT_MM = 85.6;

const BOXES = {
  logo: { x: 22.4, y: 2.6, w: 9.2, h: 9.2 },
  title: { x: 3, y: 12.8, w: 48, h: 3, fontSize: 2.15, bold: true, color: '#2354C5' },
  schoolName: { x: 3, y: 17.3, w: 48, h: 5.5, fontSize: 2.3, bold: true, color: '#FFFFFF' },
  identity: { x: 3, y: 23.4, w: 48, h: 2.5, fontSize: 1.45, color: '#FFFFFF' },
  photo: { x: 19, y: 29.5, w: 16, h: 20 },
  name: { x: 3, y: 51.2, w: 48, h: 6.2, fontSize: 2.5, bold: true, color: '#102B5C' },
  nisn: { x: 3, y: 58, w: 48, h: 2.5, fontSize: 1.95, color: '#102B5C' },
  className: { x: 3, y: 61.3, w: 48, h: 2.5, fontSize: 1.95, color: '#102B5C' },
  qr: { x: 19.4, y: 64.4, w: 15.2, h: 15.2 },
  address: { x: 3, y: 80.4, w: 48, h: 4.6, fontSize: 1.45, color: '#FFFFFF' },
};

const DECORATIONS = [
  { x: 0, y: 0, w: 54, h: 1.2, color: '#102B5C' },
  { x: 0, y: 1.2, w: 12, h: 0.5, color: '#F6C945' },
  { x: 0, y: 16.5, w: 54, h: 10.3, color: '#2354C5' },
  { x: 0, y: 26.8, w: 54, h: 0.7, color: '#F6C945' },
  { x: 18.6, y: 29.1, w: 16.8, h: 20.8, color: '#2354C5' },
  { x: 0, y: 80, w: 54, h: 5.6, color: '#102B5C' },
];

function place(box) {
  return {
    position: 'absolute',
    left: `${box.x}mm`,
    top: `${box.y}mm`,
    width: `${box.w}mm`,
    height: `${box.h}mm`,
  };
}

function textStyle(box) {
  return {
    ...place(box),
    fontSize: `${box.fontSize}mm`,
    lineHeight: `${(box.fontSize || 2) * 1.171875}mm`,
    fontWeight: box.bold ? 700 : 400,
    color: box.color,
  };
}

// Potong teks ke lebar kotak (perkiraan kasar per karakter); alamat dibatasi
// 2 baris dengan elipsis seperti versi asli.
function fitLines(text, maxChars, maxLines = 2) {
  const clean = String(text || '').trim().replace(/\s+/g, ' ');
  if (!clean) return '';
  const words = clean.split(' ');
  const lines = [];
  let line = '';
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (next.length <= maxChars) {
      line = next;
      continue;
    }
    if (line) lines.push(line);
    line = word.length > maxChars ? word.slice(0, maxChars) : word;
  }
  if (line) lines.push(line);
  const shown = lines.slice(0, maxLines);
  if (lines.length > maxLines) {
    let last = shown[shown.length - 1].replace(/…$/, '');
    while (last.length > 0 && `${last}…`.length > maxChars) last = last.slice(0, -1);
    shown[shown.length - 1] = `${last.trimEnd()}…`;
  }
  return shown.join('\n');
}

export default function StudentCard({ school = {}, student = {} }) {
  const [qrSrc, setQrSrc] = useState(student.qrImage || '');

  const token = student.qrToken || student.qr_token || '';
  const qrPayload = student.qrPayload || student.qr || (token ? `SIA-ID:1:${token}` : '');

  useEffect(() => {
    if (student.qrImage) {
      setQrSrc(student.qrImage);
      return;
    }
    if (!qrPayload) {
      setQrSrc('');
      return;
    }
    let alive = true;
    QRCode.toDataURL(qrPayload, { margin: 1, width: 256 })
      .then((url) => {
        if (alive) setQrSrc(url);
      })
      .catch(() => {
        if (alive) setQrSrc('');
      });
    return () => {
      alive = false;
    };
  }, [qrPayload, student.qrImage]);

  const schoolName = school.name || 'SIA Sekolah';
  const className = student.className || student.class || student.kelas || '';
  const address = fitLines(school.address || '', 48, 2);

  return (
    <article className="id-card" aria-label={`Kartu ID ${student.name || ''}`}>
      {DECORATIONS.map((d, i) => (
        <div
          key={i}
          className="id-card-decoration"
          aria-hidden="true"
          style={{ ...place(d), backgroundColor: d.color }}
        />
      ))}
      <header className="id-card-header">
        {school.logo && (
          <img className="id-school-logo" src={school.logo} alt={`Logo ${schoolName}`} style={place(BOXES.logo)} />
        )}
        <p className="id-card-title" style={textStyle(BOXES.title)}>KARTU ID SISWA</p>
        <h3 style={textStyle(BOXES.schoolName)}>{fitLines(schoolName, 26, 2)}</h3>
        {school.identity && <p style={textStyle(BOXES.identity)}>{fitLines(school.identity, 34, 1)}</p>}
      </header>
      {student.photo ? (
        <img className="id-photo" src={student.photo} alt={`Foto ${student.name || ''}`} style={place(BOXES.photo)} />
      ) : (
        <div className="id-photo photo-placeholder" style={place(BOXES.photo)}>FOTO SISWA</div>
      )}
      <strong className="id-name" style={textStyle(BOXES.name)}>{fitLines(student.name || '', 24, 2)}</strong>
      <p className="id-nisn" style={textStyle(BOXES.nisn)}>
        NISN: {student.nisn || 'Belum diisi'}
      </p>
      <p className="id-class" style={textStyle(BOXES.className)}>Kelas: {className || '—'}</p>
      {qrSrc ? (
        <img className="id-qr" src={qrSrc} alt={`QR unik ${student.name || ''}`} style={place(BOXES.qr)} />
      ) : (
        <div className="id-qr photo-placeholder" style={place(BOXES.qr)}>QR BELUM TERSEDIA</div>
      )}
      <footer style={textStyle(BOXES.address)} title={school.address || ''}>{address}</footer>
    </article>
  );
}
