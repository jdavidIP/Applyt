import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';

type ToastTone = 'success' | 'error' | 'warning';

interface ToastItem {
  id: number;
  tone: ToastTone;
  message: string;
}

interface ShowToastInput {
  tone: ToastTone;
  message: string;
}

interface ToastContextValue {
  showToast: (input: ShowToastInput) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const AUTO_DISMISS_MS = 4000;

// design-system.md: success uses matcha, error uses rose, warning uses amber —
// the same tone palette as status badges/banners, so toasts read as part of
// the same system rather than a bolted-on notification library.
const TONE_STYLES: Record<ToastTone, string> = {
  success: 'bg-white border-matcha-200 text-matcha-800',
  error: 'bg-white border-rose-100 text-rose-800',
  warning: 'bg-white border-amber-100 text-amber-800',
};

const TONE_DOT: Record<ToastTone, string> = {
  success: 'bg-matcha-400',
  error: 'bg-rose-800',
  warning: 'bg-amber-800',
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextId = useRef(0);

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const showToast = useCallback(
    ({ tone, message }: ShowToastInput) => {
      const id = nextId.current++;
      setToasts((prev) => [...prev, { id, tone, message }]);
      setTimeout(() => dismiss(id), AUTO_DISMISS_MS);
    },
    [dismiss],
  );

  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}
      <div className="fixed bottom-5 right-5 z-[100] flex flex-col gap-2 w-[320px] max-w-[calc(100vw-2.5rem)]">
        {toasts.map((t) => (
          <div
            key={t.id}
            role="status"
            className={`toast-enter flex items-start gap-2.5 rounded-xl border-[0.5px] px-4 py-3 text-[13px] shadow-none ${TONE_STYLES[t.tone]}`}
          >
            <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${TONE_DOT[t.tone]}`} aria-hidden />
            <span className="flex-1">{t.message}</span>
            <button
              type="button"
              onClick={() => dismiss(t.id)}
              className="text-ink-soft hover:text-ink shrink-0 leading-none"
              aria-label="Dismiss"
            >
              ✕
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within a ToastProvider');
  return ctx;
}
