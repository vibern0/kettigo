"use client";

import { formatUSDC } from "@/lib/format";
import type { ListedDraw, Selection } from "./PrizeHistory";

type PrizeHistorySelectionProps = Readonly<{
  draws: readonly ListedDraw[];
  nextCursor?: bigint;
  historyUnavailable: boolean;
  requestedRound: string;
  requested?: bigint;
  selection?: Selection;
  onRequestedRoundChange: (value: string) => void;
  onViewRound: (drawId: bigint) => void;
  onLoadPage: (cursor: bigint) => void;
  onStartCheck: () => void;
  onConfirmCheck: () => void;
  onReviewAccess: () => void;
}>;

export function PrizeHistorySelection({
  draws,
  nextCursor,
  historyUnavailable,
  requestedRound,
  requested,
  selection,
  onRequestedRoundChange,
  onViewRound,
  onLoadPage,
  onStartCheck,
  onConfirmCheck,
  onReviewAccess,
}: PrizeHistorySelectionProps) {
  return (
    <section className="card space-y-3">
      <div>
        <p className="label">Your past results</p>
        <p className="mt-1 text-xs leading-relaxed text-muted">
          Choose a completed round to see its result. Eligibility is decided when each draw ends.
        </p>
      </div>
      <div className="flex gap-2">
        <input
          aria-label="Round number"
          className="input min-w-0 flex-1"
          inputMode="numeric"
          min="1"
          type="number"
          value={requestedRound}
          onChange={(event) => onRequestedRoundChange(event.target.value)}
        />
        <button
          className="btn-secondary shrink-0"
          disabled={!requested}
          onClick={() => requested && onViewRound(requested)}
        >
          View round
        </button>
      </div>
      {draws.length > 0 && (
        <div className="grid gap-2">
          {draws.map((draw) => (
            <button
              className="btn-secondary w-full text-left"
              key={draw.drawId.toString()}
              onClick={() => onViewRound(draw.drawId)}
            >
              Round #{draw.drawId.toString()}
            </button>
          ))}
        </div>
      )}
      {nextCursor !== undefined && (
        <button className="btn-secondary w-full" onClick={() => onLoadPage(nextCursor)}>
          Show earlier results
        </button>
      )}
      {historyUnavailable && (
        <p className="text-sm text-muted">Past results are unavailable right now.</p>
      )}
      {selection?.kind === "loading" && (
        <p className="text-sm text-muted">Checking round #{selection.drawId.toString()}.</p>
      )}
      {selection?.kind === "unchecked" && (
        <div className="space-y-2">
          <p className="text-sm text-muted">This result is ready to check.</p>
          <button className="btn-primary w-full" onClick={onStartCheck}>
            Review check
          </button>
        </div>
      )}
      {selection?.kind === "pending" && (
        <p className="text-sm text-muted">This check is still processing.</p>
      )}
      {selection?.kind === "updating" && (
        <p className="text-sm text-muted">This result is updating. Check back shortly.</p>
      )}
      {selection?.kind === "failed" && (
        <p className="text-sm text-muted">This check did not go through.</p>
      )}
      {selection?.kind === "rejected" && (
        <p className="text-sm text-muted">This check was not approved.</p>
      )}
      {selection?.kind === "not-submitted" && (
        <div className="space-y-2">
          <p className="text-sm text-muted">This check was not sent.</p>
          <button className="btn-primary w-full" onClick={onStartCheck}>
            Review check
          </button>
        </div>
      )}
      {selection?.kind === "not-eligible" && (
        <p className="text-sm text-muted">
          This round was not available to check for your account.
        </p>
      )}
      {selection?.kind === "indexing" && (
        <p className="text-sm text-muted">
          This result is still being prepared. Check back shortly.
        </p>
      )}
      {selection?.kind === "history-unavailable" && (
        <p className="text-sm text-muted">Past results are unavailable right now.</p>
      )}
      {selection?.kind === "ready" && (
        <button className="btn-primary w-full" onClick={onConfirmCheck}>
          Confirm
        </button>
      )}
      {selection?.kind === "access-ready" && (
        <button className="btn-primary w-full" onClick={onConfirmCheck}>
          Confirm
        </button>
      )}
      {selection?.kind === "unavailable" && (
        <p className="text-sm text-muted">This result is unavailable right now.</p>
      )}
      {selection?.kind === "checked" && (
        <div className="rounded-2xl border border-white/50 bg-white/35 p-3">
          <p className="text-xs font-semibold text-muted">Round #{selection.drawId.toString()}</p>
          <p className="mt-1 text-sm text-muted">Result checked</p>
          {selection.award === undefined ? null : (
            <p className="font-display text-2xl font-bold text-brand">
              {formatUSDC(selection.award, 6)} USDC
            </p>
          )}
          {selection.access && (
            <div className="mt-2 space-y-2">
              <p className="text-sm text-muted">This result needs account access to show.</p>
              <button className="btn-secondary w-full" onClick={onReviewAccess}>
                Review access
              </button>
            </div>
          )}
          {selection.unavailable && (
            <p className="mt-2 text-sm text-muted">This result cannot be shown right now.</p>
          )}
        </div>
      )}
    </section>
  );
}
