"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPublicClient, encodeFunctionData, getAddress, http, isAddress } from "viem";
import { sepolia } from "viem/chains";
import { CONTRACTS, RPC_URL, confidentialPrizePoolAbi } from "@/lib/contracts";
import { Countdown } from "@/components/Countdown";
import { TestnetWarning } from "@/components/TestnetWarning";
import { useWallet } from "@/lib/wallet-context";
import { type PreparedSmartTransaction } from "@/lib/smart-session";
import { decryptExistingSmartUint64, isZeroEncryptedHandle } from "@/lib/zama";
import { reportClientToast } from "@/lib/client-errors";
import { useToast, type ToastInput } from "@/components/Toast";
import { getPrizeActions, getPrizeRevealFeedback, type PrizeActionId } from "@/lib/prize-actions";
import { createLatestBlockRefresher } from "@/lib/morpho-yield";
import { PrizeHistory } from "@/components/draw/PrizeHistory";
import { DrawPoolSummary } from "@/components/draw/DrawPoolSummary";
import { readDrawSnapshot } from "@/components/draw/draw-snapshot";
import {
  asDrawAddress as asAddress,
  drawOperationKey,
  drawErrorMessage as getErrorMessage,
  isStoredDrawOperation,
  drawRuntimeConfig,
  formatDrawDateTime as formatDateTime,
  formatDrawInterval as formatInterval,
} from "@/components/draw/draw-page-utils";
import { PrizeCreditPanel } from "@/components/draw/PrizeCreditPanel";
import { useActionCenter } from "@/components/ActionCenter";
import type { AsyncAction } from "@/lib/action-center-model";
import { createReviewLease } from "@/components/draw/review-lease";
import {
  SafeUserOperationFailedError,
  SafeUserOperationNotSubmittedError,
  SafeUserOperationRejectedError,
} from "@/lib/passkey-operation";

type Status = "idle" | "working" | "success" | "error";
type WorkingAction = PrizeActionId | undefined;
type CreditReview = Readonly<{
  action: "claimPrize" | "addPrizeToSavings";
  owner: symbol;
  prepared: PreparedSmartTransaction;
}>;

const publicClient = createPublicClient({
  chain: sepolia,
  transport: http(RPC_URL),
});

// Draw page for checking prizes, claiming winnings, and viewing round timing.
export default function DrawPage() {
  const { session, refreshConfidentialBalances } = useWallet();
  const { actions = [], runAction, updateTrackedAction } = useActionCenter();
  const toast = useToast();
  const [hydrated, setHydrated] = useState(false);
  const [status, setStatus] = useState<Status>("idle");
  const [workingAction, setWorkingAction] = useState<WorkingAction>();
  const [drawId, setDrawId] = useState<bigint | undefined>();
  const [drawInterval, setDrawInterval] = useState<bigint | undefined>();
  const [nextDrawAt, setNextDrawAt] = useState<bigint | undefined>();
  const [participantCount, setParticipantCount] = useState<bigint | undefined>();
  const [publicPrizeReserve, setPublicPrizeReserve] = useState<bigint | undefined>();
  const [winnings, setWinnings] = useState<bigint | undefined>();
  const [winningsOwner, setWinningsOwner] = useState<`0x${string}` | undefined>();
  const [creditReview, setCreditReview] = useState<CreditReview>();
  const [participationPending, setParticipationPending] = useState(false);
  const [creditRefreshAction, setCreditRefreshAction] = useState<AsyncAction>();
  const winningsRequestId = useRef(0);
  const reviewLeaseRef = useRef(createReviewLease());
  const pendingCreditOwnersRef = useRef(new Map<string, symbol>());
  const winningsSessionRef = useRef(session?.address);
  const scopeRef = useRef("");
  const refreshedCreditOperationsRef = useRef(new Set<string>());
  winningsSessionRef.current = session?.address;
  const refreshRef = useRef<(blockNumber?: bigint) => Promise<void>>(async () => undefined);
  const addresses = {
    pool: isAddress(CONTRACTS.confidentialPrizePool)
      ? getAddress(CONTRACTS.confidentialPrizePool)
      : CONTRACTS.confidentialPrizePool,
  };

  const ready = isAddress(addresses.pool);
  const runtime = drawRuntimeConfig();
  const scope = `${session?.address?.toLowerCase() ?? ""}:${addresses.pool.toLowerCase()}:${runtime.mode2 ? "2" : "legacy1"}`;
  scopeRef.current = scope;
  const mode2 = hydrated && runtime.mode2;
  const activeDrawId = drawId === undefined ? undefined : drawId + 1n;
  const roundsClosed = drawId ?? 0n;
  const visibleWinnings = session?.address === winningsOwner ? winnings : undefined;
  const hasPrizeToClaim = visibleWinnings !== undefined && visibleWinnings > 0n;
  const prizeActions = getPrizeActions({
    connected: Boolean(session),
    ready,
    busy: status === "working",
    hasPrizeToClaim,
    workingAction,
  });
  const displayedPrizeActions = creditReview
    ? [
        {
          id: creditReview.action,
          label: "Confirm",
          busyLabel: "Confirm",
          disabled: false,
          variant: "primary" as const,
        },
      ]
    : prizeActions;

  useEffect(() => setHydrated(true), []);

  useEffect(
    () => () => {
      reviewLeaseRef.current.dispose();
    },
    [],
  );

  useEffect(() => {
    reviewLeaseRef.current.dispose();
    pendingCreditOwnersRef.current.clear();
    setCreditReview(undefined);
    setParticipationPending(false);
    setCreditRefreshAction(undefined);
  }, [session?.address, addresses.pool, runtime.mode2]);

  useEffect(
    () => () => {
      if (scopeRef.current === scope) scopeRef.current = "";
    },
    [scope],
  );

  useEffect(() => {
    for (const action of actions) {
      if (
        !action.operation ||
        !isStoredDrawOperation(action.operation) ||
        !["completed", "failed", "rejected", "not-submitted"].includes(action.status)
      )
        continue;
      const key = drawOperationKey(action.operation);
      const owner = pendingCreditOwnersRef.current.get(key);
      if (!owner) continue;
      reviewLeaseRef.current.complete(owner);
      pendingCreditOwnersRef.current.delete(key);
    }
  }, [actions]);

  useEffect(() => {
    if (!ready) return;

    const pool = asAddress(addresses.pool, "Prize pool");
    const refresher = createLatestBlockRefresher(
      (blockNumber) => readDrawSnapshot(pool, blockNumber),
      (snapshot) => {
        setDrawId(snapshot.drawId);
        setDrawInterval(snapshot.drawInterval);
        setNextDrawAt(snapshot.nextDrawAt);
        setParticipantCount(snapshot.participantCount);
        setPublicPrizeReserve(snapshot.publicPrizeReserve);
      },
    );
    refreshRef.current = refresher.refresh;
    void refresher.refresh();
    const unwatch = publicClient.watchBlockNumber({
      emitOnBegin: false,
      onBlockNumber: (blockNumber) => void refresher.refresh(blockNumber),
    });

    return () => {
      refreshRef.current = async () => undefined;
      refresher.dispose();
      unwatch();
    };
  }, [addresses.pool, ready]);

  useEffect(() => {
    winningsRequestId.current += 1;
    setWinnings(undefined);
    setWinningsOwner(undefined);
    if (!session?.address) return;
    void refresh();
  }, [addresses.pool, runtime.mode2, session?.address]);

  function activeSession() {
    if (!session) throw new Error("Connect your smart account first.");
    return session;
  }

  async function refresh() {
    await refreshRef.current();
  }

  const decryptWinnings = useCallback(async () => {
    if (!session) throw new Error("Connect your smart account first.");
    const currentSession = session;
    const user = currentSession.address;
    const requestScope = scope;
    const requestId = winningsRequestId.current + 1;
    winningsRequestId.current = requestId;
    if (!ready) throw new Error("Prize checks are unavailable right now.");

    const pool = asAddress(addresses.pool, "Prize pool");
    const handle = await publicClient.readContract({
      address: pool,
      abi: confidentialPrizePoolAbi,
      functionName: "encryptedWinningsOf",
      args: [user],
    });

    if (isZeroEncryptedHandle(handle)) {
      if (
        scopeRef.current !== requestScope ||
        winningsSessionRef.current !== user ||
        winningsRequestId.current !== requestId
      )
        return false;
      setWinnings(0n);
      setWinningsOwner(user);
      return getPrizeRevealFeedback(0n);
    }

    let revealedWinnings: bigint;
    try {
      revealedWinnings = await decryptExistingSmartUint64(
        currentSession,
        handle as `0x${string}`,
        pool,
      );
    } catch (error) {
      if (
        scopeRef.current !== requestScope ||
        winningsSessionRef.current !== user ||
        winningsRequestId.current !== requestId
      )
        return false;
      throw error;
    }
    if (
      scopeRef.current !== requestScope ||
      winningsSessionRef.current !== user ||
      winningsRequestId.current !== requestId
    )
      return false;
    setWinnings(revealedWinnings);
    setWinningsOwner(user);
    return getPrizeRevealFeedback(revealedWinnings);
  }, [addresses.pool, ready, scope, session]);

  const refreshCompletedCredit = useCallback(
    async (action: AsyncAction) => {
      const creditScope = action.creditScope;
      const actionAccount = action.account;
      if (
        !["completed", "updating"].includes(action.status) ||
        !isCreditScope(creditScope) ||
        !action.operation ||
        !isStoredDrawOperation(action.operation) ||
        typeof actionAccount !== "string" ||
        !isAddress(actionAccount) ||
        !session?.address ||
        !isAddress(addresses.pool) ||
        getAddress(actionAccount) !== getAddress(session.address) ||
        getAddress(creditScope.pool) !== getAddress(addresses.pool) ||
        creditScope.mode !== (runtime.mode2 ? "2" : "legacy1")
      )
        return;
      const operationKey = drawOperationKey(action.operation);
      if (refreshedCreditOperationsRef.current.has(operationKey)) return;
      const requestScope = scope;
      try {
        await decryptWinnings();
        if (scopeRef.current !== requestScope) return;
        await Promise.all([refreshRef.current(), refreshConfidentialBalances()]);
        if (
          scopeRef.current !== requestScope ||
          creditScope.action !== "addPrizeToSavings" ||
          !runtime.mode2
        ) {
          refreshedCreditOperationsRef.current.add(operationKey);
          setCreditRefreshAction(undefined);
          return;
        }
        const pool = asAddress(addresses.pool, "Prize pool");
        const account = asAddress(session?.address, "Smart account");
        const [membership, pending] = await Promise.all([
          publicClient.readContract({
            address: pool,
            abi: confidentialPrizePoolAbi,
            functionName: "membershipIndexOf",
            args: [account],
          }),
          publicClient.readContract({
            address: pool,
            abi: confidentialPrizePoolAbi,
            functionName: "pendingAdmissionOf",
            args: [account],
          }),
        ]);
        if (scopeRef.current === requestScope)
          setParticipationPending(membership === 0n && pending.requested);
        refreshedCreditOperationsRef.current.add(operationKey);
        setCreditRefreshAction(undefined);
      } catch {
        if (scopeRef.current === requestScope) {
          // The canonical action is complete; only its display reads need another try.
          setWinnings(undefined);
          setWinningsOwner(undefined);
          setCreditRefreshAction(action);
          updateTrackedAction(action.id, {
            status: "updating",
            error: "Your action is complete. Results are updating.",
          });
        }
      }
    },
    [
      addresses.pool,
      decryptWinnings,
      refreshConfidentialBalances,
      runtime.mode2,
      scope,
      session?.address,
      updateTrackedAction,
    ],
  );

  useEffect(() => {
    for (const action of actions) {
      if (action.status === "completed") void refreshCompletedCredit(action);
    }
  }, [actions, refreshCompletedCredit]);

  async function reviewCreditAction(action: "claimPrize" | "addPrizeToSavings") {
    const currentSession = activeSession();
    if (!ready) throw new Error("Prize claims are unavailable right now.");
    const owner = Symbol(action);
    const controller = new AbortController();
    if (!reviewLeaseRef.current.begin(owner, () => controller.abort())) return;
    const data = encodeFunctionData({
      abi: confidentialPrizePoolAbi,
      functionName: action === "claimPrize" ? "claimPrize" : "claimPrizeToSavings",
      args: [],
    });
    try {
      const prepared = await currentSession.prepareTransaction(
        [{ to: asAddress(addresses.pool, "Prize pool"), data }],
        { signal: controller.signal },
      );
      if (!reviewLeaseRef.current.ready(owner, prepared.cancel)) {
        prepared.cancel();
        return;
      }
      setCreditReview({ action, owner, prepared });
    } catch (error) {
      reviewLeaseRef.current.release(owner);
      if (!controller.signal.aborted) throw error;
    }
  }

  function confirmCreditAction(review: CreditReview) {
    if (!reviewLeaseRef.current.confirm(review.owner)) return;
    runAction(
      {
        label: review.action === "claimPrize" ? "Claim prize" : "Add prize to savings",
        type: "claim",
        account: session?.address,
        creditScope: {
          kind: "prize-credit",
          action: review.action,
          pool: asAddress(addresses.pool, "Prize pool"),
          mode: runtime.mode2 ? "2" : "legacy1",
        },
      },
      async ({ update }) => {
        update({ status: "waiting-wallet" });
        try {
          await review.prepared.send({
            onOperationPrepared: (operation) => {
              pendingCreditOwnersRef.current.set(drawOperationKey(operation), review.owner);
              update({ status: "confirming", operation });
            },
          });
          update({ status: "completed" });
          reviewLeaseRef.current.complete(review.owner);
        } catch (error) {
          if (
            error instanceof SafeUserOperationFailedError ||
            error instanceof SafeUserOperationNotSubmittedError ||
            error instanceof SafeUserOperationRejectedError
          ) {
            pendingCreditOwnersRef.current.delete(drawOperationKey(error.operation));
            reviewLeaseRef.current.complete(review.owner);
          }
          throw error;
        } finally {
          setCreditReview((current) => (current === review ? undefined : current));
        }
      },
    );
  }

  function runPrizeAction(action: PrizeActionId) {
    if (creditReview) {
      confirmCreditAction(creditReview);
      return;
    }
    if (action === "addPrizeToSavings") {
      return void reviewCreditAction(action).catch((error) => {
        const description = "Please review your request again.";
        reportClientToast(
          { title: "Unable to prepare", description },
          { action, stage: "preparing" },
          error,
        );
        toast({ tone: "error", title: "Unable to prepare", description });
      });
    }
    if (action === "claimPrize") {
      return void reviewCreditAction(action).catch((error) => {
        const description = "Please review your request again.";
        reportClientToast(
          { title: "Unable to prepare", description },
          { action, stage: "preparing" },
          error,
        );
        toast({ tone: "error", title: "Unable to prepare", description });
      });
    }
    return run(decryptWinnings, "Winnings revealed.", "checkPrize");
  }

  async function run(
    action: () => Promise<void | false | ToastInput>,
    ok: string,
    currentAction?: WorkingAction,
  ) {
    setStatus("working");
    setWorkingAction(currentAction);
    let stale = false;
    try {
      const completed = await action();
      stale = completed === false;
      if (completed === false) return;
      setStatus("success");
      toast(completed ?? { tone: "success", title: ok });
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      reportClientToast(
        { title: "Transaction failed", description: errorMessage },
        { action: currentAction ?? "draw", stage: "execution" },
        error,
      );
      setStatus("error");
      toast({ tone: "error", title: "Transaction failed", description: errorMessage });
    } finally {
      if (stale) setStatus("idle");
      setWorkingAction(undefined);
    }
  }

  return (
    <div className="space-y-5">
      <section className="space-y-3">
        <h1 className="font-display text-3xl font-bold leading-tight">Results and winnings.</h1>
        <p className="text-sm leading-relaxed text-muted">
          See when results are expected and check whether you have winnings to claim.
        </p>
      </section>

      <TestnetWarning />

      <div className="card space-y-3">
        <p className="label">Next result</p>
        <Countdown target={nextDrawAt} />
        <div className="grid gap-2 text-sm">
          <div className="flex items-center justify-between">
            <span className="text-muted">Schedule</span>
            <span className="font-semibold text-right">{formatDateTime(nextDrawAt)}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-muted">Recurrence</span>
            <span className="font-semibold">{formatInterval(drawInterval)}</span>
          </div>
        </div>
      </div>

      <DrawPoolSummary
        activeDrawId={activeDrawId}
        participantCount={participantCount}
        publicPrizeReserve={publicPrizeReserve}
        roundsClosed={roundsClosed}
      />

      {mode2 && session && ready && isAddress(addresses.pool) && (
        <PrizeHistory
          account={getAddress(session.address)}
          pool={getAddress(addresses.pool)}
          proofUrl={runtime.proofUrl}
          reviewLease={reviewLeaseRef.current}
          session={session}
        />
      )}

      <PrizeCreditPanel
        actions={displayedPrizeActions}
        onAction={(action) => void runPrizeAction(action)}
        winnings={visibleWinnings}
      />
      {creditRefreshAction && (
        <button
          className="btn-secondary w-full"
          onClick={() => void refreshCompletedCredit(creditRefreshAction)}
        >
          Refresh winnings
        </button>
      )}
      {participationPending && (
        <p className="text-sm text-muted">
          Your savings are waiting to be included in a future draw. Review participation in Savings.
        </p>
      )}
    </div>
  );
}

function isCreditScope(value: unknown): value is NonNullable<AsyncAction["creditScope"]> {
  const pool =
    typeof value === "object" && value !== null ? (value as { pool?: unknown }).pool : undefined;
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { kind?: unknown }).kind === "prize-credit" &&
    ((value as { action?: unknown }).action === "claimPrize" ||
      (value as { action?: unknown }).action === "addPrizeToSavings") &&
    typeof pool === "string" &&
    isAddress(pool) &&
    ((value as { mode?: unknown }).mode === "legacy1" || (value as { mode?: unknown }).mode === "2")
  );
}
