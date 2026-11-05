"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPublicClient, getAddress, http, type Address, type Hex } from "viem";
import { sepolia } from "viem/chains";

import { formatUSDC } from "@/lib/format";
import {
  createPrizeCheckCoordinator,
  createPrizeCheckIntentStore,
  createViemPrizeChainReader,
  createViemPrizeProofClient,
  type PrizeCheckIntent,
  type PreparedPrizeCheck,
} from "@/lib/prize-check-coordinator";
import { RPC_URL } from "@/lib/contracts";
import type { PasskeySmartSession, PreparedSmartTransaction } from "@/lib/smart-session";
import { decryptExistingSmartUint64, prepareSmartReadSessionCalls } from "@/lib/zama";
import { useActionCenter } from "@/components/ActionCenter";

const client = createPublicClient({ chain: sepolia, transport: http(RPC_URL) });
const requestClient = {
  request: (args: { method: string; params: readonly unknown[] }) => client.request(args as never),
};
const PAGE_SIZE = 25;
const UINT256_MAX = (1n << 256n) - 1n;

type ListedDraw = Readonly<{ drawId: bigint }>;
type Selection =
  | Readonly<{ kind: "loading"; drawId: bigint }>
  | Readonly<{ kind: "unchecked"; drawId: bigint }>
  | Readonly<{
      kind: "ready";
      drawId: bigint;
      prepared: PreparedPrizeCheck;
      pending: (drawId: bigint) => PrizeCheckIntent | null;
    }>
  | Readonly<{ kind: "access-ready"; drawId: bigint; prepared: PreparedSmartTransaction }>
  | Readonly<{ kind: "checked"; drawId: bigint; handle: Hex; award?: bigint; access?: true }>
  | Readonly<{
      kind:
        | "pending"
        | "updating"
        | "failed"
        | "rejected"
        | "not-submitted"
        | "not-eligible"
        | "indexing"
        | "history-unavailable";
      drawId: bigint;
    }>
  | Readonly<{ kind: "unavailable"; drawId: bigint }>;

type PrizeHistoryProps = Readonly<{
  account: Address;
  pool: Address;
  session: PasskeySmartSession;
  proofUrl: string;
}>;

function validRound(value: string): bigint | undefined {
  if (!/^[1-9][0-9]*$/.test(value) || value.length > 78) return undefined;
  try {
    const drawId = BigInt(value);
    return drawId <= UINT256_MAX ? drawId : undefined;
  } catch {
    return undefined;
  }
}

export function PrizeHistory({ account, pool, session, proofUrl }: PrizeHistoryProps) {
  const { actions, runAction } = useActionCenter();
  const [draws, setDraws] = useState<readonly ListedDraw[]>([]);
  const [nextCursor, setNextCursor] = useState<bigint>();
  const [historyUnavailable, setHistoryUnavailable] = useState(false);
  const [requestedRound, setRequestedRound] = useState("");
  const [selection, setSelection] = useState<Selection>();
  const listEpoch = useRef(0);
  const selectionEpoch = useRef(0);
  const listAbortRef = useRef<AbortController>();
  const selectionAbortRef = useRef<AbortController>();
  const confirmingCheckRef = useRef<PreparedPrizeCheck>();
  const recoveredActionRef = useRef<string>();
  const cancelList = useCallback(() => {
    listEpoch.current += 1;
    listAbortRef.current?.abort();
    listAbortRef.current = undefined;
  }, []);
  const cancelSelection = useCallback(() => {
    selectionEpoch.current += 1;
    selectionAbortRef.current?.abort();
    selectionAbortRef.current = undefined;
  }, []);
  const createCoordinator = useCallback(() => {
    const reader = createViemPrizeChainReader(requestClient, getAddress(pool));
    return createPrizeCheckCoordinator({
      chainId: 11155111,
      pool: getAddress(pool),
      account: getAddress(account),
      session,
      readBlockHash: (signal) => reader.readBlockHash({ signal }),
      readChecked: (drawId, options) => reader.readChecked(drawId, getAddress(account), options),
      readAward: (drawId, options) => reader.readAward(drawId, getAddress(account), options),
      getProofClient: () =>
        createViemPrizeProofClient({
          chainId: 11155111,
          pool: getAddress(pool),
          account: getAddress(account),
          baseUrl: proofUrl,
          client: requestClient,
        }),
      prepareReadSessionCalls: () => prepareSmartReadSessionCalls(session),
      intentStore: createPrizeCheckIntentStore(window.localStorage),
    });
  }, [account, pool, proofUrl, session]);

  const loadPage = useCallback(
    async (cursor?: bigint) => {
      if (!proofUrl) return;
      cancelList();
      const request = ++listEpoch.current;
      const controller = new AbortController();
      listAbortRef.current = controller;
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
        if (request !== listEpoch.current || controller.signal.aborted) return;
        if (result.kind !== "draws") {
          setHistoryUnavailable(true);
          return;
        }
        setDraws((current) => [...current, ...result.draws]);
        setNextCursor(result.draws.length === PAGE_SIZE ? result.draws.at(-1)?.drawId : undefined);
      } catch {
        if (request === listEpoch.current && !controller.signal.aborted)
          setHistoryUnavailable(true);
      }
    },
    [account, cancelList, pool, proofUrl],
  );

  const viewRound = useCallback(
    async (drawId: bigint) => {
      cancelSelection();
      const request = ++selectionEpoch.current;
      const controller = new AbortController();
      selectionAbortRef.current = controller;
      setSelection({ kind: "loading", drawId });
      try {
        const reader = createViemPrizeChainReader(requestClient, getAddress(pool));
        const blockHash = await reader.readBlockHash({ signal: controller.signal });
        const checked = await reader.readChecked(drawId, getAddress(account), {
          blockHash,
          signal: controller.signal,
        });
        if (request !== selectionEpoch.current || controller.signal.aborted) return;
        if (!checked) {
          const coordinator = createCoordinator();
          const saved = coordinator.pending(drawId);
          if (saved) {
            try {
              const recovered = await coordinator.reconcile(drawId, saved, controller.signal);
              if (request !== selectionEpoch.current || controller.signal.aborted) return;
              if ("state" in recovered && recovered.state === "checked") {
                try {
                  const award = await decryptExistingSmartUint64(
                    session,
                    recovered.award,
                    getAddress(pool),
                    { signal: controller.signal },
                  );
                  if (request === selectionEpoch.current && !controller.signal.aborted)
                    setSelection({ kind: "checked", drawId, handle: recovered.award, award });
                } catch {
                  if (request === selectionEpoch.current && !controller.signal.aborted)
                    setSelection({
                      kind: "checked",
                      drawId,
                      handle: recovered.award,
                      access: true,
                    });
                }
              } else if (recovered.state === "pending") setSelection({ kind: "pending", drawId });
              else setSelection({ kind: "failed", drawId });
            } catch {
              if (request === selectionEpoch.current && !controller.signal.aborted)
                setSelection({ kind: "updating", drawId });
            }
            return;
          }
          setSelection({ kind: "unchecked", drawId });
          return;
        }
        const handle = await reader.readAward(drawId, getAddress(account), {
          blockHash,
          signal: controller.signal,
        });
        if (request !== selectionEpoch.current || controller.signal.aborted) return;
        try {
          const award = await decryptExistingSmartUint64(session, handle as Hex, getAddress(pool), {
            signal: controller.signal,
          });
          if (request === selectionEpoch.current && !controller.signal.aborted)
            setSelection({ kind: "checked", drawId, handle: handle as Hex, award });
        } catch {
          if (request === selectionEpoch.current && !controller.signal.aborted)
            setSelection({ kind: "checked", drawId, handle: handle as Hex, access: true });
        }
      } catch {
        if (request === selectionEpoch.current && !controller.signal.aborted)
          setSelection({ kind: "unavailable", drawId });
      }
    },
    [account, cancelSelection, createCoordinator, pool, session],
  );

  useEffect(() => {
    if (proofUrl) void loadPage();
    return () => {
      cancelList();
      cancelSelection();
    };
  }, [cancelList, cancelSelection, loadPage, proofUrl]);

  useEffect(() => {
    if (
      !selection ||
      !["pending", "updating", "failed", "rejected", "not-submitted"].includes(selection.kind)
    )
      return;
    let saved: PrizeCheckIntent | null;
    try {
      saved = createCoordinator().pending(selection.drawId);
    } catch {
      return;
    }
    if (!saved) return;
    const action = actions.find(
      (item) =>
        item.operation &&
        ["completed", "failed", "rejected", "not-submitted"].includes(item.status) &&
        item.operation.chainId === saved.operation.chainId &&
        item.operation.userOperationHash.toLowerCase() ===
          saved.operation.userOperationHash.toLowerCase() &&
        item.operation.sender.toLowerCase() === saved.operation.sender.toLowerCase() &&
        item.operation.entryPoint.toLowerCase() === saved.operation.entryPoint.toLowerCase(),
    );
    if (!action) return;
    if (action.status === "not-submitted") {
      if (selection.kind !== "not-submitted")
        setSelection({ kind: "not-submitted", drawId: selection.drawId });
      return;
    }
    if (action.status === "rejected") {
      if (selection.kind !== "rejected")
        setSelection({ kind: "rejected", drawId: selection.drawId });
      return;
    }
    if (action.status === "failed") {
      if (selection.kind !== "failed") setSelection({ kind: "failed", drawId: selection.drawId });
      return;
    }
    const key = `${action.id}:${action.status}:${action.updatedAt}`;
    if (recoveredActionRef.current === key) return;
    recoveredActionRef.current = key;
    void viewRound(selection.drawId);
  }, [actions, createCoordinator, selection, viewRound]);

  const startCheck = useCallback(async () => {
    if (!selection || selection.kind !== "unchecked") return;
    confirmingCheckRef.current = undefined;
    cancelSelection();
    const controller = new AbortController();
    selectionAbortRef.current = controller;
    const request = ++selectionEpoch.current;
    setSelection({ kind: "loading", drawId: selection.drawId });
    try {
      const coordinator = createCoordinator();
      const reviewed = await coordinator.review(selection.drawId, controller.signal);
      if (request !== selectionEpoch.current || controller.signal.aborted) return;
      if (reviewed.state === "checked") {
        await viewRound(selection.drawId);
        return;
      }
      if (reviewed.state !== "ready") {
        setSelection({ kind: reviewed.state, drawId: selection.drawId });
        return;
      }
      const prepared = await coordinator.prepare(reviewed, controller.signal);
      if (request !== selectionEpoch.current || controller.signal.aborted) {
        prepared.cancel();
        return;
      }
      setSelection({
        kind: "ready",
        drawId: selection.drawId,
        prepared,
        pending: coordinator.pending,
      });
    } catch {
      if (request === selectionEpoch.current && !controller.signal.aborted)
        setSelection({ kind: "unavailable", drawId: selection.drawId });
    }
  }, [cancelSelection, createCoordinator, selection, viewRound]);

  const confirmCheck = () => {
    if (!selection || selection.kind !== "ready") return;
    const prepared = selection.prepared;
    if (confirmingCheckRef.current === prepared) return;
    confirmingCheckRef.current = prepared;
    runAction(
      { label: "Check prize", type: "check", account: session.address },
      async ({ update }) => {
        update({ status: "waiting-wallet" });
        try {
          const checked = await prepared.confirm({
            onOperationPrepared: (operation) => update({ status: "confirming", operation }),
          });
          update({ status: "completed" });
          await viewRound(checked.drawId);
        } catch (error) {
          const saved = selection.pending(selection.drawId);
          if (saved)
            update({
              status: "confirming",
              operation: saved.operation,
              error: "Still processing. Check status to see the latest update.",
            });
          throw error;
        }
      },
    );
  };

  const reviewAccess = async () => {
    if (!selection || selection.kind !== "checked" || !selection.access) return;
    cancelSelection();
    const request = ++selectionEpoch.current;
    const controller = new AbortController();
    selectionAbortRef.current = controller;
    try {
      const calls = await prepareSmartReadSessionCalls(session);
      const prepared = await session.prepareTransaction([...calls], { signal: controller.signal });
      if (request !== selectionEpoch.current || controller.signal.aborted) {
        prepared.cancel();
        return;
      }
      setSelection({ kind: "access-ready", drawId: selection.drawId, prepared });
    } catch {
      if (request === selectionEpoch.current && !controller.signal.aborted)
        setSelection({ ...selection });
    }
  };

  const confirmAccess = () => {
    if (!selection || selection.kind !== "access-ready") return;
    const prepared = selection.prepared;
    const drawId = selection.drawId;
    runAction(
      { label: "Review account access", type: "approval", account: session.address },
      async ({ update }) => {
        update({ status: "waiting-wallet" });
        await prepared.send();
        update({ status: "completed" });
        await viewRound(drawId);
      },
    );
  };

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
        <div className="space-y-2">
          <p className="text-sm text-muted">This result is ready to check.</p>
          <button className="btn-primary w-full" onClick={() => void startCheck()}>
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
          <button className="btn-primary w-full" onClick={() => void startCheck()}>
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
        <button className="btn-primary w-full" onClick={confirmCheck}>
          Confirm
        </button>
      )}
      {selection?.kind === "access-ready" && (
        <button className="btn-primary w-full" onClick={confirmAccess}>
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
              <button className="btn-secondary w-full" onClick={() => void reviewAccess()}>
                Review access
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
