// Toast hasil aksi (porting lib/toasts.js + toast-styles.css asli).
// Satu toast dalam satu waktu; pesan identik tidak digandakan; sukses hijau
// lembut (5 detik), gagal merah lembut (7 detik); timer berhenti saat
// toast ditunjuk/difokuskan; ada tombol tutup; tidak mengambil fokus.
'use client';

import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';

const ToastContext = createContext({ success: () => {}, error: () => {}, clear: () => {} });

export function useToast() {
  return useContext(ToastContext);
}

export function ToastProvider({ children }) {
  const [toast, setToast] = useState(null); // { message, error }
  const timerRef = useRef(null);

  const clear = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    setToast(null);
  }, []);

  const show = useCallback(
    (message, error = false) => {
      const text = String(message || '');
      if (!text) return;
      setToast((current) => {
        if (current?.message === text && current.error === error) return current;
        return { message: text, error };
      });
    },
    []
  );

  const success = useCallback((message) => show(message, false), [show]);
  const error = useCallback((message) => show(message, true), [show]);

  // Timer (di-reset tiap toast baru); dijeda oleh ToastViewport saat hover/fokus.
  useEffect(() => {
    if (!toast) return undefined;
    timerRef.current = setTimeout(clear, toast.error ? 7000 : 5000);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [toast, clear]);

  return (
    <ToastContext.Provider value={{ success, error, clear }}>
      {children}
      {/* Viewport dirender di sini agar toast terlihat juga di dalam dialog. */}
      <ToastViewport toast={toast} onClear={clear} onPause={() => {
        if (timerRef.current) clearTimeout(timerRef.current);
      }} onResume={() => {
        if (!toast) return;
        timerRef.current = setTimeout(clear, toast.error ? 7000 : 5000);
      }} />
    </ToastContext.Provider>
  );
}

// Dipakai langsung oleh layout (tanpa props) bila provider sudah membungkus;
// bila dipakai tanpa provider, tidak menampilkan apa-apa.
export function ToastViewport({ toast: toastProp, onClear, onPause, onResume }) {
  const ctx = useContext(ToastContext);
  // Bila dipanggil dari dalam provider, toast dikirim lewat props (lihat di atas).
  const toast = toastProp !== undefined ? toastProp : null;
  const clear = onClear || ctx.clear;

  if (!toast) return null;
  return (
    <div className="toast-region" aria-label="Notifikasi aplikasi">
      <div
        className={`toast${toast.error ? ' toast--error' : ' toast--success'}`}
        role={toast.error ? 'alert' : 'status'}
        aria-atomic="true"
        onPointerEnter={onPause}
        onPointerLeave={onResume}
        onFocusCapture={onPause}
        onBlurCapture={() => setTimeout(() => onResume && onResume(), 0)}
      >
        <span className="toast-icon" aria-hidden="true">{toast.error ? '!' : '✓'}</span>
        <span className="toast-message">{toast.message}</span>
        <button type="button" className="toast-close" aria-label="Tutup notifikasi" onClick={clear}>
          ×
        </button>
      </div>
    </div>
  );
}

export default ToastProvider;
