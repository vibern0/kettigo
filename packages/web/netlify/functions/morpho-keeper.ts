import { createPublicClient, createWalletClient, getAddress, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { PrivateKeyAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import {
  buildFinalizeUnwrapRequest,
  confidentialPrizePoolAbi,
  decodeMarketParams,
  morphoBlueAbi,
  morphoYieldAdapterAbi,
  unwrapFinalizedEvent,
  unwrapRequestedEvent,
} from "@kettigo/protocol";
import {
  buildInclusiveBlockRanges,
  chooseMorphoKeeperActions,
  findOldestPendingMorphoUnwrap,
  normalizeKeeperMaxTransactions,
  sanitizeKeeperError,
  type MorphoKeeperAction,
  type MorphoKeeperSnapshot,
} from "../../src/lib/morpho-keeper.ts";
import { decryptPublicHandles } from "../../src/lib/zama-node.ts";
import { resolveKeeperRpcUrls } from "../../src/lib/keeper-rpc.ts";

declare const Netlify: { env: { get(name: string): string | undefined } } | undefined;

const UNWRAP_LOG_CHUNK_BLOCKS = 10_000n;
const UNWRAP_LOG_RETRY_ATTEMPTS = 4;
const UNWRAP_LOG_RETRY_BASE_DELAY_MS = 1_500;
type UnwrapLog = { args: { unwrapRequestId?: `0x${string}` } };
type MorphoKeeperRuntimeSnapshot = MorphoKeeperSnapshot & {
  token: `0x${string}`;
  adapter: `0x${string}`;
};

type EnvName =
  | "SEPOLIA_RPC_URL"
  | "SEPOLIA_WRITE_RPC_URL"
  | "NEXT_PUBLIC_RPC_URL"
  | "CONFIDENTIAL_PRIZE_POOL_ADDRESS"
  | "NEXT_PUBLIC_CONFIDENTIAL_PRIZE_POOL_ADDRESS"
  | "KEEPER_PRIVATE_KEY"
  | "MORPHO_KEEPER_MAX_TXS"
  | "MORPHO_KEEPER_START_BLOCK"
  | "MORPHO_KEEPER_PENDING_UNWRAP_REQUEST_ID"
  | "MORPHO_KEEPER_SKIP_UNWRAP_LOG_SCAN";

function env(name: EnvName): string | undefined {
  if (typeof Netlify !== "undefined") return Netlify.env.get(name);
  switch (name) {
    case "SEPOLIA_RPC_URL": return process.env.SEPOLIA_RPC_URL;
    case "SEPOLIA_WRITE_RPC_URL": return process.env.SEPOLIA_WRITE_RPC_URL;
    case "NEXT_PUBLIC_RPC_URL": return process.env.NEXT_PUBLIC_RPC_URL;
    case "CONFIDENTIAL_PRIZE_POOL_ADDRESS": return process.env.CONFIDENTIAL_PRIZE_POOL_ADDRESS;
    case "NEXT_PUBLIC_CONFIDENTIAL_PRIZE_POOL_ADDRESS": return process.env.NEXT_PUBLIC_CONFIDENTIAL_PRIZE_POOL_ADDRESS;
    case "KEEPER_PRIVATE_KEY": return process.env.KEEPER_PRIVATE_KEY;
    case "MORPHO_KEEPER_MAX_TXS": return process.env.MORPHO_KEEPER_MAX_TXS;
    case "MORPHO_KEEPER_START_BLOCK": return process.env.MORPHO_KEEPER_START_BLOCK;
    case "MORPHO_KEEPER_PENDING_UNWRAP_REQUEST_ID": return process.env.MORPHO_KEEPER_PENDING_UNWRAP_REQUEST_ID;
    case "MORPHO_KEEPER_SKIP_UNWRAP_LOG_SCAN": return process.env.MORPHO_KEEPER_SKIP_UNWRAP_LOG_SCAN;
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

async function findPendingUnwrap(
  publicClient: ReturnType<typeof createPublicClient>,
  token: `0x${string}`,
  adapter: `0x${string}`,
  startBlock: bigint,
  latestBlock: bigint,
) {
  const requested: UnwrapLog[] = [];
  const finalized: UnwrapLog[] = [];
  for (const range of buildInclusiveBlockRanges(startBlock, latestBlock, UNWRAP_LOG_CHUNK_BLOCKS)) {
    const requestedChunk = await getLogsWithRateLimitRetry<UnwrapLog>(publicClient, {
      address: token,
      event: unwrapRequestedEvent,
      args: { receiver: adapter },
      ...range,
    });
    const finalizedChunk = await getLogsWithRateLimitRetry<UnwrapLog>(publicClient, {
      address: token,
      event: unwrapFinalizedEvent,
      args: { receiver: adapter },
      ...range,
    });
    requested.push(...requestedChunk);
    finalized.push(...finalizedChunk);
  }

  return findOldestPendingMorphoUnwrap(
    requested.flatMap((event) => event.args.unwrapRequestId ? [event.args.unwrapRequestId] : []),
    finalized.flatMap((event) => event.args.unwrapRequestId ? [event.args.unwrapRequestId] : []),
  );
}

async function getLogsWithRateLimitRetry<TLog>(
  publicClient: ReturnType<typeof createPublicClient>,
  request: Parameters<typeof publicClient.getLogs>[0],
): Promise<TLog[]> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await publicClient.getLogs(request) as TLog[];
    } catch (error) {
      if (!isRateLimitError(error) || attempt >= UNWRAP_LOG_RETRY_ATTEMPTS - 1) throw error;
      await delay(UNWRAP_LOG_RETRY_BASE_DELAY_MS * 2 ** attempt);
    }
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
      if (!isRateLimitError(error) || attempt >= UNWRAP_LOG_RETRY_ATTEMPTS - 1) throw error;
      await delay(UNWRAP_LOG_RETRY_BASE_DELAY_MS * 2 ** attempt);
    }
  }
}

function truthyEnv(value: string | undefined) {
  return value === "1" || value?.toLowerCase() === "true" || value?.toLowerCase() === "yes";
}

async function readSnapshot(
  publicClient: ReturnType<typeof createPublicClient>,
  pool: `0x${string}`,
  startBlock: bigint,
  options: { pendingUnwrapRequestId?: Hex; skipUnwrapLogScan?: boolean } = {},
) {
  const availablePrincipalAssets = await withRateLimitRetry(() =>
    publicClient.readContract({ address: pool, abi: confidentialPrizePoolAbi, functionName: "morphoAvailablePrincipalAssets" }));
  const accruedYieldAssets = await withRateLimitRetry(() =>
    publicClient.readContract({ address: pool, abi: confidentialPrizePoolAbi, functionName: "morphoAccruedYieldAssets" }));
  const morphoPendingDepositCount = await withRateLimitRetry(() =>
    publicClient.readContract({ address: pool, abi: confidentialPrizePoolAbi, functionName: "morphoPendingDepositCount" }));
  const lastMorphoUnwrapAt = await withRateLimitRetry(() =>
    publicClient.readContract({ address: pool, abi: confidentialPrizePoolAbi, functionName: "lastMorphoUnwrapAt" }));
  const morphoUnwrapInterval = await withRateLimitRetry(() =>
    publicClient.readContract({ address: pool, abi: confidentialPrizePoolAbi, functionName: "morphoUnwrapInterval" }));
  const tokenAddress = await withRateLimitRetry(() =>
    publicClient.readContract({ address: pool, abi: confidentialPrizePoolAbi, functionName: "token" }));
  const adapterAddress = await withRateLimitRetry(() =>
    publicClient.readContract({ address: pool, abi: confidentialPrizePoolAbi, functionName: "morphoYieldAdapter" }));
  const block = await withRateLimitRetry(() => publicClient.getBlock());

  const token = getAddress(tokenAddress);
  const adapter = getAddress(adapterAddress);
  const resolvedPendingUnwrapRequestId =
    options.pendingUnwrapRequestId ??
    (options.skipUnwrapLogScan ? undefined : await findPendingUnwrap(publicClient, token, adapter, startBlock, block.number));
  const suppliedPrincipalAssets = await withRateLimitRetry(() =>
    publicClient.readContract({ address: adapter, abi: morphoYieldAdapterAbi, functionName: "suppliedPrincipal" }));
  const pendingUnwrapRequestId = resolvedPendingUnwrapRequestId;
  const morphoAddress = await withRateLimitRetry(() =>
    publicClient.readContract({ address: adapter, abi: morphoYieldAdapterAbi, functionName: "morpho" }));
  const marketId = await withRateLimitRetry(() =>
    publicClient.readContract({ address: adapter, abi: morphoYieldAdapterAbi, functionName: "marketId" }));
  const market = await withRateLimitRetry(() => publicClient.readContract({
    address: getAddress(morphoAddress),
    abi: morphoBlueAbi,
    functionName: "market",
    args: [marketId],
  }));

  return {
    availablePrincipalAssets,
    accruedYieldAssets,
    morphoPendingDepositCount,
    morphoLastAccrualAt: market[4],
    lastMorphoUnwrapAt,
    morphoUnwrapInterval,
    now: block.timestamp,
    pendingUnwrapRequestId,
    suppliedPrincipalAssets,
    token,
    adapter,
  } satisfies MorphoKeeperRuntimeSnapshot;
}

export async function runMorphoAction(
  action: MorphoKeeperAction,
  publicClient: ReturnType<typeof createPublicClient>,
  walletClient: ReturnType<typeof createWalletClient>,
  account: PrivateKeyAccount,
  pool: `0x${string}`,
  snapshot: Awaited<ReturnType<typeof readSnapshot>>,
  rpcUrl: string,
  decryptUnwrap?: (requestId: Hex, rpcUrl: string) => Promise<{ clearValue: bigint; decryptionProof: Hex }>,
) {
  if (action === "finalize") {
    const requestId = snapshot.pendingUnwrapRequestId;
    if (!requestId) return undefined;

    let clearValue: unknown;
    let decryptionProof: Hex;
    try {
      if (decryptUnwrap) {
        const result = await decryptUnwrap(requestId, rpcUrl);
        clearValue = result.clearValue;
        decryptionProof = result.decryptionProof;
      } else {
        const decrypted = await decryptPublicHandles([requestId], rpcUrl);
        clearValue = clearValueFor(decrypted.clearValues, requestId);
        decryptionProof = decrypted.decryptionProof;
      }
    } catch (error) {
      console.log(JSON.stringify({ action, requestId, status: "not-ready", error: sanitizeKeeperError(error) }));
      return undefined;
    }

    if (typeof clearValue !== "bigint") {
      console.log(JSON.stringify({ action, requestId, status: "invalid-decryption-response" }));
      return undefined;
    }

    const hash = await walletClient.writeContract({
      ...buildFinalizeUnwrapRequest(snapshot.token, requestId, clearValue, decryptionProof),
      account,
      chain: sepolia,
    });
    return hash;
  }

  if (action === "accrue") {
    const [morphoAddress, marketParams] = await Promise.all([
      publicClient.readContract({ address: snapshot.adapter, abi: morphoYieldAdapterAbi, functionName: "morpho" }),
      publicClient.readContract({ address: snapshot.adapter, abi: morphoYieldAdapterAbi, functionName: "marketParams" }),
    ]);
    const params = decodeMarketParams(marketParams);
    const hash = await walletClient.writeContract({
      address: getAddress(morphoAddress),
      abi: morphoBlueAbi,
      account,
      chain: sepolia,
      functionName: "accrueInterest",
      args: [{
        loanToken: params.loanToken,
        collateralToken: params.collateralToken,
        oracle: params.oracle,
        irm: params.irm,
        lltv: params.lltv,
      }],
    });
    return hash;
  }

  const functionName =
    action === "supply"
      ? "supplyAvailableMorphoPrincipal"
      : "requestMorphoPrincipalUnwrap";
  const hash = await walletClient.writeContract({
    address: pool,
    abi: confidentialPrizePoolAbi,
    account,
    chain: sepolia,
    functionName,
    args: [],
  });
  return hash;
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
  const privateKey = privateKeyEnv("KEEPER_PRIVATE_KEY");
  const maxTransactions = normalizeKeeperMaxTransactions(env("MORPHO_KEEPER_MAX_TXS"));
  const startBlock = BigInt(requiredEnv("MORPHO_KEEPER_START_BLOCK"));
  const pendingUnwrapRequestId = env("MORPHO_KEEPER_PENDING_UNWRAP_REQUEST_ID") as Hex | undefined;
  const skipUnwrapLogScan = truthyEnv(env("MORPHO_KEEPER_SKIP_UNWRAP_LOG_SCAN"));
  const account = privateKeyToAccount(privateKey);

  const publicClient = createPublicClient({ chain: sepolia, transport: http(readRpcUrl) });
  const walletClient = createWalletClient({ account, chain: sepolia, transport: http(writeRpcUrl) });
  const result = await runMorphoKeeper({
    rpcUrl,
    pool,
    account,
    publicClient,
    walletClient,
    maxTransactions,
    startBlock,
    pendingUnwrapRequestId,
    skipUnwrapLogScan,
  });
  return new Response(JSON.stringify(result), {
    headers: { "content-type": "application/json" },
  });
};

export async function runMorphoKeeper({
  rpcUrl,
  pool,
  account,
  publicClient,
  walletClient,
  maxTransactions,
  startBlock,
  pendingUnwrapRequestId,
  skipUnwrapLogScan,
}: {
  rpcUrl: string;
  pool: Hex;
  account: PrivateKeyAccount;
  publicClient: ReturnType<typeof createPublicClient>;
  walletClient: ReturnType<typeof createWalletClient>;
  maxTransactions: number;
  startBlock: bigint;
  pendingUnwrapRequestId?: Hex;
  skipUnwrapLogScan?: boolean;
}) {
  const transactions: Array<{ action: MorphoKeeperAction; hash: Hex }> = [];

  for (let i = 0; i < maxTransactions; i++) {
    const snapshot = await readSnapshot(publicClient, pool, startBlock, { pendingUnwrapRequestId, skipUnwrapLogScan });
    const [action] = chooseMorphoKeeperActions(snapshot, 1);
    if (!action) break;

    const hash = await runMorphoAction(action, publicClient, walletClient, account, pool, snapshot, rpcUrl);
    if (!hash) break;
    transactions.push({ action, hash });
  }

  console.log(JSON.stringify({ transactions }));
  return { transactions };
}

export const config = {
  schedule: "*/5 * * * *",
};
