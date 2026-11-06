import { formatUSDC } from "@/lib/format";

type DrawPoolSummaryProps = Readonly<{
  activeDrawId?: bigint;
  participantCount?: bigint;
  publicPrizeReserve?: bigint;
  roundsClosed: bigint;
}>;

export function DrawPoolSummary({
  activeDrawId,
  participantCount,
  publicPrizeReserve,
  roundsClosed,
}: DrawPoolSummaryProps) {
  return (
    <div className="card space-y-3">
      <p className="label">Global pool</p>
      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-2xl bg-white/35 border border-white/50 p-3 min-h-24">
          <p className="text-xs text-muted">Selection ID</p>
          <p className="font-display text-2xl font-bold tabular-nums">
            #{activeDrawId === undefined ? "-" : activeDrawId.toString()}
          </p>
        </div>
        <div className="rounded-2xl bg-white/35 border border-white/50 p-3 min-h-24">
          <p className="text-xs text-muted">Participants</p>
          <p className="font-display text-2xl font-bold tabular-nums">
            {participantCount === undefined ? "-" : participantCount.toString()}
          </p>
        </div>
        <div className="rounded-2xl bg-white/35 border border-white/50 p-3 min-h-24">
          <p className="text-xs text-muted">Past results</p>
          <p className="font-display text-2xl font-bold tabular-nums">{roundsClosed.toString()}</p>
        </div>
        <div className="rounded-2xl bg-white/35 border border-white/50 p-3 min-h-24">
          <p className="text-xs text-muted">Added this round</p>
          <p className="font-display text-xl font-bold tabular-nums">
            {formatUSDC(publicPrizeReserve, 6)} USDC
          </p>
        </div>
      </div>
    </div>
  );
}
