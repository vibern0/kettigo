"use client";

import {
  createContext,
  ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  addAction,
  countPendingActions,
  createActionId,
  dismissAction as dismissActionRecord,
  isFinalActionStatus,
  updateAction,
  type ActionPatch,
  type AsyncAction,
  type AsyncActionStatus,
  type NewAsyncAction,
} from "@/lib/action-center-model";
import { SheetViewport } from "@/components/SheetViewport";
import { reportClientError } from "@/lib/client-errors";
import { cn } from "@/lib/cn";

const STORAGE_KEY = "kettigo:actions";

type ActionRunnerControls = {
  id: string;
  update: (patch: ActionPatch) => void;
};

type ActionCenterContextValue = {
  actions: AsyncAction[];
  runAction: (input: NewAsyncAction, runner: (controls: ActionRunnerControls) => Promise<void>) => string;
  updateTrackedAction: (id: string, patch: ActionPatch) => void;
  dismissTrackedAction: (id: string) => void;
  retryTrackedAction: (id: string) => void;
};

const ActionCenterContext = createContext<ActionCenterContextValue | undefined>(undefined);

const statusLabel: Record<AsyncActionStatus, string> = {
  preparing: "Preparing",
  "waiting-wallet": "Waiting for approval",
  submitted: "Sent",
  confirming: "Confirming",
  updating: "Updating",
  completed: "Complete",
  failed: "Failed",
  dismissed: "Dismissed",
};

const statusClass: Record<AsyncActionStatus, string> = {
  preparing: "bg-white/45 text-muted",
  "waiting-wallet": "bg-white/45 text-muted",
  submitted: "bg-brand/10 text-brand",
  confirming: "bg-brand/10 text-brand",
  updating: "bg-brand/10 text-brand",
  completed: "bg-success/10 text-success",
  failed: "bg-danger/10 text-danger",
  dismissed: "bg-white/45 text-muted",
};

function readStoredActions() {
  if (typeof window === "undefined") return [];

  try {
    const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "[]");
    if (!Array.isArray(stored)) return [];

    return stored.filter((action): action is AsyncAction => {
      return (
        typeof action?.id === "string" &&
        typeof action.label === "string" &&
        typeof action.type === "string" &&
        typeof action.status === "string" &&
        typeof action.createdAt === "number" &&
        typeof action.updatedAt === "number"
      );
    });
  } catch {
    return [];
  }
}

function writeStoredActions(actions: AsyncAction[]) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(actions));
}

function shortHash(value?: string) {
  if (!value) return undefined;
  return value.replace(/^0x/, "").slice(0, 8);
}

function formatTime(timestamp: number) {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(timestamp));
}

export function ActionCenterProvider({ children }: { children: ReactNode }) {
  const [actions, setActions] = useState<AsyncAction[]>([]);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const runnersRef = useRef(
    new Map<string, (controls: ActionRunnerControls) => Promise<void>>(),
  );

  useEffect(() => {
    setActions(readStoredActions());
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    writeStoredActions(actions);
  }, [actions, hydrated]);

  const updateTrackedAction = useCallback((id: string, patch: ActionPatch) => {
    setActions((current) => updateAction(current, id, patch));
  }, []);

  const dismissTrackedAction = useCallback((id: string) => {
    setActions((current) => dismissActionRecord(current, id));
  }, []);

  const executeRunner = useCallback(
    (id: string, runner: (controls: ActionRunnerControls) => Promise<void>) => {
      void runner({
        id,
        update: (patch) => updateTrackedAction(id, patch),
      }).catch((error) => {
        reportClientError(error, { action: "background-action", stage: "execution" });
        const message = error instanceof Error ? error.message : String(error);
        updateTrackedAction(id, {
          status: "failed",
          error: message,
        });
      });
    },
    [updateTrackedAction],
  );

  const runAction = useCallback(
    (input: NewAsyncAction, runner: (controls: ActionRunnerControls) => Promise<void>) => {
      const createdAt = input.createdAt ?? Date.now();
      const id = input.id ?? createActionId(createdAt);
      const actionInput = { ...input, id, createdAt };
      runnersRef.current.set(id, runner);
      setActions((current) => addAction(current, actionInput));
      executeRunner(id, runner);

      return id;
    },
    [executeRunner],
  );

  const retryTrackedAction = useCallback(
    (id: string) => {
      const existing = runnersRef.current.get(id);
      if (!existing) return;

      setActions((current) =>
        updateAction(current, id, {
          status: "preparing",
          error: undefined,
          txHash: undefined,
          requestId: undefined,
        }),
      );
      executeRunner(id, existing);
    },
    [executeRunner],
  );

  const value = useMemo(
    () => ({ actions, runAction, updateTrackedAction, dismissTrackedAction, retryTrackedAction }),
    [actions, dismissTrackedAction, retryTrackedAction, runAction, updateTrackedAction],
  );

  const liveCount = countPendingActions(actions);
  const pendingActions = actions.filter((action) => !isFinalActionStatus(action.status));

  useEffect(() => {
    if (liveCount === 0) setSheetOpen(false);
  }, [liveCount]);

  return (
    <ActionCenterContext.Provider value={value}>
      {children}
      {liveCount > 0 && (
        <div className="pointer-events-none fixed inset-x-0 bottom-5 z-40 mx-auto flex w-full max-w-[480px] justify-end px-5">
          <button
            type="button"
            className="pointer-events-auto glass-surface inline-flex items-center gap-2 rounded-full px-4 py-3 font-display text-sm font-semibold text-text shadow-lg transition-transform active:scale-[0.98]"
            onClick={() => setSheetOpen(true)}
            aria-haspopup="dialog"
            aria-expanded={sheetOpen}
          >
            <span className="relative inline-flex h-2.5 w-2.5">
              {liveCount > 0 && <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-brand/55" />}
              <span className={cn("relative inline-flex h-2.5 w-2.5 rounded-full", liveCount > 0 ? "bg-brand" : "bg-success")} />
            </span>
            Activity
            {liveCount > 0 && (
              <span className="grid h-5 min-w-5 place-items-center rounded-full bg-brand px-1.5 text-xs text-white">
                {liveCount}
              </span>
            )}
          </button>
        </div>
      )}

      {sheetOpen && liveCount > 0 && (
        <SheetViewport className="fixed inset-0 z-50 flex items-end justify-center bg-text/30 px-4 pb-4 backdrop-blur-sm">
          <button
            type="button"
            aria-label="Close activity"
            className="absolute inset-0 h-full w-full cursor-default"
            onClick={() => setSheetOpen(false)}
          />
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="activity-sheet-title"
            className="glass-surface relative max-h-[min(82vh,100%)] w-full max-w-[448px] space-y-4 overflow-y-auto rounded-t-[30px] p-5 shadow-[0_-28px_64px_-38px_rgb(43_45_50_/_0.55)] animate-fade-in"
          >
            <div className="mx-auto h-1.5 w-12 rounded-full bg-text/20" />
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="label">Activity</p>
                <h2 id="activity-sheet-title" className="font-display text-xl font-bold">
                  Pending actions
                </h2>
              </div>
              <button
                type="button"
                aria-label="Close activity"
                onClick={() => setSheetOpen(false)}
                className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-white/40 text-muted transition-colors hover:bg-white/60 hover:text-text"
              >
                x
              </button>
            </div>

            {pendingActions.length === 0 ? (
              <p className="text-sm text-muted">No pending actions.</p>
            ) : (
              <div className="space-y-2">
                {pendingActions.map((action) => (
                  <div key={action.id} className="rounded-3xl border border-white/55 bg-white/35 p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="font-display text-sm font-semibold text-text">{action.label}</p>
                        <p className="mt-1 text-xs text-muted">{formatTime(action.updatedAt)}</p>
                      </div>
                      <span className={cn("rounded-full px-2.5 py-1 text-xs font-semibold", statusClass[action.status])}>
                        {statusLabel[action.status]}
                      </span>
                    </div>

                    {(action.txHash || action.requestId || action.error) && (
                      <div className="mt-3 space-y-1 text-xs text-muted">
                        {action.txHash && <p className="font-mono">Tx {shortHash(action.txHash)}</p>}
                        {action.requestId && <p className="font-mono">ID {shortHash(action.requestId)}</p>}
                        {action.error && <p className="text-danger">{action.error}</p>}
                      </div>
                    )}

                  </div>
                ))}
              </div>
            )}
          </div>
        </SheetViewport>
      )}
    </ActionCenterContext.Provider>
  );
}

export function useActionCenter() {
  const context = useContext(ActionCenterContext);
  if (!context) throw new Error("useActionCenter must be used inside ActionCenterProvider.");
  return context;
}
