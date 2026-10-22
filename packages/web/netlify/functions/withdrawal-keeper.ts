import { createPublicClient, createWalletClient, getAddress, http, zeroAddress, zeroHash, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { PrivateKeyAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import {
  buildFinalizeUnwrapRequest,
  confidentialPrizePoolAbi as prizePoolAbi,
  confidentialUsdcAbi as wrapperAbi,
  morphoBlueAbi,
  morphoYieldAdapterAbi,
} from "@kettigo/protocol";
import { sanitizeKeeperError } from "../../src/lib/morpho-keeper.ts";
import {
  chooseWithdrawalKeeperAction,
  type WithdrawalBatchStatus,
  type WithdrawalKeeperAction,
} from "../../src/lib/withdrawal-keeper.ts";
import { decryptPublicHandles } from "../../src/lib/zama-node.ts";
import { resolveKeeperRpcUrls } from "../../src/lib/keeper-rpc.ts";

declare const Netlify: { env: { get(name: string): string | undefined } } | undefined;

const WITHDRAWAL_RETRY_ATTEMPTS = 4;
const WITHDRAWAL_RETRY_BASE_DELAY_MS = 1_500;

async function decryptHandles(handles: Hex[], rpcUrl: string) {
  return decryptPublicHandles(handles, rpcUrl);
}

type EnvName =
  | "SEPOLIA_RPC_URL"
  | "SEPOLIA_WRITE_RPC_URL"
  | "NEXT_PUBLIC_RPC_URL"
  | "CONFIDENTIAL_PRIZE_POOL_ADDRESS"
  | "NEXT_PUBLIC_CONFIDENTIAL_PRIZE_POOL_ADDRESS"
  | "KEEPER_PRIVATE_KEY";

function env(name: EnvName): string | undefined {
  if (typeof Netlify !== "undefined") return Netlify.env.get(name);
  switch (name) {
    case "SEPOLIA_RPC_URL": return process.env.SEPOLIA_RPC_URL;
    case "SEPOLIA_WRITE_RPC_URL": return process.env.SEPOLIA_WRITE_RPC_URL;
    case "NEXT_PUBLIC_RPC_URL": return process.env.NEXT_PUBLIC_RPC_URL;
    case "CONFIDENTIAL_PRIZE_POOL_ADDRESS": return process.env.CONFIDENTIAL_PRIZE_POOL_ADDRESS;
    case "NEXT_PUBLIC_CONFIDENTIAL_PRIZE_POOL_ADDRESS": return process.env.NEXT_PUBLIC_CONFIDENTIAL_PRIZE_POOL_ADDRESS;
    case "KEEPER_PRIVATE_KEY": return process.env.KEEPER_PRIVATE_KEY;
  }
}

function requiredEnv(name: EnvName): string {
  const value = env(name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function privateKeyEnv(name: EnvName): Hex {
  const value = requiredEnv(name);
  return (value.startsWith("0x") ? value : `0x${value}`) as Hex;
}

function statusName(status: number): WithdrawalBatchStatus {
  switch (status) {
    case 0: return "open";
    case 1: return "closed";
    case 2: return "funded";
    default: throw new Error(`Unknown withdrawal batch status: ${status}`);
  }
}

function isRateLimitError(error: unknown) {
  const candidate = error && typeof error === "object" ? error as Record<string, unknown> : undefined;
  const message = `${candidate?.message ?? ""} ${candidate?.details ?? ""} ${candidate?.shortMessage ?? ""}`;
  return candidate?.status === 429 || candidate?.code === -32005 || /rate limit|too many requests/i.test(message);
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRateLimitRetry<T>(operation: () => Promise<T>) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (!isRateLimitError(error) || attempt >= WITHDRAWAL_RETRY_ATTEMPTS - 1) throw error;
      await delay(WITHDRAWAL_RETRY_BASE_DELAY_MS * 2 ** attempt);
    }
  }
}

async function readSnapshot(
  publicClient: ReturnType<typeof createPublicClient>,
  pool: `0x${string}`,
  batchId: bigint,
) {
  const status = await withRateLimitRetry(() =>
    publicClient.readContract({ address: pool, abi: prizePoolAbi, functionName: "withdrawalBatchStatus", args: [batchId] }));
  const closesAt = await withRateLimitRetry(() =>
    publicClient.readContract({ address: pool, abi: prizePoolAbi, functionName: "withdrawalBatchClosesAt", args: [batchId] }));
  const requestCount = await withRateLimitRetry(() =>
    publicClient.readContract({ address: pool, abi: prizePoolAbi, functionName: "withdrawalBatchRequestCount", args: [batchId] }));
  const block = await withRateLimitRetry(() => publicClient.getBlock());

  return {
    now: block.timestamp,
    closesAt,
    requestCount,
    status: statusName(status),
  };
}

async function runAction(
  action: WithdrawalKeeperAction,
  publicClient: ReturnType<typeof createPublicClient>,
  walletClient: ReturnType<typeof createWalletClient>,
  account: PrivateKeyAccount,
  pool: `0x${string}`,
  batchId: bigint,
  rpcUrl: string,
  decrypt = decryptHandles,
) {
  if (action === "close") {
    return walletClient.writeContract({
      address: pool,
      abi: prizePoolAbi,
      account,
      chain: sepolia,
      functionName: "closeWithdrawalBatch",
      args: [batchId],
    });
  }

  const totalHandle = await withRateLimitRetry(() =>
    publicClient.readContract({ address: pool, abi: prizePoolAbi, functionName: "encryptedWithdrawalBatchTotal", args: [batchId] }));
  const restoreHandle = await withRateLimitRetry(() =>
    publicClient.readContract({ address: pool, abi: prizePoolAbi, functionName: "encryptedWithdrawalBatchMorphoRestore", args: [batchId] }));
  let decrypted;
  try {
    decrypted = await decrypt([totalHandle, restoreHandle], rpcUrl);
  } catch (error) {
    console.log(JSON.stringify({ action, batchId: batchId.toString(), status: "not-ready", error: sanitizeKeeperError(error) }));
    return undefined;
  }

  const clearTotal = clearValueFor(decrypted.clearValues, totalHandle);
  const clearRestore = clearValueFor(decrypted.clearValues, restoreHandle);
  if (typeof clearTotal !== "bigint" || typeof clearRestore !== "bigint") {
    console.log(JSON.stringify({ action, batchId: batchId.toString(), status: "invalid-decryption-response" }));
    return undefined;
  }
  if (clearRestore > 0n) {
    const availableLiquidity = await readMorphoAvailableLiquidity(publicClient, pool);
    if (availableLiquidity < clearRestore) {
      console.log(JSON.stringify({
        action,
        batchId: batchId.toString(),
        status: "waiting-for-liquidity",
        required: clearRestore.toString(),
        available: availableLiquidity.toString(),
      }));
      return undefined;
    }
  }

  return walletClient.writeContract({
    address: pool,
    abi: prizePoolAbi,
    account,
    chain: sepolia,
    functionName: "settleWithdrawalBatch",
    args: [batchId, clearTotal, clearRestore, decrypted.decryptionProof],
  });
}

async function readMorphoAvailableLiquidity(
  publicClient: ReturnType<typeof createPublicClient>,
  pool: `0x${string}`,
) {
  const adapter = getAddress(await withRateLimitRetry(() =>
    publicClient.readContract({ address: pool, abi: prizePoolAbi, functionName: "morphoYieldAdapter" })));
  const morpho = getAddress(await withRateLimitRetry(() =>
    publicClient.readContract({ address: adapter, abi: morphoYieldAdapterAbi, functionName: "morpho" })));
  const marketId = await withRateLimitRetry(() =>
    publicClient.readContract({ address: adapter, abi: morphoYieldAdapterAbi, functionName: "marketId" }));
  const market = await withRateLimitRetry(() =>
    publicClient.readContract({ address: morpho, abi: morphoBlueAbi, functionName: "market", args: [marketId] }));
  const totalSupplyAssets = market[0];
  const totalBorrowAssets = market[2];
  return totalSupplyAssets > totalBorrowAssets ? totalSupplyAssets - totalBorrowAssets : 0n;
}

function clearValueFor(values: Readonly<Record<string, unknown>>, handle: Hex): unknown {
  for (const [key, value] of Object.entries(values)) {
    if (key === handle) return value;
  }
  return undefined;
}

export default async () => {
  const rpcUrl = env("SEPOLIA_RPC_URL") ?? requiredEnv("NEXT_PUBLIC_RPC_URL");
  const { readRpcUrl, writeRpcUrl } = resolveKeeperRpcUrls(rpcUrl, env("SEPOLIA_WRITE_RPC_URL"));
  const pool = getAddress(env("CONFIDENTIAL_PRIZE_POOL_ADDRESS") ?? requiredEnv("NEXT_PUBLIC_CONFIDENTIAL_PRIZE_POOL_ADDRESS"));
  const account = privateKeyToAccount(privateKeyEnv("KEEPER_PRIVATE_KEY"));
  const publicClient = createPublicClient({ chain: sepolia, transport: http(readRpcUrl) });
  const walletClient = createWalletClient({ account, chain: sepolia, transport: http(writeRpcUrl) });
  return runWithdrawalKeeper({ rpcUrl, pool, account, publicClient, walletClient });
};

export async function runWithdrawalKeeper({ rpcUrl, pool, account, publicClient, walletClient, decrypt = decryptHandles }: {
  rpcUrl: string;
  pool: Hex;
  account: PrivateKeyAccount;
  publicClient: ReturnType<typeof createPublicClient>;
  walletClient: ReturnType<typeof createWalletClient>;
  decrypt?: typeof decryptHandles;
}) {
  const currentBatchId = await withRateLimitRetry(() => publicClient.readContract({
    address: pool,
    abi: prizePoolAbi,
    functionName: "currentWithdrawalBatchId",
  }));

  const token = getAddress(await withRateLimitRetry(() =>
    publicClient.readContract({ address: pool, abi: prizePoolAbi, functionName: "token" })));
  const transactions: Array<{ action: string; batchId: string; hash: Hex }> = [];
  const pending: Array<{ batchId: string; account?: string; status: string; error?: ReturnType<typeof sanitizeKeeperError> }> = [];
  async function confirmed(hash: Hex, action: string, batchId: bigint) {
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`${action} transaction reverted: ${hash}`);
    transactions.push({ action, batchId: batchId.toString(), hash });
  }

  // Scan oldest first: a request must not expire out of a rolling lookback window.
  for (let batchId = 1n; batchId <= currentBatchId; batchId++) {
    try {
      let snapshot = await readSnapshot(publicClient, pool, batchId);
      if (snapshot.requestCount === 0n) continue;
      for (let step = 0; step < 2; step++) {
        const action = chooseWithdrawalKeeperAction(snapshot);
        if (!action) break;
        const hash = await runAction(action, publicClient, walletClient, account, pool, batchId, rpcUrl, decrypt);
        if (!hash) break;
        await confirmed(hash, action, batchId);
        snapshot = await readSnapshot(publicClient, pool, batchId);
      }
      if (snapshot.status !== "funded") {
        pending.push({ batchId: batchId.toString(), status: snapshot.status === "open" ? "waiting-for-batch" : "waiting-for-settlement" });
        continue;
      }
      const claimants = await withRateLimitRetry(() =>
        publicClient.readContract({ address: pool, abi: prizePoolAbi, functionName: "withdrawalAccounts", args: [batchId] }));
      for (const claimant of claimants) {
        try {
          const hasClaim = await withRateLimitRetry(() =>
            publicClient.readContract({ address: pool, abi: prizePoolAbi, functionName: "hasWithdrawalClaim", args: [batchId, claimant] }));
          if (hasClaim) {
            await confirmed(await walletClient.writeContract({ account, chain: sepolia, address: pool, abi: prizePoolAbi, functionName: "processWithdrawal", args: [batchId, claimant] }), "payout", batchId);
          }
          const requestId = await withRateLimitRetry(() =>
            publicClient.readContract({ address: pool, abi: prizePoolAbi, functionName: "withdrawalUnwrapRequest", args: [batchId, claimant] }));
          if (requestId === zeroHash) throw new Error("Missing payout request");
          const receiver = await withRateLimitRetry(() =>
            publicClient.readContract({ address: token, abi: wrapperAbi, functionName: "unwrapRequester", args: [requestId] }));
          if (receiver === zeroAddress) continue;
          const decrypted = await decrypt([requestId], rpcUrl);
          const amount = clearValueFor(decrypted.clearValues, requestId);
          if (typeof amount !== "bigint") throw new Error("Invalid payout proof response");
          await confirmed(await walletClient.writeContract({
            ...buildFinalizeUnwrapRequest(token, requestId, amount, decrypted.decryptionProof),
            account,
            chain: sepolia,
          }), "deliver", batchId);
        } catch (error) {
          pending.push({ batchId: batchId.toString(), account: claimant, status: "retrying-delivery", error: sanitizeKeeperError(error) });
        }
      }
    } catch (error) {
      pending.push({ batchId: batchId.toString(), status: "retrying", error: sanitizeKeeperError(error) });
    }
  }

  console.log(JSON.stringify({ transactions, pending }));
  return new Response(JSON.stringify({ transactions, pending }), {
    headers: { "content-type": "application/json" },
  });
};

export const config = {
  schedule: "* * * * *",
};
