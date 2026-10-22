"use client";

import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, m } from "motion/react";
import { SparklePop, type CelebrationKind } from "./SparklePop";

type ToastTone = "success" | "error" | "info";

type Toast = {
  id: number;
  title: string;
  description?: string;
  tone: ToastTone;
  celebration?: CelebrationKind;
};

export type ToastInput = Omit<Toast, "id">;

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
  const [celebration, setCelebration] = useState<{ id: number; kind: CelebrationKind }>();
  const timers = useRef(new Set<number>());

  useEffect(() => {
    const pendingTimers = timers.current;
    return () => pendingTimers.forEach(window.clearTimeout);
  }, []);

  useEffect(() => {
    if (celebration && !toasts.some((toast) => toast.id === celebration.id)) {
      setCelebration(undefined);
    }
  }, [celebration, toasts]);

  const notify = useCallback((toast: ToastInput) => {
    const id = Date.now() + Math.random();
    const kind = toast.tone === "success" ? toast.celebration : undefined;
    setToasts((current) => [...current, { ...toast, celebration: kind, id }].slice(-3));
    if (kind) setCelebration({ id, kind });
    const timer = window.setTimeout(() => {
      setToasts((current) => current.filter((item) => item.id !== id));
      timers.current.delete(timer);
    }, 5_000);
    timers.current.add(timer);
  }, []);

  const value = useMemo(() => notify, [notify]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      {celebration && <SparklePop key={celebration.id} kind={celebration.kind} />}
      <div className="pointer-events-none fixed inset-x-0 top-10 z-[60] mx-auto flex w-full max-w-[480px] flex-col gap-2 px-5">
        <AnimatePresence initial={false}>
          {toasts.map((toast) => (
            <m.div
              key={toast.id}
              layout="position"
              initial={{ opacity: 0, y: -18, scale: 0.94 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -8, scale: 0.97, transition: { duration: 0.15 } }}
              role="status"
              className={`pointer-events-auto glass-surface flex items-start gap-3 rounded-2xl border px-4 py-3 shadow-lg ${toneClass[toast.tone]}`}
            >
              {toast.celebration ? (
                <m.span
                  aria-hidden="true"
                  className="sparkle-badge"
                  initial={{ scale: 0.6, rotate: -18 }}
                  animate={{ scale: 1, rotate: -7 }}
                >
                  {toast.celebration === "prize" ? "✦" : "✓"}
                  <span className="sparkle-badge-star" />
                  <span className="sparkle-badge-star sparkle-badge-star-small" />
                </m.span>
              ) : <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${dotClass[toast.tone]}`} />}
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
            </m.div>
          ))}
        </AnimatePresence>
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const notify = useContext(ToastContext);
  if (!notify) throw new Error("useToast must be used inside ToastProvider.");
  return notify;
}
