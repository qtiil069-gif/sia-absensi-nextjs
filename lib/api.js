// Adapter transport untuk versi Next.js.
// Permukaan fungsi SAMA seperti services/api.js asli (google.script.run),
// tetapi transportnya fetch ke Route Handler /api/* dengan format respons:
//   sukses { ok: true, data: ... }  |  gagal { ok: false, error: { code, message } }
// Tidak ada fallback dummy: kegagalan dilempar sebagai Error (dengan .code).
import { getProfile } from './useProfile';

const GAS_ONLY = (name) =>
  new Error(
    `${name} hanya berlaku di versi Google Apps Script dan tidak tersedia di versi Next.js. ` +
      'Migrasi database pada porting ini dilakukan lewat SQL di supabase/migrations/, bukan lewat UI.'
  );

function buildQuery(params = {}) {
  const q = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    q.set(key, String(value));
  }
  const s = q.toString();
  return s ? `?${s}` : '';
}

function toError(payload, fallback) {
  const message = payload?.error?.message || payload?.message || fallback || 'Terjadi kesalahan.';
  const error = new Error(message);
  error.code = payload?.error?.code || payload?.code || null;
  return error;
}

async function requestJson(path, { method = 'GET', body } = {}) {
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new Error('Tidak dapat terhubung ke server. Periksa koneksi internet Anda lalu coba lagi.');
  }
  let payload = null;
  try {
    payload = await res.json();
  } catch {
    throw new Error('Respons server tidak valid.');
  }
  if (!res.ok || payload?.ok === false) throw toError(payload, `Permintaan gagal (${res.status}).`);
  return payload?.ok === true ? payload.data : payload;
}

// Unduhan berkas (Excel/PDF). Mengembalikan Blob dengan properti .filename.
// Bila server mengembalikan JSON {ok:false,...} (mis. error), lempar Error.
async function requestBlob(path) {
  let res;
  try {
    res = await fetch(path);
  } catch {
    throw new Error('Tidak dapat terhubung ke server. Periksa koneksi internet Anda lalu coba lagi.');
  }
  const contentType = res.headers.get('content-type') || '';
  if (!res.ok || contentType.includes('application/json')) {
    let payload = null;
    try {
      payload = await res.json();
    } catch {
      throw new Error(`Unduhan gagal (${res.status}).`);
    }
    throw toError(payload, `Unduhan gagal (${res.status}).`);
  }
  const blob = await res.blob();
  const disposition = res.headers.get('content-disposition') || '';
  const match = /filename\*?=(?:UTF-8''|")?([^";\n]+)/i.exec(disposition);
  blob.filename = match ? decodeURIComponent(match[1].replace(/"/g, '')) : path.split('/').pop().split('?')[0] || 'unduhan';
  return blob;
}

export function downloadBlob(blob, filename) {
  const name = filename || blob.filename || 'unduhan';
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---- Pemetaan rpc(name, args) -> endpoint /api/* -------------------------
// Catatan kontrak untuk tim server (lihat juga laporan porting):
//  - GET /api/attendance dipakai ganda: ?options=1 mengembalikan
//    { subjects: [...] } untuk getAttendanceOptions; tanpa itu mengembalikan
//    roster absensi. Query sesi memakai "jenis" (HARIAN/MAPEL).
//  - POST /api/attendance/qr dipakai ganda dan dibedakan field "step":
//    "validate" (hanya validasi, TIDAK menyimpan) dan "confirm" (menyimpan Hadir).
//  - GET /api/classes idealnya menyertakan metadata tahun ajaran & wali
//    (mis. data.meta = { years, teachers }) untuk form kelas; bila tidak ada,
//    getRosterOptions mengembalikan daftar kosong dan form tetap jalan.

async function rpc(name, args = {}) {
  switch (name) {
    case 'getBootstrap': {
      // Tidak ada endpoint /api/bootstrap di kontrak: sekolah dibaca dari
      // /api/settings, profil/peran dibaca lewat Supabase Auth (lib/useProfile).
      const [school, profile] = await Promise.all([
        requestJson('/api/settings').catch(() => ({})),
        getProfile().catch(() => null),
      ]);
      return {
        user: profile
          ? { id: profile.id, name: profile.name || profile.email, email: profile.email, role: profile.role }
          : { name: '', email: '', role: 'GURU' },
        school: {
          name: school?.name || 'SIA Sekolah',
          semester: school?.semester || '',
          address: school?.address || '',
          identity: school?.identity || '',
          logo: school?.logo || '',
        },
      };
    }
    case 'getDashboard':
      return requestJson(`/api/dashboard${buildQuery({ date: args.date, classId: args.classId })}`);
    case 'listClasses':
      return requestJson(`/api/classes${buildQuery({ q: args.q, level: args.level, status: args.status })}`);
    case 'getRosterOptions': {
      const data = await requestJson('/api/classes');
      const list = Array.isArray(data) ? data : data?.items || [];
      const meta = Array.isArray(data) ? {} : data?.meta || {};
      return { years: meta.years || [], teachers: meta.teachers || [], classes: list };
    }
    case 'createClass':
      return requestJson('/api/classes', { method: 'POST', body: args });
    case 'updateClass':
      return requestJson(`/api/classes/${args.id}`, { method: 'PATCH', body: args });
    case 'deactivateClass':
      return requestJson(`/api/classes/${args.id}`, {
        method: 'PATCH',
        body: { active: false, expectedRevision: args.expectedRevision },
      });
    case 'listStudents':
    case 'queryStudents': {
      const data = await requestJson(
        `/api/students${buildQuery({ q: args.q, classId: args.classId, status: args.status, page: args.page, pageSize: args.pageSize })}`
      );
      if (Array.isArray(data)) {
        const page = Number(args.page) || 1;
        const pageSize = Number(args.pageSize) || 25;
        const start = (page - 1) * pageSize;
        return { items: data.slice(start, start + pageSize), total: data.length, page, pages: Math.max(1, Math.ceil(data.length / pageSize)) };
      }
      return data;
    }
    case 'createStudent':
      return requestJson('/api/students', { method: 'POST', body: args });
    case 'updateStudent':
      return requestJson(`/api/students/${args.id}`, { method: 'PATCH', body: args });
    case 'deactivateStudent':
      return requestJson(`/api/students/${args.id}`, {
        method: 'PATCH',
        body: { active: false, expectedRevision: args.expectedRevision },
      });
    case 'getAttendanceOptions': {
      const data = await requestJson(`/api/attendance${buildQuery({ classId: args.classId, options: 1 })}`);
      return data?.subjects ? data : { subjects: Array.isArray(data) ? data : [] };
    }
    case 'getAttendance':
      return requestJson(
        `/api/attendance${buildQuery({ classId: args.classId, date: args.date, jenis: args.jenis || args.kind, subjectId: args.subjectId })}`
      );
    case 'saveAttendance':
      return requestJson('/api/attendance', {
        method: 'POST',
        body: { ...args, jenis: args.jenis || args.kind },
      });
    case 'getSchoolSettings':
      return requestJson('/api/settings');
    case 'updateSchoolSettings':
      return requestJson('/api/settings', { method: 'PATCH', body: args });
    case 'prepareStudentCards': {
      const query = args.classId
        ? buildQuery({ classId: args.classId })
        : args.studentIds?.length
          ? buildQuery({ studentIds: args.studentIds.join(',') })
          : args.studentId
            ? buildQuery({ studentId: args.studentId })
            : '';
      return requestJson(`/api/cards${query}`);
    }
    case 'exportStudentData':
      // Di versi Next.js ekspor dikembalikan sebagai berkas (Blob), bukan JSON rows.
      return requestBlob(
        `/api/export/students${buildQuery({ q: args.q, classId: args.classId, status: args.status })}`
      );
    case 'exportCards':
      return requestBlob(`/api/export/cards${buildQuery({ classId: args.classId })}`);
    case 'validateStudentQr':
      return requestJson('/api/attendance/qr', {
        method: 'POST',
        body: { ...args, jenis: args.jenis || args.kind, step: 'validate' },
      });
    case 'saveQrAttendance':
      return requestJson('/api/attendance/qr', {
        method: 'POST',
        body: { ...args, jenis: args.jenis || args.kind, step: 'confirm' },
      });
    case 'getStage3Status':
    case 'migrateStage3':
    case 'getBrowserAsset':
      throw GAS_ONLY(name);
    default:
      throw new Error(`Fungsi tidak dikenal: ${name}`);
  }
}

const api = {
  rpc,
  getBootstrap: (args) => rpc('getBootstrap', args),
  getDashboard: (args) => rpc('getDashboard', args),
  listClasses: (args) => rpc('listClasses', args),
  listStudents: (args) => rpc('listStudents', args),
  queryStudents: (args) => rpc('queryStudents', args),
  createClass: (args) => rpc('createClass', args),
  updateClass: (args) => rpc('updateClass', args),
  deactivateClass: (args) => rpc('deactivateClass', args),
  createStudent: (args) => rpc('createStudent', args),
  updateStudent: (args) => rpc('updateStudent', args),
  deactivateStudent: (args) => rpc('deactivateStudent', args),
  getAttendanceOptions: (args) => rpc('getAttendanceOptions', args),
  getAttendance: (args) => rpc('getAttendance', args),
  saveAttendance: (args) => rpc('saveAttendance', args),
  getSchoolSettings: (args) => rpc('getSchoolSettings', args),
  updateSchoolSettings: (args) => rpc('updateSchoolSettings', args),
  prepareStudentCards: (args) => rpc('prepareStudentCards', args),
  exportStudentData: (args) => rpc('exportStudentData', args),
  exportCards: (args) => rpc('exportCards', args),
  validateStudentQr: (args) => rpc('validateStudentQr', args),
  saveQrAttendance: (args) => rpc('saveQrAttendance', args),
  getStage3Status: () => rpc('getStage3Status'),
  migrateStage3: () => rpc('migrateStage3'),
  getBrowserAsset: () => rpc('getBrowserAsset'),
  downloadBlob,
};

export default api;
