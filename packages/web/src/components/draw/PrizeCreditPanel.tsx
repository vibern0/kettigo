import { formatUSDC } from "@/lib/format";
import type { PrizeAction, PrizeActionId } from "@/lib/prize-actions";

type PrizeCreditPanelProps = Readonly<{
  actions: readonly PrizeAction[];
  onAction: (action: PrizeActionId) => void;
  winnings?: bigint;
}>;

export function PrizeCreditPanel({ actions, onAction, winnings }: PrizeCreditPanelProps) {
  const empty = winnings === 0n;
  return (
    <div className="card space-y-3">
      <div>
        <p className="label">My winnings</p>
        <p className="mt-1 text-xs leading-relaxed text-muted">
          Check your result once a winner has been selected. If you’ve won, claim your winnings
          here.
        </p>
      </div>
      <div className="flex min-h-20 items-center justify-between gap-3 rounded-2xl border border-white/50 bg-white/35 px-4 py-3">
        <span className="text-xs font-semibold text-muted">
          {empty ? "Nothing ready to claim" : "Prize ready"}
        </span>
        <span className="min-w-32 max-w-[68%] text-right font-display text-2xl font-bold leading-none tabular-nums text-brand break-words">
          {empty ? "—" : `${formatUSDC(winnings, 6)} USDC`}
        </span>
      </div>
      {actions.map((action) => (
        <button
          className={`${action.variant === "primary" ? "btn-primary" : "btn-secondary"} w-full`}
          disabled={action.disabled}
          key={action.id}
          onClick={() => onAction(action.id)}
        >
          {action.label}
        </button>
      ))}
    </div>
  );
}
