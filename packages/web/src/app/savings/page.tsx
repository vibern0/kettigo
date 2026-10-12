"use client";

import { useEffect, useMemo, useState } from "react";
import { flushSync } from "react-dom";
import { createPublicClient, encodeEventTopics, encodeFunctionData, getAddress, http, isAddress, parseEventLogs, toHex, zeroAddress, zeroHash } from "viem";
import { sepolia } from "viem/chains";
import {
  CONTRACTS,
  RPC_URL,
  confidentialPrizePoolAbi,
  confidentialUsdcAbi,
  erc20Abi,
} from "@/lib/contracts";
import { formatUSDC, parseUSDC } from "@/lib/format";
import { useWallet } from "@/lib/wallet-context";
import { sendSmartTransaction, sendSmartTransactionBatch, type PasskeySmartSession } from "@/lib/smart-session";
import {
  asChecksumAddress,
  createPublicZamaSDK,
  createSmartZamaSDK,
  decryptPublicUint64,
  encryptUint64,
} from "@/lib/zama";
import { afterNextPaint } from "@/lib/paint";
import { useToast } from "@/components/Toast";
import { AmountInput } from "@/components/AmountInput";
import { LoadingAmount } from "@/components/LoadingAmount";
import { useActionCenter } from "@/components/ActionCenter";
import type { ActionPatch } from "@/lib/action-center-model";
import {
  balanceBucketLabels,
  deriveWithdrawalStage,
  finalizationOutcome,
  mergePendingWithdrawals,
  pendingWithdrawalBatchLabel,
  pendingWithdrawalTotal,
  serializePendingWithdrawals,
  withdrawalStageCopy,
  type PendingWithdrawal,
  type WithdrawalBatchStatus,
  type WithdrawalStage,
} from "@/lib/withdrawal-state";

type Status = "idle" | "working" | "success" | "error";
type WorkingAction = "deposit" | "withdraw" | "pending" | undefined;
type SheetStep = "entry" | "confirm";

const PENDING_UNWRAPS_STORAGE_PREFIX = "kettigo:pending-unwraps";
const PENDING_WITHDRAWALS_STORAGE_PREFIX = "kettigo:pending-withdrawals";
const UNWRAP_LOG_LOOKBACK_BLOCKS = 512n;
const WITHDRAWAL_LOG_LOOKBACK_BLOCKS = 10_000n;
const MAX_USER_PRINCIPAL = 1_000_000_000n;

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

type PendingUnwrap = {
  requestId: `0x${string}`;
  txHash: `0x${string}`;
};

type PendingWithdrawalView = PendingWithdrawal & {
  stage: WithdrawalStage;
  closesAt?: bigint;
};

function isHexString(value: unknown): value is `0x${string}` {
  return typeof value === "string" && value.startsWith("0x");
}

function pendingUnwrapStorageKey(token: `0x${string}`, user: `0x${string}`) {
  return `${PENDING_UNWRAPS_STORAGE_PREFIX}:${token}:${user}`;
}

function pendingWithdrawalStorageKey(pool: `0x${string}`, user: `0x${string}`) {
  return `${PENDING_WITHDRAWALS_STORAGE_PREFIX}:${pool}:${user}`;
}

function readStoredPendingUnwraps(token: `0x${string}`, user: `0x${string}`) {
  if (typeof window === "undefined") return [];

  try {
    const stored = JSON.parse(window.localStorage.getItem(pendingUnwrapStorageKey(token, user)) ?? "[]");
    if (!Array.isArray(stored)) return [];

    return stored.filter(
      (request): request is PendingUnwrap => isHexString(request?.requestId) && isHexString(request?.txHash),
    );
  } catch {
    return [];
  }
}

function writeStoredPendingUnwraps(token: `0x${string}`, user: `0x${string}`, requests: PendingUnwrap[]) {
  if (typeof window === "undefined") return;

  window.localStorage.setItem(pendingUnwrapStorageKey(token, user), JSON.stringify(requests));
}

function readStoredPendingWithdrawals(pool: `0x${string}`, user: `0x${string}`) {
  if (typeof window === "undefined") return [];

  try {
    const stored = JSON.parse(window.localStorage.getItem(pendingWithdrawalStorageKey(pool, user)) ?? "[]");
    if (!Array.isArray(stored)) return [];

    return stored
      .map((request): PendingWithdrawal | undefined => {
        if (!isHexString(request?.txHash)) return undefined;
        if (typeof request.batchId !== "string") return undefined;
        return {
          batchId: BigInt(request.batchId),
          txHash: request.txHash,
          amount: typeof request.amount === "string" ? BigInt(request.amount) : undefined,
          unwrapRequestId: isHexString(request.unwrapRequestId) ? request.unwrapRequestId : undefined,
        };
      })
      .filter((request): request is PendingWithdrawal => request !== undefined);
  } catch {
    return [];
  }
}

function writeStoredPendingWithdrawals(pool: `0x${string}`, user: `0x${string}`, requests: PendingWithdrawal[]) {
  if (typeof window === "undefined") return;

  window.localStorage.setItem(
    pendingWithdrawalStorageKey(pool, user),
    JSON.stringify(serializePendingWithdrawals(requests)),
  );
}

function batchStatusFromContract(status: number): WithdrawalBatchStatus {
  if (status === 0) return "open";
  if (status === 1) return "closed";
  return "funded";
}

function formatShortHash(hash: `0x${string}`) {
  return hash.replace(/^0x/, "").slice(0, 6);
}

// Savings page for deposits, withdrawals, and pending unwrap requests.
export default function SavingsPage() {
  const {
    session,
    principal,
    confidentialBalancesLoading,
    confidentialBalancesError,
    refreshConfidentialBalances,
  } = useWallet();
  const toast = useToast();
  const { runAction } = useActionCenter();
  const [depositAmount, setDepositAmount] = useState("");
  const [withdrawAmount, setWithdrawAmount] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [workingAction, setWorkingAction] = useState<WorkingAction>();
  const [usdcBalance, setUsdcBalance] = useState<bigint | undefined>();
  const [allowance, setAllowance] = useState<bigint | undefined>();
  const [pendingUnwraps, setPendingUnwraps] = useState<PendingUnwrap[]>([]);
  const [pendingWithdrawals, setPendingWithdrawals] = useState<PendingWithdrawalView[]>([]);
  const [automaticWithdrawals, setAutomaticWithdrawals] = useState(false);
  const [withdrawalRefreshError, setWithdrawalRefreshError] = useState(false);
  const [depositSheetStep, setDepositSheetStep] = useState<SheetStep>();
  const [withdrawSheetStep, setWithdrawSheetStep] = useState<SheetStep>();
  const [confirmingAction, setConfirmingAction] = useState<"deposit" | "withdraw">();

  const addresses = useMemo(
    () => ({
      usdc: isAddress(CONTRACTS.usdc) ? getAddress(CONTRACTS.usdc) : CONTRACTS.usdc,
      confidentialUsdc: isAddress(CONTRACTS.confidentialUsdc)
        ? getAddress(CONTRACTS.confidentialUsdc)
        : CONTRACTS.confidentialUsdc,
      pool: isAddress(CONTRACTS.confidentialPrizePool)
        ? getAddress(CONTRACTS.confidentialPrizePool)
        : CONTRACTS.confidentialPrizePool,
    }),
    [],
  );

  const usdcReady = isAddress(addresses.usdc);
  const wrapperReady = usdcReady && isAddress(addresses.confidentialUsdc);
  const poolReady = wrapperReady && isAddress(addresses.pool);
  const hasWithdrawablePrincipal = principal !== undefined && principal > 0n;
  const withdrawalUnwrapIds = new Set(
    pendingWithdrawals
      .map((request) => request.unwrapRequestId?.toLowerCase())
      .filter((requestId): requestId is string => requestId !== undefined),
  );
  const standalonePendingUnwraps = pendingUnwraps.filter(
    (request) => !withdrawalUnwrapIds.has(request.requestId.toLowerCase()),
  );
  const showWithdraw = hasWithdrawablePrincipal || pendingWithdrawals.length > 0 || standalonePendingUnwraps.length > 0;
  const withdrawalInProgress = pendingWithdrawalTotal(pendingWithdrawals);

  useEffect(() => {
    if (!session?.address) return;
    void refreshBalances(session.address);
    void refreshPendingUnwraps(session.address);
    void refreshPendingWithdrawals(session.address);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.address, poolReady]);

  useEffect(() => {
    if (!session?.address || !poolReady) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        await refreshPendingWithdrawals(session!.address);
        await refreshBalances(session!.address);
        if (!stopped) setWithdrawalRefreshError(false);
      } catch {
        if (!stopped) setWithdrawalRefreshError(true);
      }
      if (!stopped) timer = setTimeout(() => void poll(), 15_000);
    }
    timer = setTimeout(() => void poll(), 15_000);
    return () => { stopped = true; clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.address, poolReady]);

  const sheetOpen = Boolean(depositSheetStep || withdrawSheetStep);

  useEffect(() => {
    if (!sheetOpen) return;

    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setDepositSheetStep(undefined);
        setWithdrawSheetStep(undefined);
      }
    }

    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [sheetOpen]);

  function activeSession() {
    if (!session) throw new Error("Connect your smart account first.");
    return session;
  }

  async function refreshBalances(user = session?.address) {
    if (!user || !usdcReady) return;

    const balance = await publicClient.readContract({
      address: asAddress(addresses.usdc, "USDC"),
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [user],
    });

    const approved = wrapperReady
      ? await publicClient.readContract({
          address: asAddress(addresses.usdc, "USDC"),
          abi: erc20Abi,
          functionName: "allowance",
          args: [user, asAddress(addresses.confidentialUsdc, "Savings token")],
        })
      : undefined;

    setUsdcBalance(balance);
    setAllowance(approved);
  }

  async function sendTx(currentSession: PasskeySmartSession, to: `0x${string}`, data: `0x${string}`) {
    const tx = await sendSmartTransaction(currentSession, to, data);
    return publicClient.waitForTransactionReceipt({ hash: tx });
  }

  function rememberUnwrapRequest(
    receipt: Awaited<ReturnType<typeof publicClient.waitForTransactionReceipt>>,
    user: `0x${string}`,
  ) {
    const events = parseEventLogs({
      abi: confidentialUsdcAbi,
      eventName: "UnwrapRequested",
      logs: receipt.logs,
    });
    const requestId = events.at(-1)?.args.unwrapRequestId;
    if (requestId) {
      const token = asAddress(addresses.confidentialUsdc, "Savings token");
      setPendingUnwraps((current) => {
        const next = [{ requestId, txHash: receipt.transactionHash }, ...current.filter((request) => request.requestId !== requestId)];
        writeStoredPendingUnwraps(token, user, next);
        return next;
      });
    }
    return requestId;
  }

  async function getUnwrapLogs(
    eventName: "UnwrapRequested" | "UnwrapFinalized",
    receiver: `0x${string}`,
    fromBlock: bigint,
    toBlock: bigint,
  ) {
    const token = asAddress(addresses.confidentialUsdc, "Savings token");
    const chunkSize = 1_000n;
    const logs = [];

    for (let start = fromBlock; start <= toBlock; start += chunkSize + 1n) {
      const end = start + chunkSize > toBlock ? toBlock : start + chunkSize;
      const topics = encodeEventTopics({
        abi: confidentialUsdcAbi,
        eventName,
        args: { receiver },
      });
      const chunk = await publicClient.request({
        method: "eth_getLogs",
        params: [
          {
            address: token,
            topics,
            fromBlock: toHex(start),
            toBlock: toHex(end),
          },
        ],
      });
      logs.push(...chunk);
    }

    return logs;
  }

  async function getWithdrawalLogs(
    eventName: "WithdrawalRequested" | "WithdrawalClaimedToUsdc",
    account: `0x${string}`,
    fromBlock: bigint,
    toBlock: bigint,
  ) {
    const pool = asAddress(addresses.pool, "Prize pool");
    const chunkSize = 1_000n;
    const logs = [];

    for (let start = fromBlock; start <= toBlock; start += chunkSize + 1n) {
      const end = start + chunkSize > toBlock ? toBlock : start + chunkSize;
      const topics = encodeEventTopics({
        abi: confidentialPrizePoolAbi,
        eventName,
        args: { account },
      });
      const chunk = await publicClient.request({
        method: "eth_getLogs",
        params: [
          {
            address: pool,
            topics,
            fromBlock: toHex(start),
            toBlock: toHex(end),
          },
        ],
      });
      logs.push(...chunk);
    }

    return logs;
  }

  async function refreshPendingUnwraps(user = session?.address) {
    if (!user || !wrapperReady) return;

    const token = asAddress(addresses.confidentialUsdc, "Savings token");
    const stored = readStoredPendingUnwraps(token, user);
    const latestBlock = await publicClient.getBlockNumber();
    const fromBlock = latestBlock > UNWRAP_LOG_LOOKBACK_BLOCKS ? latestBlock - UNWRAP_LOG_LOOKBACK_BLOCKS : 0n;
    let discovered: PendingUnwrap[] = [];

    try {
      const [requestedLogs, finalizedLogs] = await Promise.all([
        getUnwrapLogs("UnwrapRequested", user, fromBlock, latestBlock),
        getUnwrapLogs("UnwrapFinalized", user, fromBlock, latestBlock),
      ]);
      const requested = parseEventLogs({
        abi: confidentialUsdcAbi,
        eventName: "UnwrapRequested",
        logs: requestedLogs,
      });
      const finalized = parseEventLogs({
        abi: confidentialUsdcAbi,
        eventName: "UnwrapFinalized",
        logs: finalizedLogs,
      });
      const finalizedIds = new Set(finalized.map((event) => event.args.unwrapRequestId?.toLowerCase()));

      discovered = requested
        .map((event) => {
          const requestId = event.args.unwrapRequestId;
          if (!requestId || finalizedIds.has(requestId.toLowerCase())) return undefined;
          return { requestId, txHash: event.transactionHash };
        })
        .filter((request): request is PendingUnwrap => request !== undefined);
    } catch {
      discovered = [];
    }

    const byId = new Map<string, PendingUnwrap>();
    for (const request of [...stored, ...discovered]) {
      byId.set(request.requestId.toLowerCase(), request);
    }

    const pending = (
      await Promise.all(
        Array.from(byId.values()).map(async (request) => {
          try {
            const requester = await publicClient.readContract({
              address: token,
              abi: confidentialUsdcAbi,
              functionName: "unwrapRequester",
              args: [request.requestId],
            });
            if (requester.toLowerCase() !== user.toLowerCase()) return undefined;
            return request;
          } catch {
            return request;
          }
        }),
      )
    ).filter((request): request is PendingUnwrap => request !== undefined);

    const next = pending.reverse();
    setPendingUnwraps(next);
    writeStoredPendingUnwraps(token, user, next);
  }

  async function finalizeUnwrap(requestId: `0x${string}`) {
    const currentSession = activeSession();
    const user = currentSession.address;
    if (!wrapperReady) throw new Error("Withdrawals are unavailable right now.");

    const token = asAddress(addresses.confidentialUsdc, "Savings token");
    const sdk = createPublicZamaSDK();
    const decrypted = await decryptPublicUint64(sdk, requestId).finally(() => sdk.terminate());
    const clearValue = decrypted.clearValue;
    if (finalizationOutcome(clearValue) === "invariant-error") throw new Error("Withdrawal needs support. Please contact us.");
    const data = encodeFunctionData({
      abi: confidentialUsdcAbi,
      functionName: "finalizeUnwrap",
      args: [requestId, clearValue, decrypted.decryptionProof],
    });
    await sendTx(currentSession, token, data);
    await refreshBalances(user);
    await refreshPendingUnwraps(user);
    await refreshPendingWithdrawals(user);
  }

  async function depositConfidential(value: bigint, update: (patch: ActionPatch) => void) {
    const currentSession = activeSession();
    const user = currentSession.address;
    if (value === 0n) throw new Error("Valor invalido.");
    if (!poolReady) throw new Error("Deposits are unavailable right now.");
    const maxDeposit = remainingDepositCapacity();
    if (value > maxDeposit) throw new Error("Amount is above the current account limit.");

    const usdc = asAddress(addresses.usdc, "USDC");
    const token = asAddress(addresses.confidentialUsdc, "Savings token");
    const pool = asAddress(addresses.pool, "Prize pool");
    const sdk = createSmartZamaSDK(currentSession);
    const encrypted = await encryptUint64(sdk, token, user, value).finally(() => sdk.terminate());
    const wrapCall = encodeFunctionData({
      abi: confidentialUsdcAbi,
      functionName: "wrap",
      args: [user, value],
    });
    const depositCall = encodeFunctionData({
      abi: confidentialUsdcAbi,
      functionName: "confidentialTransferAndCall",
      args: [
        pool,
        encrypted.handle,
        encrypted.inputProof,
        "0x",
      ],
    });
    const data = encodeFunctionData({
      abi: confidentialUsdcAbi,
      functionName: "multicall",
      args: [[wrapCall, depositCall]],
    });
    const calls = [];
    if ((allowance ?? 0n) < value) {
      calls.push({
        to: usdc,
        data: encodeFunctionData({
          abi: erc20Abi,
          functionName: "approve",
          args: [token, value],
        }),
      });
    }
    calls.push({ to: token, data });

    update({ status: "waiting-wallet" });
    const tx = await sendSmartTransactionBatch(currentSession, calls);
    update({ status: "submitted", txHash: tx });
    update({ status: "confirming" });
    await publicClient.waitForTransactionReceipt({ hash: tx });
    update({ status: "updating" });
    setDepositAmount("");
    await refreshConfidentialBalances();
    await refreshBalances(user);
  }

  async function withdrawConfidential(value: bigint, update: (patch: ActionPatch) => void) {
    const currentSession = activeSession();
    const user = currentSession.address;
    if (value === 0n) throw new Error("Valor invalido.");
    if (!poolReady) throw new Error("Withdrawals are unavailable right now.");

    const pool = asAddress(addresses.pool, "Prize pool");
    const sdk = createSmartZamaSDK(currentSession);
    const encrypted = await encryptUint64(sdk, pool, user, value).finally(() => sdk.terminate());
    const data = encodeFunctionData({
      abi: confidentialPrizePoolAbi,
      functionName: "requestWithdrawal",
      args: [encrypted.handle, encrypted.inputProof],
    });
    update({ status: "waiting-wallet" });
    const tx = await sendSmartTransaction(currentSession, pool, data);
    update({ status: "submitted", txHash: tx });
    update({ status: "confirming" });
    const receipt = await publicClient.waitForTransactionReceipt({ hash: tx });
    update({ status: "updating" });
    rememberWithdrawalRequest(receipt, user, value);
    await refreshBalances(user);
    setWithdrawAmount("");
    await refreshConfidentialBalances();
    await refreshPendingWithdrawals(user);
  }

  function rememberWithdrawalRequest(
    receipt: Awaited<ReturnType<typeof publicClient.waitForTransactionReceipt>>,
    user: `0x${string}`,
    amount: bigint,
  ) {
    const events = parseEventLogs({
      abi: confidentialPrizePoolAbi,
      eventName: "WithdrawalRequested",
      logs: receipt.logs,
    });
    const batchId = events.at(-1)?.args.batchId;
    if (batchId === undefined) return;

    const pool = asAddress(addresses.pool, "Prize pool");
    setPendingWithdrawals((current) => {
      const next: PendingWithdrawalView[] = [
        {
          batchId,
          txHash: receipt.transactionHash,
          amount: amount + (current.find((request) => request.batchId === batchId)?.amount ?? 0n),
          stage: "requested",
        },
        ...current.filter((request) => request.batchId !== batchId),
      ];
      writeStoredPendingWithdrawals(pool, user, next);
      return next;
    });
  }

  async function refreshPendingWithdrawals(user = session?.address) {
    if (!user || !poolReady) return;

    const pool = asAddress(addresses.pool, "Prize pool");
    let automatic = false;
    try {
      await publicClient.readContract({ address: pool, abi: confidentialPrizePoolAbi, functionName: "withdrawalAccounts", args: [0n] });
      automatic = true;
    } catch { /* Older pools require an account-authorized claim. */ }
    setAutomaticWithdrawals(automatic);
    const stored = readStoredPendingWithdrawals(pool, user);
    const token = wrapperReady ? asAddress(addresses.confidentialUsdc, "Savings token") : undefined;
    const latestBlock = await publicClient.getBlockNumber();
    const fromBlock = latestBlock > UNWRAP_LOG_LOOKBACK_BLOCKS ? latestBlock - UNWRAP_LOG_LOOKBACK_BLOCKS : 0n;
    const withdrawalFromBlock =
      latestBlock > WITHDRAWAL_LOG_LOOKBACK_BLOCKS ? latestBlock - WITHDRAWAL_LOG_LOOKBACK_BLOCKS : 0n;
    let finalizedIds = new Set<string>();
    let discovered: PendingWithdrawal[] = [];

    if (token) {
      try {
        const finalizedLogs = await getUnwrapLogs("UnwrapFinalized", user, fromBlock, latestBlock);
        const finalized = parseEventLogs({
          abi: confidentialUsdcAbi,
          eventName: "UnwrapFinalized",
          logs: finalizedLogs,
        });
        finalizedIds = new Set(finalized.map((event) => event.args.unwrapRequestId?.toLowerCase()));
      } catch {
        finalizedIds = new Set();
      }
    }

    if (automatic) {
      const currentBatch = await publicClient.readContract({ address: pool, abi: confidentialPrizePoolAbi, functionName: "currentWithdrawalBatchId" });
      for (let batchId = 1n; batchId <= currentBatch; batchId++) {
        const [hasClaim, requestId] = await Promise.all([
          publicClient.readContract({ address: pool, abi: confidentialPrizePoolAbi, functionName: "hasWithdrawalClaim", args: [batchId, user] }),
          publicClient.readContract({ address: pool, abi: confidentialPrizePoolAbi, functionName: "withdrawalUnwrapRequest", args: [batchId, user] }),
        ]);
        if (hasClaim || requestId !== zeroHash) discovered.push({ batchId, txHash: zeroHash, unwrapRequestId: requestId === zeroHash ? undefined : requestId });
      }
    } else try {
      const [requestedLogs, claimedLogs] = await Promise.all([
        getWithdrawalLogs("WithdrawalRequested", user, withdrawalFromBlock, latestBlock),
        getWithdrawalLogs("WithdrawalClaimedToUsdc", user, withdrawalFromBlock, latestBlock),
      ]);
      const requested = parseEventLogs({
        abi: confidentialPrizePoolAbi,
        eventName: "WithdrawalRequested",
        logs: requestedLogs,
      });
      const claimed = parseEventLogs({
        abi: confidentialPrizePoolAbi,
        eventName: "WithdrawalClaimedToUsdc",
        logs: claimedLogs,
      });
      const claimedByBatch = new Map(claimed.map((event) => [event.args.batchId, event.args.unwrapRequestId]));

      discovered = requested.map((event) => ({
        batchId: event.args.batchId,
        txHash: event.transactionHash,
        unwrapRequestId: claimedByBatch.get(event.args.batchId),
      }));
    } catch {
      discovered = [];
    }

    const next = (
      await Promise.all(
        mergePendingWithdrawals(stored, discovered).map(async (request): Promise<PendingWithdrawalView | undefined> => {
          if (automatic) {
            const requestId = await publicClient.readContract({ address: pool, abi: confidentialPrizePoolAbi, functionName: "withdrawalUnwrapRequest", args: [request.batchId, user] });
            if (requestId !== zeroHash) request = { ...request, unwrapRequestId: requestId };
          }
          if (request.unwrapRequestId) {
            if (finalizedIds.has(request.unwrapRequestId.toLowerCase())) return undefined;
            const receiver = await publicClient.readContract({ address: token!, abi: confidentialUsdcAbi, functionName: "unwrapRequester", args: [request.unwrapRequestId] });
            if (receiver === zeroAddress) return undefined;
            return { ...request, stage: "finalizing" };
          }

          try {
            const [statusCode, hasClaim, closesAt] = await Promise.all([
              publicClient.readContract({
                address: pool,
                abi: confidentialPrizePoolAbi,
                functionName: "withdrawalBatchStatus",
                args: [request.batchId],
              }),
              publicClient.readContract({
                address: pool,
                abi: confidentialPrizePoolAbi,
                functionName: "hasWithdrawalClaim",
                args: [request.batchId, user],
              }),
              publicClient.readContract({
                address: pool,
                abi: confidentialPrizePoolAbi,
                functionName: "withdrawalBatchClosesAt",
                args: [request.batchId],
              }),
            ]);
            const stage = deriveWithdrawalStage(request, {
              batchStatus: batchStatusFromContract(Number(statusCode)),
              hasClaim,
            });
            if (stage === "complete") return undefined;
            return { ...request, stage, closesAt };
          } catch {
            return { ...request, stage: "requested" };
          }
        }),
      )
    ).filter((request): request is PendingWithdrawalView => request !== undefined);

    setPendingWithdrawals(next);
    writeStoredPendingWithdrawals(pool, user, next);
  }

  async function claimWithdrawal(batchId: bigint) {
    const currentSession = activeSession();
    const user = currentSession.address;
    if (!poolReady) throw new Error("Withdrawals are unavailable right now.");

    const pool = asAddress(addresses.pool, "Prize pool");
    const data = encodeFunctionData({
      abi: confidentialPrizePoolAbi,
      functionName: "claimWithdrawalToUsdc",
      args: [batchId, user],
    });
    const receipt = await sendTx(currentSession, pool, data);
    const requestId = rememberUnwrapRequest(receipt, user);
    if (requestId) {
      setPendingWithdrawals((current) => {
        const next = current.map((request) =>
          request.batchId === batchId ? { ...request, unwrapRequestId: requestId, stage: "finalizing" as const } : request,
        );
        writeStoredPendingWithdrawals(pool, user, next);
        return next;
      });
    }
    await refreshPendingWithdrawals(user);
    await refreshPendingUnwraps(user);
    await refreshConfidentialBalances();
  }

  function closeSheets() {
    if (confirmingAction) return;
    setDepositSheetStep(undefined);
    setWithdrawSheetStep(undefined);
  }

  function parsedAmount(value: string) {
    try {
      return parseUSDC(value);
    } catch {
      return 0n;
    }
  }

  const parsedDepositAmount = parsedAmount(depositAmount);
  const parsedWithdrawAmount = parsedAmount(withdrawAmount);
  const remainingDeposit =
    principal === undefined
      ? MAX_USER_PRINCIPAL
      : principal >= MAX_USER_PRINCIPAL
        ? 0n
        : MAX_USER_PRINCIPAL - principal;
  const depositBalanceAfter =
    usdcBalance === undefined || parsedDepositAmount > usdcBalance ? undefined : usdcBalance - parsedDepositAmount;
  const depositPoolAfter =
    principal === undefined || parsedDepositAmount === 0n || parsedDepositAmount > remainingDeposit
      ? principal
      : principal + parsedDepositAmount;
  const withdrawPoolAfter =
    principal === undefined || parsedWithdrawAmount > principal ? undefined : principal - parsedWithdrawAmount;

  function reviewDeposit() {
    if (parsedDepositAmount === 0n) {
      toast({ tone: "error", title: "Enter an amount first." });
      return;
    }
    if (usdcBalance !== undefined && parsedDepositAmount > usdcBalance) {
      toast({ tone: "error", title: "Amount is above your wallet balance." });
      return;
    }
    if (parsedDepositAmount > remainingDepositCapacity()) {
      toast({ tone: "error", title: "Amount is above the current account limit." });
      return;
    }
    setDepositSheetStep("confirm");
  }

  function remainingDepositCapacity() {
    if (principal === undefined) return MAX_USER_PRINCIPAL;
    return principal >= MAX_USER_PRINCIPAL ? 0n : MAX_USER_PRINCIPAL - principal;
  }

  function reviewWithdraw() {
    if (parsedWithdrawAmount === 0n) {
      toast({ tone: "error", title: "Enter an amount first." });
      return;
    }
    if (principal !== undefined && parsedWithdrawAmount > principal) {
      toast({ tone: "error", title: "Amount is above your pool balance." });
      return;
    }
    setWithdrawSheetStep("confirm");
  }

  async function runTrackedTransaction(
    label: string,
    type: "deposit" | "withdraw",
    action: (update: (patch: ActionPatch) => void) => Promise<void>,
    ok: string,
  ) {
    flushSync(() => {
      setConfirmingAction(type);
    });
    await afterNextPaint();
    window.setTimeout(() => {
      setConfirmingAction(undefined);
      setDepositSheetStep(undefined);
      setWithdrawSheetStep(undefined);
    }, 150);
    runAction(
      {
        label,
        type,
        account: session?.address,
      },
      async ({ update }) => {
        try {
          await action(update);
          update({ status: "completed" });
          toast({ tone: "success", title: ok });
        } catch (error) {
          const errorMessage = getErrorMessage(error);
          update({ status: "failed", error: errorMessage });
          toast({ tone: "error", title: "Transaction failed", description: errorMessage });
        }
      },
    );
  }

  async function run(action: () => Promise<void>, ok: string, currentAction?: WorkingAction) {
    flushSync(() => {
      setStatus("working");
      setWorkingAction(currentAction);
    });
    await afterNextPaint();
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

  async function copyPendingHash(hash: `0x${string}`) {
    await navigator.clipboard.writeText(hash);
    toast({ tone: "success", title: "Withdrawal ID copied." });
  }

  return (
    <div className="space-y-5 animate-fade-in">
      <section className="space-y-2">
        <h1 className="font-display text-2xl font-bold">My savings</h1>
        <p className="text-sm leading-relaxed text-muted">
          Your wallet, savings, and pending withdrawals.
        </p>
      </section>

      <div className="card space-y-3">
        <p className="label">Personal status</p>
        <div className="flex items-center justify-between">
          <span className="text-muted text-sm">{balanceBucketLabels.walletUsdc}</span>
          <span className="font-semibold tabular-nums">{formatUSDC(usdcBalance)} USDC</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-muted text-sm">{balanceBucketLabels.withdrawalInProgress}</span>
          <span className="font-semibold tabular-nums">
            {pendingWithdrawals.some((request) => request.amount === undefined)
              ? `${pendingWithdrawals.length} pending`
              : `${formatUSDC(withdrawalInProgress)} USDC`}
          </span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-muted text-sm">{balanceBucketLabels.savingsBalance}</span>
          <span className="font-semibold tabular-nums text-text">
            {confidentialBalancesLoading ? <LoadingAmount /> : `${formatUSDC(principal)} USDC`}
          </span>
        </div>
        {confidentialBalancesError && <p className="text-xs text-danger">{confidentialBalancesError}</p>}
      </div>

      {pendingWithdrawals.length > 0 && (
        <section className="space-y-3 border-t border-text/10 py-4" aria-label="Pending withdrawals" aria-live="polite">
          <h2 className="text-sm font-semibold">Pending withdrawals</h2>
          {automaticWithdrawals && <p className="text-sm text-muted">USDC will arrive in your wallet automatically.</p>}
          {withdrawalRefreshError && <p className="text-sm text-muted">Updates are delayed. Your withdrawals are still pending.</p>}
          {pendingWithdrawals.map((request) => (
            <div key={request.batchId.toString()} className="flex items-center justify-between gap-3 text-sm">
              <span>{withdrawalStageCopy[request.stage]}</span>
              <span className="tabular-nums">{request.amount === undefined ? "Amount pending" : `${formatUSDC(request.amount)} USDC`}</span>
            </div>
          ))}
        </section>
      )}

      <div className="grid grid-cols-2 gap-3">
        <button
          type="button"
          onClick={() => setDepositSheetStep("entry")}
          disabled={!session || !poolReady}
          className="btn-primary w-full"
        >
          <svg
            aria-hidden="true"
            className="h-4 w-4"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="2"
          >
            <path d="M12 3v12" />
            <path d="m7 10 5 5 5-5" />
            <path d="M5 21h14" />
          </svg>
          Deposit
        </button>

        <button
          type="button"
          onClick={() => setWithdrawSheetStep("entry")}
          disabled={!showWithdraw}
          className="btn-secondary w-full"
        >
          <svg
            aria-hidden="true"
            className="h-4 w-4"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="2"
          >
            <path d="M12 21V9" />
            <path d="m7 14 5-5 5 5" />
            <path d="M5 3h14" />
          </svg>
          Withdraw
        </button>
      </div>

      {depositSheetStep && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-text/35 px-4 pb-4 backdrop-blur-sm">
          <button
            type="button"
            aria-label="Close deposit sheet"
            className="absolute inset-0 h-full w-full cursor-default"
            onClick={closeSheets}
          />
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="deposit-sheet-title"
            className="glass-surface relative max-h-[86vh] w-full max-w-[448px] space-y-4 overflow-y-auto rounded-t-[30px] p-5 shadow-[0_-28px_64px_-38px_rgb(43_45_50_/_0.55)] animate-fade-in"
          >
            <div className="mx-auto h-1.5 w-12 rounded-full bg-text/20" />
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="label">Deposit</p>
                <h2 id="deposit-sheet-title" className="font-display text-xl font-bold">
                  Add to savings
                </h2>
              </div>
              <button
                type="button"
                aria-label="Close deposit sheet"
                onClick={closeSheets}
                className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-white/40 text-muted transition-colors hover:bg-white/60 hover:text-text"
              >
                <svg
                  aria-hidden="true"
                  className="h-4 w-4"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="2"
                >
                  <path d="M18 6 6 18" />
                  <path d="m6 6 12 12" />
                </svg>
              </button>
            </div>

            <AmountInput
              label="Amount"
              maxLabel={`${formatUSDC(usdcBalance !== undefined && usdcBalance < remainingDeposit ? usdcBalance : remainingDeposit)} USDC`}
              value={depositAmount}
              onChange={setDepositAmount}
              onMax={() => {
                const max = usdcBalance !== undefined && usdcBalance < remainingDeposit ? usdcBalance : remainingDeposit;
                setDepositAmount(formatUSDC(max, 6));
              }}
              disabled={depositSheetStep === "confirm"}
            />
            <p className="rounded-2xl bg-white/45 px-3 py-2 text-xs text-muted">
              Current account limit: 1,000.00 USDC.
            </p>

            {depositSheetStep === "entry" ? (
              <button
                onClick={reviewDeposit}
                disabled={!session || !poolReady}
                className="btn-primary w-full"
              >
                Review deposit
              </button>
            ) : (
              <div className="space-y-4">
                <div className="rounded-3xl border border-white/55 bg-white/35 p-4">
                  <p className="label">Confirm</p>
                  <div className="mt-3 space-y-2 text-sm">
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-muted">Deposit</span>
                      <span className="font-semibold tabular-nums">{formatUSDC(parsedDepositAmount)} USDC</span>
                    </div>
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-muted">Wallet after</span>
                      <span className="font-semibold tabular-nums">{formatUSDC(depositBalanceAfter)} USDC</span>
                    </div>
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-muted">Pool after</span>
                      <span className="font-semibold tabular-nums">{formatUSDC(depositPoolAfter)} USDC</span>
                    </div>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    className="btn-secondary !px-3"
                    onClick={() => setDepositSheetStep("entry")}
                  >
                    Back
                  </button>
                  <button
                    type="button"
                    className="btn-primary !px-3"
                    disabled={!session || !poolReady || confirmingAction === "deposit"}
                    onClick={() =>
                      void runTrackedTransaction(
                        `Deposit ${formatUSDC(parsedDepositAmount)} USDC`,
                        "deposit",
                        (update) => depositConfidential(parsedDepositAmount, update),
                        "Deposit complete.",
                      )
                    }
                  >
                    {confirmingAction === "deposit" ? (
                      <>
                        <span className="w-4 h-4 rounded-full border-2 border-white/30 border-t-white animate-spin" />
                        Confirming...
                      </>
                    ) : (
                      "Confirm"
                    )}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {withdrawSheetStep && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-text/35 px-4 pb-4 backdrop-blur-sm">
          <button
            type="button"
            aria-label="Close withdrawal sheet"
            className="absolute inset-0 h-full w-full cursor-default"
            onClick={closeSheets}
          />
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="withdraw-sheet-title"
            className="glass-surface relative max-h-[86vh] w-full max-w-[448px] space-y-4 overflow-y-auto rounded-t-[30px] p-5 shadow-[0_-28px_64px_-38px_rgb(43_45_50_/_0.55)] animate-fade-in"
          >
            <div className="mx-auto h-1.5 w-12 rounded-full bg-text/20" />
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="label">Withdraw</p>
                <h2 id="withdraw-sheet-title" className="font-display text-xl font-bold">
                  Move savings to USDC
                </h2>
              </div>
              <button
                type="button"
                aria-label="Close withdrawal sheet"
                onClick={closeSheets}
                className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-white/40 text-muted transition-colors hover:bg-white/60 hover:text-text"
              >
                <svg
                  aria-hidden="true"
                  className="h-4 w-4"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="2"
                >
                  <path d="M18 6 6 18" />
                  <path d="m6 6 12 12" />
                </svg>
              </button>
            </div>

            {hasWithdrawablePrincipal && (
              <AmountInput
                label="Amount"
                maxLabel={`${formatUSDC(principal)} USDC`}
                value={withdrawAmount}
                onChange={setWithdrawAmount}
                onMax={() => setWithdrawAmount(principal !== undefined ? formatUSDC(principal, 6) : "0")}
                disabled={withdrawSheetStep === "confirm"}
              />
            )}

            {hasWithdrawablePrincipal && withdrawSheetStep === "entry" && (
              <button
                onClick={reviewWithdraw}
                disabled={!session || !poolReady || status === "working"}
                className="btn-secondary w-full"
              >
                Review withdrawal
              </button>
            )}

            {hasWithdrawablePrincipal && withdrawSheetStep === "confirm" && (
              <div className="space-y-4">
                <div className="rounded-3xl border border-white/55 bg-white/35 p-4">
                  <p className="label">Confirm</p>
                  <div className="mt-3 space-y-2 text-sm">
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-muted">Withdraw</span>
                      <span className="font-semibold tabular-nums">{formatUSDC(parsedWithdrawAmount)} USDC</span>
                    </div>
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-muted">Savings after</span>
                      <span className="font-semibold tabular-nums">{formatUSDC(withdrawPoolAfter)} USDC</span>
                    </div>
                  </div>
                  <p className="mt-3 rounded-2xl bg-white/45 px-3 py-2 text-xs text-muted">
                    Your draw chances update after this request.
                  </p>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    className="btn-secondary !px-3"
                    onClick={() => setWithdrawSheetStep("entry")}
                  >
                    Back
                  </button>
                  <button
                    type="button"
                    className="btn-primary !px-3"
                    disabled={!session || !poolReady || confirmingAction === "withdraw"}
                    onClick={() =>
                      void runTrackedTransaction(
                        `Withdraw ${formatUSDC(parsedWithdrawAmount)} USDC`,
                        "withdraw",
                        (update) => withdrawConfidential(parsedWithdrawAmount, update),
                        "Withdrawal requested.",
                      )
                    }
                  >
                    {confirmingAction === "withdraw" ? (
                      <>
                        <span className="w-4 h-4 rounded-full border-2 border-white/30 border-t-white animate-spin" />
                        Confirming...
                      </>
                    ) : (
                      "Confirm"
                    )}
                  </button>
                </div>
              </div>
            )}

            {(pendingWithdrawals.length > 0 || standalonePendingUnwraps.length > 0) && (
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-muted text-sm">Pending withdrawals</span>
                  <button
                    className="btn-ghost !py-1 !px-3 !text-xs bg-surface2"
                    disabled={!session || !wrapperReady || status === "working"}
                    onClick={() =>
                      void run(
                        async () => {
                          await refreshPendingWithdrawals();
                          await refreshPendingUnwraps();
                        },
                        "Pending withdrawals refreshed.",
                        "pending",
                      )
                    }
                  >
                    {workingAction === "pending" ? "Refreshing..." : "Refresh"}
                  </button>
                </div>
                {pendingWithdrawals.map((request) => (
                  <div key={`${request.batchId.toString()}:${request.txHash}`} className="space-y-2 rounded-2xl bg-white/35 p-3">
                    <div className="flex items-center justify-between gap-3 text-sm">
                      <span className="font-semibold">{withdrawalStageCopy[request.stage]}</span>
                      {request.amount !== undefined && (
                        <span className="font-semibold tabular-nums">{formatUSDC(request.amount)} USDC</span>
                      )}
                    </div>
                    <p className="text-xs text-muted">{pendingWithdrawalBatchLabel(request)}</p>
                    {request.stage === "requested" && request.closesAt !== undefined && (
                      <p className="text-xs text-muted">
                        Batch closes {new Intl.DateTimeFormat("en-US", { timeStyle: "short" }).format(new Date(Number(request.closesAt) * 1000))}.
                      </p>
                    )}
                    {!automaticWithdrawals && request.stage === "claimable" && (
                      <button
                        className="btn-secondary w-full"
                        disabled={status === "working"}
                        onClick={() =>
                          void run(
                            () => claimWithdrawal(request.batchId),
                            "Withdrawal ready to finalize.",
                            "pending",
                          )
                        }
                      >
                        {workingAction === "pending" ? "Receiving..." : "Receive USDC"}
                      </button>
                    )}
                    {!automaticWithdrawals && request.stage === "finalizing" && request.unwrapRequestId && (
                      <button
                        className="btn-secondary w-full"
                        disabled={status === "working"}
                        onClick={() =>
                          void run(
                            () => finalizeUnwrap(request.unwrapRequestId!),
                            "Your USDC withdrawal is finalized.",
                            "pending",
                          )
                        }
                      >
                        {workingAction === "pending" ? "Finalizing..." : "Finalize withdrawal"}
                      </button>
                    )}
                  </div>
                ))}
                {standalonePendingUnwraps.map((request) => (
                  <div key={request.requestId} className="space-y-2">
                    <button
                      type="button"
                      className="font-mono text-xs text-muted underline-offset-2 transition-colors hover:text-text hover:underline"
                      title="Copy withdrawal ID"
                      onClick={() => void copyPendingHash(request.requestId)}
                    >
                      {formatShortHash(request.requestId)}
                    </button>
                    <button
                      className="btn-secondary w-full"
                      disabled={status === "working"}
                      onClick={() =>
                        void run(
                          () => finalizeUnwrap(request.requestId),
                          "Your USDC withdrawal is finalized.",
                          "pending",
                        )
                      }
                    >
                      {workingAction === "pending" ? "Finalizing..." : "Finalize withdrawal"}
                    </button>
                  </div>
                ))}
              </div>
            )}

            {!showWithdraw && <p className="text-sm text-muted">No deposited funds or pending withdrawals yet.</p>}
          </div>
        </div>
      )}

    </div>
  );
}
