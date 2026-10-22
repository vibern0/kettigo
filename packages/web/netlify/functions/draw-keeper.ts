import { createPublicClient, createWalletClient, getAddress, http, type Hex } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { confidentialPrizePoolAbi } from "@kettigo/protocol";
import { chooseDrawKeeperAction, type DrawKeeperSnapshot } from "../../src/lib/draw-keeper.ts";
import { resolveKeeperRpcUrls } from "../../src/lib/keeper-rpc.ts";

declare const Netlify: { env: { get(name: string): string | undefined } } | undefined;

type EnvName =
  | "SEPOLIA_RPC_URL"
  | "SEPOLIA_WRITE_RPC_URL"
  | "NEXT_PUBLIC_RPC_URL"
  | "CONFIDENTIAL_PRIZE_POOL_ADDRESS"
  | "NEXT_PUBLIC_CONFIDENTIAL_PRIZE_POOL_ADDRESS"
  | "KEEPER_PRIVATE_KEY"
  | "DRAW_KEEPER_MINIMUM_PRIZE";

function env(name: EnvName): string | undefined {
  if (typeof Netlify !== "undefined") return Netlify.env.get(name);
  switch (name) {
    case "SEPOLIA_RPC_URL": return process.env.SEPOLIA_RPC_URL;
    case "SEPOLIA_WRITE_RPC_URL": return process.env.SEPOLIA_WRITE_RPC_URL;
    case "NEXT_PUBLIC_RPC_URL": return process.env.NEXT_PUBLIC_RPC_URL;
    case "CONFIDENTIAL_PRIZE_POOL_ADDRESS": return process.env.CONFIDENTIAL_PRIZE_POOL_ADDRESS;
    case "NEXT_PUBLIC_CONFIDENTIAL_PRIZE_POOL_ADDRESS": return process.env.NEXT_PUBLIC_CONFIDENTIAL_PRIZE_POOL_ADDRESS;
    case "KEEPER_PRIVATE_KEY": return process.env.KEEPER_PRIVATE_KEY;
    case "DRAW_KEEPER_MINIMUM_PRIZE": return process.env.DRAW_KEEPER_MINIMUM_PRIZE;
  }
}

function requiredEnv(name: EnvName): string {
  const value = env(name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function privateKeyEnv(): Hex {
  const value = requiredEnv("KEEPER_PRIVATE_KEY");
  return (value.startsWith("0x") ? value : `0x${value}`) as Hex;
}

function minimumPrizeEnv(): bigint {
  const value = env("DRAW_KEEPER_MINIMUM_PRIZE");
  const parsed = value ? BigInt(value) : 1_000_000n;
  if (parsed < 0n) throw new Error("DRAW_KEEPER_MINIMUM_PRIZE must be non-negative");
  return parsed;
}

function serializeSnapshot(snapshot: DrawKeeperSnapshot) {
  return Object.fromEntries(
    Object.entries(snapshot).map(([key, value]) => [key, value.toString()]),
  );
}

export async function runDrawKeeper({
  publicClient,
  walletClient,
  account,
  pool,
  minimumPrize,
}: {
  publicClient: ReturnType<typeof createPublicClient>;
  walletClient: ReturnType<typeof createWalletClient>;
  account: PrivateKeyAccount;
  pool: Hex;
  minimumPrize: bigint;
}) {
  const block = await publicClient.getBlock();
  const [nextDrawAt, participantCount, publicPrizeReserve, morphoAccruedYieldAssets] = await Promise.all([
    publicClient.readContract({ address: pool, abi: confidentialPrizePoolAbi, functionName: "nextDrawAt" }),
    publicClient.readContract({ address: pool, abi: confidentialPrizePoolAbi, functionName: "participantCount" }),
    publicClient.readContract({ address: pool, abi: confidentialPrizePoolAbi, functionName: "publicPrizeReserve" }),
    publicClient.readContract({ address: pool, abi: confidentialPrizePoolAbi, functionName: "morphoAccruedYieldAssets" }),
  ]);
  const snapshot = {
    now: block.timestamp,
    nextDrawAt,
    participantCount,
    publicPrizeReserve,
    morphoAccruedYieldAssets,
    minimumPrize,
  } satisfies DrawKeeperSnapshot;
  const action = chooseDrawKeeperAction(snapshot);
  if (!action) return { ok: true, status: "idle" as const, snapshot: serializeSnapshot(snapshot) };

  const hash = await walletClient.writeContract({
    address: pool,
    abi: confidentialPrizePoolAbi,
    account,
    chain: sepolia,
    functionName: "closeDraw",
    args: [],
  });
  return { ok: true, status: "submitted" as const, action, hash, snapshot: serializeSnapshot(snapshot) };
}

export default async () => {
  const rpcUrl = env("SEPOLIA_RPC_URL") ?? requiredEnv("NEXT_PUBLIC_RPC_URL");
  const { readRpcUrl, writeRpcUrl } = resolveKeeperRpcUrls(rpcUrl, env("SEPOLIA_WRITE_RPC_URL"));
  const pool = getAddress(env("CONFIDENTIAL_PRIZE_POOL_ADDRESS") ?? requiredEnv("NEXT_PUBLIC_CONFIDENTIAL_PRIZE_POOL_ADDRESS"));
  const account = privateKeyToAccount(privateKeyEnv());
  const publicClient = createPublicClient({ chain: sepolia, transport: http(readRpcUrl) });
  const walletClient = createWalletClient({ account, chain: sepolia, transport: http(writeRpcUrl) });
  const result = await runDrawKeeper({ publicClient, walletClient, account, pool, minimumPrize: minimumPrizeEnv() });
  console.log(JSON.stringify(result));
  return result;
};
