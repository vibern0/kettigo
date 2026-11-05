"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPublicClient, getAddress, http, type Address, type Hex } from "viem";
import { sepolia } from "viem/chains";

import { formatUSDC } from "@/lib/format";
import {
  createViemPrizeChainReader,
  createViemPrizeProofClient,
} from "@/lib/prize-check-coordinator";
import { RPC_URL } from "@/lib/contracts";
import type { PasskeySmartSession } from "@/lib/smart-session";
import { decryptExistingSmartUint64 } from "@/lib/zama";

const client = createPublicClient({ chain: sepolia, transport: http(RPC_URL) });
const requestClient = {
  request: (args: { method: string; params: readonly unknown[] }) => client.request(args as never),
};
const PAGE_SIZE = 25;

type ListedDraw = Readonly<{ drawId: bigint }>;
type Selection =
  | Readonly<{ kind: "loading"; drawId: bigint }>
  | Readonly<{ kind: "unchecked"; drawId: bigint }>
  | Readonly<{ kind: "checked"; drawId: bigint; award?: bigint }>
  | Readonly<{ kind: "access"; drawId: bigint }>
  | Readonly<{ kind: "unavailable"; drawId: bigint }>;

type PrizeHistoryProps = Readonly<{
  account: Address;
  pool: Address;
  session: PasskeySmartSession;
  proofUrl: string;
}>;

function validRound(value: string): bigint | undefined {
  if (!/^[1-9][0-9]*$/.test(value)) return undefined;
  try {
    return BigInt(value);
  } catch {
    return undefined;
  }
}

export function PrizeHistory({ account, pool, session, proofUrl }: PrizeHistoryProps) {
  const [draws, setDraws] = useState<readonly ListedDraw[]>([]);
  const [nextCursor, setNextCursor] = useState<bigint>();
  const [historyUnavailable, setHistoryUnavailable] = useState(false);
  const [requestedRound, setRequestedRound] = useState("");
  const [selection, setSelection] = useState<Selection>();
  const epoch = useRef(0);
  const abortRef = useRef<AbortController>();
  const cancel = useCallback(() => {
    epoch.current += 1;
    abortRef.current?.abort();
    abortRef.current = undefined;
  }, []);

  const loadPage = useCallback(
    async (cursor?: bigint) => {
      if (!proofUrl) return;
      cancel();
      const request = ++epoch.current;
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        const archive = createViemPrizeProofClient({
          chainId: 11155111,
          pool: getAddress(pool),
          account: getAddress(account),
          baseUrl: proofUrl,
          client: requestClient,
        });
        const result = await archive.listDraws({
          cursor,
          limit: PAGE_SIZE,
          signal: controller.signal,
        });
        if (request !== epoch.current || controller.signal.aborted) return;
        if (result.kind !== "draws") {
          setHistoryUnavailable(true);
          return;
        }
        setDraws((current) => [...current, ...result.draws]);
        setNextCursor(result.draws.length === PAGE_SIZE ? result.draws.at(-1)?.drawId : undefined);
      } catch {
        if (request === epoch.current && !controller.signal.aborted) setHistoryUnavailable(true);
      }
    },
    [account, cancel, pool, proofUrl],
  );

  const viewRound = useCallback(
    async (drawId: bigint) => {
      cancel();
      const request = ++epoch.current;
      const controller = new AbortController();
      abortRef.current = controller;
      setSelection({ kind: "loading", drawId });
      try {
        const reader = createViemPrizeChainReader(requestClient, getAddress(pool));
        const blockHash = await reader.readBlockHash({ signal: controller.signal });
        const checked = await reader.readChecked(drawId, getAddress(account), {
          blockHash,
          signal: controller.signal,
        });
        if (request !== epoch.current || controller.signal.aborted) return;
        if (!checked) {
          setSelection({ kind: "unchecked", drawId });
          return;
        }
        const handle = await reader.readAward(drawId, getAddress(account), {
          blockHash,
          signal: controller.signal,
        });
        if (request !== epoch.current || controller.signal.aborted) return;
        try {
          const award = await decryptExistingSmartUint64(session, handle as Hex, getAddress(pool), {
            signal: controller.signal,
          });
          if (request === epoch.current && !controller.signal.aborted)
            setSelection({ kind: "checked", drawId, award });
        } catch {
          if (request === epoch.current && !controller.signal.aborted)
            setSelection({ kind: "access", drawId });
        }
      } catch {
        if (request === epoch.current && !controller.signal.aborted)
          setSelection({ kind: "unavailable", drawId });
      }
    },
    [account, cancel, pool, session],
  );

  useEffect(() => {
    if (proofUrl) void loadPage();
    return cancel;
  }, [cancel, loadPage, proofUrl]);

  const requested = validRound(requestedRound);
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
          onChange={(event) => setRequestedRound(event.target.value)}
        />
        <button
          className="btn-secondary shrink-0"
          disabled={!requested}
          onClick={() => requested && void viewRound(requested)}
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
              onClick={() => void viewRound(draw.drawId)}
            >
              Round #{draw.drawId.toString()}
            </button>
          ))}
        </div>
      )}
      {nextCursor !== undefined && (
        <button className="btn-secondary w-full" onClick={() => void loadPage(nextCursor)}>
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
        <p className="text-sm text-muted">This result is ready to check.</p>
      )}
      {selection?.kind === "unavailable" && (
        <p className="text-sm text-muted">This result is unavailable right now.</p>
      )}
      {selection?.kind === "access" && (
        <p className="text-sm text-muted">This result needs account access to show.</p>
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
        </div>
      )}
    </section>
  );
}
