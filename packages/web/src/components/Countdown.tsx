"use client";

import { useCountdown } from "@/lib/usePoolData";
import { formatCountdown } from "@/lib/format";

export function Countdown({ target }: { target: bigint | undefined }) {
  const seconds = useCountdown(target);
  if (seconds === null) return <span className="text-muted">—</span>;

  const ended = seconds <= 0;

  return (
    <div className="flex items-baseline gap-2">
      <span
        className={`font-display text-3xl font-bold tracking-tight tabular-nums ${
          ended ? "text-warning" : "text-text"
        }`}
      >
        {ended ? "Result pending" : formatCountdown(seconds)}
      </span>
      {!ended && <span className="text-muted text-sm">until the next result</span>}
    </div>
  );
}
