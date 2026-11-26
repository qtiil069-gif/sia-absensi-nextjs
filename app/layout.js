import './globals.css';
import Sidebar from '@/components/Sidebar';
import { ToastProvider } from '@/components/Toast';

export const metadata = {
  title: 'SIA Absensi Sekolah',
  description: 'Sistem Informasi Absensi Sekolah — dashboard, data kelas, data siswa, absensi, dan kartu ID.',
};

export default function RootLayout({ children }) {
  return (
    <html lang="id">
      <body>
        <ToastProvider>
          <Sidebar />
          <div className="workspace">
            <main id="main">{children}</main>
            <footer className="page-footer">
              <span id="school-name">SIA Sekolah</span>
              <span>
                Dibuat untuk hari belajar yang lebih baik <span aria-hidden="true">✦</span>
              </span>
            </footer>
          </div>
        </ToastProvider>
      </body>
    </html>
  );
}
