"use client";

import { createContext, ReactNode, useCallback, useContext, useMemo, useState } from "react";

type ToastTone = "success" | "error" | "info";

type Toast = {
  id: number;
  title: string;
  description?: string;
  tone: ToastTone;
};

type ToastInput = Omit<Toast, "id">;

const ToastContext = createContext<((toast: ToastInput) => void) | undefined>(undefined);

const toneClass: Record<ToastTone, string> = {
  success: "border-success/45 text-text",
  error: "border-danger/45 text-text",
  info: "border-text/25 text-text",
};

const dotClass: Record<ToastTone, string> = {
  success: "bg-success",
  error: "bg-danger",
  info: "bg-muted",
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const notify = useCallback((toast: ToastInput) => {
    const id = Date.now() + Math.random();
    setToasts((current) => [...current, { ...toast, id }].slice(-3));
    window.setTimeout(() => {
      setToasts((current) => current.filter((item) => item.id !== id));
    }, 5_000);
  }, []);

  const value = useMemo(() => notify, [notify]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 top-10 z-[60] mx-auto flex w-full max-w-[480px] flex-col gap-2 px-5">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            role="status"
            className={`pointer-events-auto glass-surface flex transform-gpu items-start gap-3 rounded-2xl border px-4 py-3 shadow-lg motion-safe:animate-toast-in ${toneClass[toast.tone]}`}
          >
            <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${dotClass[toast.tone]}`} />
            <div className="min-w-0 flex-1">
              <p className="font-display text-sm font-semibold leading-snug text-text">{toast.title}</p>
              {toast.description && (
                <p className="mt-1 text-xs leading-relaxed text-muted">{toast.description}</p>
              )}
            </div>
            <button
              type="button"
              className="rounded-full px-2 text-sm text-muted transition-colors hover:text-text"
              onClick={() => setToasts((current) => current.filter((item) => item.id !== toast.id))}
              aria-label="Dismiss notification"
            >
              x
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const notify = useContext(ToastContext);
  if (!notify) throw new Error("useToast must be used inside ToastProvider.");
  return notify;
}
