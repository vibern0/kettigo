"use client";

import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPublicClient, getAddress, http, type Address, type Hex } from "viem";
import { sepolia } from "viem/chains";

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
import { PrizeHistorySelection } from "./PrizeHistorySelection";
import { drawOperationKey } from "./draw-page-utils";
import {
  completeKnownPrizeHistoryOperation,
  completeObservedPrizeHistoryOperations,
} from "./prize-history-operation-lease";
import type { ReviewLease } from "./review-lease";

const client = createPublicClient({ chain: sepolia, transport: http(RPC_URL) });
const requestClient = {
  request: (args: { method: string; params: readonly unknown[] }) => client.request(args as never),
};
const PAGE_SIZE = 25;
const UINT256_MAX = (1n << 256n) - 1n;

export type ListedDraw = Readonly<{ drawId: bigint }>;
export type Selection =
  | Readonly<{ kind: "loading"; drawId: bigint }>
  | Readonly<{ kind: "unchecked"; drawId: bigint }>
  | Readonly<{
      kind: "ready";
      drawId: bigint;
      prepared: PreparedPrizeCheck;
      pending: (drawId: bigint) => PrizeCheckIntent | null;
    }>
  | Readonly<{ kind: "access-ready"; drawId: bigint; prepared: PreparedSmartTransaction }>
  | Readonly<{
      kind: "checked";
      drawId: bigint;
      handle: Hex;
      award?: bigint;
      access?: true;
      unavailable?: true;
    }>
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
  reviewLease: ReviewLease;
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

export function PrizeHistory({ account, pool, session, proofUrl, reviewLease }: PrizeHistoryProps) {
  const { actions = [], runAction } = useActionCenter();
  const [draws, setDraws] = useState<readonly ListedDraw[]>([]);
  const [nextCursor, setNextCursor] = useState<bigint>();
  const [historyUnavailable, setHistoryUnavailable] = useState(false);
  const [requestedRound, setRequestedRound] = useState("");
  const [selection, setSelection] = useState<Selection>();
  const listEpoch = useRef(0);
  const selectionEpoch = useRef(0);
  const listAbortRef = useRef<AbortController>();
  const selectionAbortRef = useRef<AbortController>();
  const preparedCheckRef = useRef<PreparedPrizeCheck>();
  const confirmingCheckRef = useRef<PreparedPrizeCheck>();
  const preparedAccessRef = useRef<PreparedSmartTransaction>();
  const confirmingAccessRef = useRef<PreparedSmartTransaction>();
  const checkOwnerRef = useRef<symbol>();
  const accessOwnerRef = useRef<symbol>();
  const operationOwnersRef = useRef(new Map<string, symbol>());
  const scopeRef = useRef(`${account}:${pool}`);
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
    if (preparedCheckRef.current && preparedCheckRef.current !== confirmingCheckRef.current)
      preparedCheckRef.current.cancel();
    preparedCheckRef.current = undefined;
    if (preparedAccessRef.current && preparedAccessRef.current !== confirmingAccessRef.current)
      preparedAccessRef.current.cancel();
    preparedAccessRef.current = undefined;
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
                } catch (error) {
                  if (request === selectionEpoch.current && !controller.signal.aborted)
                    setSelection(
                      isAccessRequired(error)
                        ? { kind: "checked", drawId, handle: recovered.award, access: true }
                        : { kind: "checked", drawId, handle: recovered.award, unavailable: true },
                    );
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
        } catch (error) {
          if (request === selectionEpoch.current && !controller.signal.aborted)
            setSelection(
              isAccessRequired(error)
                ? { kind: "checked", drawId, handle: handle as Hex, access: true }
                : { kind: "checked", drawId, handle: handle as Hex, unavailable: true },
            );
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

  useLayoutEffect(() => {
    const scope = `${account}:${pool}`;
    if (scopeRef.current === scope) return;
    scopeRef.current = scope;
    cancelList();
    cancelSelection();
    setDraws([]);
    setNextCursor(undefined);
    setHistoryUnavailable(false);
    setRequestedRound("");
    setSelection(undefined);
  }, [account, cancelList, cancelSelection, pool]);

  useEffect(() => {
    completeObservedPrizeHistoryOperations(actions, operationOwnersRef.current, reviewLease);
  }, [actions, reviewLease]);

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
    const owner = Symbol("check");
    if (!reviewLease.begin(owner, cancelSelection)) return;
    checkOwnerRef.current = owner;
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
        reviewLease.release(owner);
        return;
      }
      if (!reviewLease.ready(owner, prepared.cancel)) {
        prepared.cancel();
        return;
      }
      preparedCheckRef.current = prepared;
      setSelection({
        kind: "ready",
        drawId: selection.drawId,
        prepared,
        pending: coordinator.pending,
      });
    } catch {
      reviewLease.release(owner);
      if (request === selectionEpoch.current && !controller.signal.aborted)
        setSelection({ kind: "unavailable", drawId: selection.drawId });
    }
  }, [cancelSelection, createCoordinator, reviewLease, selection, viewRound]);

  const confirmCheck = () => {
    if (!selection || selection.kind !== "ready") return;
    const prepared = selection.prepared;
    if (confirmingCheckRef.current === prepared) return;
    const owner = checkOwnerRef.current;
    if (!owner || !reviewLease.confirm(owner)) return;
    confirmingCheckRef.current = prepared;
    runAction(
      { label: "Check prize", type: "check", account: session.address },
      async ({ update }) => {
        update({ status: "waiting-wallet" });
        try {
          const checked = await prepared.confirm({
            onOperationPrepared: (operation) => {
              operationOwnersRef.current.set(drawOperationKey(operation), owner);
              update({ status: "confirming", operation });
            },
          });
          update({ status: "completed" });
          if (checkOwnerRef.current) reviewLease.complete(checkOwnerRef.current);
          await viewRound(checked.drawId);
        } catch (error) {
          completeKnownPrizeHistoryOperation(owner, error, operationOwnersRef.current, reviewLease);
          const saved = selection.pending(selection.drawId);
          if (saved)
            update({
              status: "confirming",
              operation: saved.operation,
              error: "Still processing. Check status to see the latest update.",
            });
          throw error;
        } finally {
          if (confirmingCheckRef.current === prepared) confirmingCheckRef.current = undefined;
          if (preparedCheckRef.current === prepared) preparedCheckRef.current = undefined;
        }
      },
    );
  };

  const reviewAccess = async () => {
    if (!selection || selection.kind !== "checked" || !selection.access) return;
    const checkedSelection = selection;
    const owner = Symbol("access");
    if (!reviewLease.begin(owner, cancelSelection)) return;
    accessOwnerRef.current = owner;
    cancelSelection();
    const request = ++selectionEpoch.current;
    const controller = new AbortController();
    selectionAbortRef.current = controller;
    try {
      const calls = await prepareSmartReadSessionCalls(session);
      const prepared = await session.prepareTransaction([...calls], { signal: controller.signal });
      if (request !== selectionEpoch.current || controller.signal.aborted) {
        prepared.cancel();
        reviewLease.release(owner);
        return;
      }
      const cancelPreparedAccess = () => {
        prepared.cancel();
        if (preparedAccessRef.current === prepared) preparedAccessRef.current = undefined;
        setSelection((current) =>
          current?.kind === "access-ready" && current.drawId === checkedSelection.drawId
            ? checkedSelection
            : current,
        );
      };
      if (!reviewLease.ready(owner, cancelPreparedAccess)) {
        prepared.cancel();
        return;
      }
      preparedAccessRef.current = prepared;
      setSelection({ kind: "access-ready", drawId: selection.drawId, prepared });
    } catch {
      reviewLease.release(owner);
      if (request === selectionEpoch.current && !controller.signal.aborted)
        setSelection({ ...selection });
    }
  };

  const confirmAccess = () => {
    if (!selection || selection.kind !== "access-ready") return;
    const prepared = selection.prepared;
    const drawId = selection.drawId;
    if (confirmingAccessRef.current === prepared) return;
    const owner = accessOwnerRef.current;
    if (!owner || !reviewLease.confirm(owner)) return;
    confirmingAccessRef.current = prepared;
    runAction(
      { label: "Review account access", type: "approval", account: session.address },
      async ({ update }) => {
        update({ status: "waiting-wallet" });
        try {
          await prepared.send({
            onOperationPrepared: (operation) => {
              operationOwnersRef.current.set(drawOperationKey(operation), owner);
              update({ status: "confirming", operation });
            },
          });
          update({ status: "completed" });
          if (accessOwnerRef.current) reviewLease.complete(accessOwnerRef.current);
          await viewRound(drawId);
        } catch (error) {
          completeKnownPrizeHistoryOperation(owner, error, operationOwnersRef.current, reviewLease);
          throw error;
        } finally {
          if (confirmingAccessRef.current === prepared) confirmingAccessRef.current = undefined;
          if (preparedAccessRef.current === prepared) preparedAccessRef.current = undefined;
        }
      },
    );
  };

  const requested = validRound(requestedRound);
  return (
    <PrizeHistorySelection
      draws={draws}
      historyUnavailable={historyUnavailable}
      nextCursor={nextCursor}
      onConfirmCheck={selection?.kind === "access-ready" ? confirmAccess : confirmCheck}
      onLoadPage={(cursor) => void loadPage(cursor)}
      onRequestedRoundChange={setRequestedRound}
      onReviewAccess={() => void reviewAccess()}
      onStartCheck={() => void startCheck()}
      onViewRound={(drawId) => void viewRound(drawId)}
      requested={requested}
      requestedRound={requestedRound}
      selection={selection}
    />
  );
}

function isAccessRequired(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ZAMA_READ_SESSION_ACCESS_REQUIRED"
  );
}
