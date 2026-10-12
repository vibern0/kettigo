"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createPublicClient, encodeFunctionData, getAddress, http, isAddress } from "viem";
import { sepolia } from "viem/chains";
import {
  CONTRACTS,
  RPC_URL,
  confidentialPrizePoolAbi,
} from "@/lib/contracts";
import { Countdown } from "@/components/Countdown";
import { formatUSDC } from "@/lib/format";
import { useWallet } from "@/lib/wallet-context";
import { sendSmartTransaction, type PasskeySmartSession } from "@/lib/smart-session";
import {
  asChecksumAddress,
  createSmartZamaSDK,
  decryptUint64,
  isZeroEncryptedHandle,
} from "@/lib/zama";
import { useToast } from "@/components/Toast";
import { getPrizeActions, type PrizeActionId } from "@/lib/prize-actions";
import {
  createLatestBlockRefresher,
  readProjectedMorphoYield,
} from "@/lib/morpho-yield";

type Status = "idle" | "working" | "success" | "error";
type WorkingAction = PrizeActionId | undefined;

type DrawSnapshot = {
  blockNumber: bigint;
  source: "projected" | "stored";
  drawId: bigint;
  drawInterval: bigint;
  nextDrawAt: bigint;
  participantCount: bigint;
  publicPrizeReserve: bigint;
  accruedYieldAssets: bigint;
};

const publicClient = createPublicClient({
  chain: sepolia,
  transport: http(RPC_URL),
});

function asAddress(value: unknown, label: string) {
  return asChecksumAddress(value, label);
}

function getErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /encrypted|confidential|public|private|mock|testnet|sepolia|prototype|faucet|leakage|decrypted/i.test(message)
    ? "Something went wrong. Please try again."
    : message;
}

function formatDateTime(timestamp: bigint | undefined) {
  if (timestamp === undefined) return "-";
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(Number(timestamp) * 1000));
}

function formatInterval(seconds: bigint | undefined) {
  if (seconds === undefined) return "-";
  const value = Number(seconds);
  const unit = (amount: number, singular: string, plural: string) =>
    `${amount} ${amount === 1 ? singular : plural}`;

  if (value > 86_400) {
    const days = Math.floor(value / 86_400);
    const hours = Math.floor((value % 86_400) / 3_600);
    return hours > 0
      ? `${unit(days, "day", "days")} ${unit(hours, "hour", "hours")}`
      : unit(days, "day", "days");
  }

  if (value > 3_600) {
    const hours = Math.floor(value / 3_600);
    const minutes = Math.floor((value % 3_600) / 60);
    return minutes > 0
      ? `${unit(hours, "hour", "hours")} ${unit(minutes, "minute", "minutes")}`
      : unit(hours, "hour", "hours");
  }

  if (value > 60) return unit(Math.round(value / 60), "minute", "minutes");
  return unit(value, "second", "seconds");
}

async function readDrawSnapshot(
  pool: `0x${string}`,
  requestedBlockNumber?: bigint,
): Promise<DrawSnapshot> {
  const blockNumber = requestedBlockNumber ?? await publicClient.getBlockNumber();
  const [
    drawId,
    drawInterval,
    nextDrawAt,
    participantCount,
    publicPrizeReserve,
    projectedYield,
  ] = await Promise.all([
    publicClient.readContract({
      address: pool,
      abi: confidentialPrizePoolAbi,
      functionName: "drawId",
      blockNumber,
    }),
    publicClient.readContract({
      address: pool,
      abi: confidentialPrizePoolAbi,
      functionName: "drawInterval",
      blockNumber,
    }),
    publicClient.readContract({
      address: pool,
      abi: confidentialPrizePoolAbi,
      functionName: "nextDrawAt",
      blockNumber,
    }),
    publicClient.readContract({
      address: pool,
      abi: confidentialPrizePoolAbi,
      functionName: "participantCount",
      blockNumber,
    }),
    publicClient.readContract({
      address: pool,
      abi: confidentialPrizePoolAbi,
      functionName: "publicPrizeReserve",
      blockNumber,
    }),
    readProjectedMorphoYield(publicClient, pool, blockNumber),
  ]);

  return {
    blockNumber,
    source: projectedYield.source,
    drawId,
    drawInterval,
    nextDrawAt,
    participantCount,
    publicPrizeReserve,
    accruedYieldAssets: projectedYield.accruedYieldAssets,
  };
}

// Draw page for checking prizes, claiming winnings, and viewing round timing.
export default function DrawPage() {
  const { session, refreshConfidentialBalances } = useWallet();
  const toast = useToast();
  const [status, setStatus] = useState<Status>("idle");
  const [workingAction, setWorkingAction] = useState<WorkingAction>();
  const [drawId, setDrawId] = useState<bigint | undefined>();
  const [drawInterval, setDrawInterval] = useState<bigint | undefined>();
  const [nextDrawAt, setNextDrawAt] = useState<bigint | undefined>();
  const [participantCount, setParticipantCount] = useState<bigint | undefined>();
  const [publicPrizeReserve, setPublicPrizeReserve] = useState<bigint | undefined>();
  const [accruedYieldAssets, setAccruedYieldAssets] = useState<bigint | undefined>();
  const [winnings, setWinnings] = useState<bigint | undefined>();
  const refreshRef = useRef<(blockNumber?: bigint) => Promise<void>>(async () => undefined);
  const addresses = useMemo(
    () => ({
      pool: isAddress(CONTRACTS.confidentialPrizePool)
        ? getAddress(CONTRACTS.confidentialPrizePool)
        : CONTRACTS.confidentialPrizePool,
    }),
    [],
  );

  const ready = isAddress(addresses.pool);
  const activeDrawId = drawId === undefined ? undefined : drawId + 1n;
  const roundsClosed = drawId ?? 0n;
  const hasPrizeToClaim = winnings !== undefined && winnings > 0n;
  const prizeAssets =
    publicPrizeReserve === undefined || accruedYieldAssets === undefined
      ? undefined
      : publicPrizeReserve + accruedYieldAssets;
  const prizeActions = getPrizeActions({
    connected: Boolean(session),
    ready,
    busy: status === "working",
    hasPrizeToClaim,
    workingAction,
  });

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
        setAccruedYieldAssets(snapshot.accruedYieldAssets);
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
    if (!session?.address) return;
    void refresh();
  }, [session?.address]);

  function activeSession() {
    if (!session) throw new Error("Connect your smart account first.");
    return session;
  }

  async function sendTx(currentSession: PasskeySmartSession, to: `0x${string}`, data: `0x${string}`) {
    const tx = await sendSmartTransaction(currentSession, to, data);
    await publicClient.waitForTransactionReceipt({ hash: tx });
  }

  async function refresh() {
    await refreshRef.current();
  }

  async function decryptWinnings() {
    const currentSession = activeSession();
    const user = currentSession.address;
    if (!ready) throw new Error("Prize checks are unavailable right now.");

    const pool = asAddress(addresses.pool, "Prize pool");
    const handle = await publicClient.readContract({
      address: pool,
      abi: confidentialPrizePoolAbi,
      functionName: "encryptedWinningsOf",
      args: [user],
    });

    if (isZeroEncryptedHandle(handle)) {
      setWinnings(0n);
      return;
    }

    const sdk = createSmartZamaSDK(currentSession);
    try {
      setWinnings(await decryptUint64(sdk, handle as `0x${string}`, pool));
    } finally {
      sdk.terminate();
    }
  }

  async function claimPrize() {
    const currentSession = activeSession();
    if (!ready) throw new Error("Prize claims are unavailable right now.");

    const data = encodeFunctionData({
      abi: confidentialPrizePoolAbi,
      functionName: "claimPrize",
      args: [],
    });
    await sendTx(currentSession, asAddress(addresses.pool, "Prize pool"), data);
    setWinnings(undefined);
    await refresh();
    await refreshConfidentialBalances();
  }

  async function claimPrizeToSavings() {
    const currentSession = activeSession();
    if (!ready) throw new Error("Prize claims are unavailable right now.");

    const data = encodeFunctionData({
      abi: confidentialPrizePoolAbi,
      functionName: "claimPrizeToSavings",
      args: [],
    });
    await sendTx(currentSession, asAddress(addresses.pool, "Prize pool"), data);
    setWinnings(undefined);
    await refresh();
    await refreshConfidentialBalances();
  }

  function runPrizeAction(action: PrizeActionId) {
    if (action === "addPrizeToSavings") {
      return run(claimPrizeToSavings, "Prize added to savings.", "addPrizeToSavings");
    }
    if (action === "claimPrize") {
      return run(claimPrize, "Prize claimed.", "claimPrize");
    }
    return run(decryptWinnings, "Winnings revealed.", "checkPrize");
  }

  async function run(action: () => Promise<void>, ok: string, currentAction?: WorkingAction) {
    setStatus("working");
    setWorkingAction(currentAction);
    try {
      await action();
      setStatus("success");
      toast({ tone: "success", title: ok });
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      setStatus("error");
      toast({ tone: "error", title: "Transaction failed", description: errorMessage });
    } finally {
      setWorkingAction(undefined);
    }
  }

  return (
    <div className="space-y-5 animate-fade-in">
      <section className="space-y-3">
        <h1 className="font-display text-3xl font-bold leading-tight">
          Global state.
          <br />
          Prizes and rounds.
        </h1>
        <p className="text-sm leading-relaxed text-muted">
          See the draw schedule, how many accounts are participating, and claim
          your prize when you have one.
        </p>
      </section>

      <div className="card space-y-3">
        <p className="label">Next draw</p>
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

      <div className="card space-y-3">
        <p className="label">Global pool</p>
        <div className="grid grid-cols-2 gap-3">
          <div className="rounded-2xl bg-white/35 border border-white/50 p-3 min-h-24">
            <p className="text-xs text-muted">Active round</p>
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
            <p className="text-xs text-muted">Closed rounds</p>
            <p className="font-display text-2xl font-bold tabular-nums">
              {roundsClosed.toString()}
            </p>
          </div>
          <div className="rounded-2xl bg-white/35 border border-white/50 p-3 min-h-24">
            <p className="text-xs text-muted">Prize</p>
            <p className="font-display text-xl font-bold tabular-nums">
              {formatUSDC(prizeAssets, 6)} USDC
            </p>
          </div>
        </div>
      </div>

      <div className="card space-y-3">
        <div>
          <p className="label">My winnings</p>
          <p className="mt-1 text-xs leading-relaxed text-muted">
            At the end of each draw, your account may be eligible for a prize.
            Check here, then claim it when you have one.
          </p>
        </div>
        <div className="flex min-h-20 items-center justify-between gap-3 rounded-2xl border border-white/50 bg-white/35 px-4 py-3">
          <span className="text-xs font-semibold text-muted">Prize ready</span>
          <span className="min-w-32 max-w-[68%] text-right font-display text-2xl font-bold leading-none tabular-nums text-brand break-words">
            {formatUSDC(winnings, 6)} USDC
          </span>
        </div>
        {prizeActions.map((action) => (
          <button
            key={action.id}
            className={`${action.variant === "primary" ? "btn-primary" : "btn-secondary"} w-full`}
            disabled={action.disabled}
            onClick={() => void runPrizeAction(action.id)}
          >
            {action.label}
          </button>
        ))}
      </div>

    </div>
  );
}
