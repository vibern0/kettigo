import {
  isValidEmail,
  normalizeEmail,
  readAccessStatus,
  registerWaitlistInterest,
} from "./worker/access";
import { createPublicClient, createWalletClient, getAddress, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { confidentialPrizePoolAbi } from "@kettigo/protocol";
import { chooseDrawKeeperAction, type DrawKeeperSnapshot } from "./src/lib/draw-keeper";
import { normalizeKeeperMaxTransactions } from "./src/lib/morpho-keeper";
import { sanitizeKeeperError } from "./src/lib/morpho-keeper";
import { runMorphoKeeper } from "./netlify/functions/morpho-keeper";
import { runWithdrawalKeeper } from "./netlify/functions/withdrawal-keeper";
import {
  runtimeConfigScript,
  type PublicRuntimeEnv,
} from "./worker/runtime-config-bootstrap";

type D1StatementLike = {
  bind(...values: unknown[]): D1StatementLike;
  first<T = unknown>(): Promise<T | null>;
  run(): Promise<unknown>;
};

type Env = PublicRuntimeEnv & {
  ASSETS: {
    fetch(request: Request): Promise<Response>;
  };
  DB: {
    prepare(sql: string): D1StatementLike;
  };
  NEXT_PUBLIC_CHAIN_ID?: string;
  NEXT_PUBLIC_CONFIDENTIAL_PRIZE_POOL_ADDRESS?: string;
  NEXT_PUBLIC_CONFIDENTIAL_USDC_ADDRESS?: string;
  NEXT_PUBLIC_PASSKEY_RP_ID?: string;
  NEXT_PUBLIC_PASSKEY_RP_NAME?: string;
  NEXT_PUBLIC_PIMLICO_API_KEY?: string;
  NEXT_PUBLIC_RPC_URL?: string;
  NEXT_PUBLIC_USDC_ADDRESS?: string;
  DRAW_KEEPER_TRIGGER_TOKEN?: string;
  KEEPER_PRIVATE_KEY?: string;
  MORPHO_KEEPER_MAX_TXS?: string;
  MORPHO_KEEPER_START_BLOCK?: string;
  SEPOLIA_RPC_URL?: string;
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/config.js") {
      return new Response(
        runtimeConfigScript(env),
        {
          headers: {
            "content-type": "application/javascript; charset=utf-8",
            "cache-control": "no-store",
          },
        },
      );
    }

    if (url.pathname === "/api/waitlist" && request.method === "POST") {
      return handleWaitlist(request, env);
    }

    if (url.pathname === "/api/access/status" && request.method === "POST") {
      return handleAccessStatus(request, env);
    }

    if (url.pathname === "/api/keeper/draw" && request.method === "POST") {
      return handleDrawKeeperTrigger(request, env);
    }

    if (url.pathname === "/api/keeper/all" && request.method === "POST") {
      return handleKeeperAllTrigger(request, env);
    }

    if (url.pathname.startsWith("/api/")) {
      return json({ ok: false, status: "invalid_request" }, 404);
    }

    const asset = await env.ASSETS.fetch(request);
    if (!asset.headers.get("content-type")?.toLowerCase().includes("text/html")) {
      return asset;
    }

    const bootstrap = runtimeConfigScript(env);
    return new HTMLRewriter()
      .on("head", {
        element(element) {
          element.prepend(`<script>${bootstrap}</script>`, { html: true });
        },
      })
      .transform(asset);
  },

  scheduled(controller: { cron: string }, env: Env, ctx: { waitUntil(promise: Promise<unknown>): void }) {
    switch (controller.cron) {
      case "* * * * *":
        ctx.waitUntil(runDrawKeeper(env, "cron"));
        break;
      case "1-59/5 * * * *":
        ctx.waitUntil(runScheduledWithdrawalKeeper(env));
        break;
      case "3-59/5 * * * *":
        ctx.waitUntil(runScheduledMorphoKeeper(env));
        break;
    }
  },
};

async function handleWaitlist(request: Request, env: Env): Promise<Response> {
  try {
    const body = await readJsonBody(request);
    const email = typeof body.email === "string" ? body.email : "";
    const normalized = normalizeEmail(email);
    if (!isValidEmail(normalized)) {
      return json({ ok: false, status: "invalid_request" }, 400);
    }
    return json(await registerWaitlistInterest(env.DB, normalized), 200);
  } catch {
    return json({ ok: false, status: "temporarily_unavailable" }, 503);
  }
}

async function handleAccessStatus(request: Request, env: Env): Promise<Response> {
  try {
    const body = await readJsonBody(request);
    const email = typeof body.email === "string" ? body.email : "";
    const result = await readAccessStatus(env.DB, email);
    return json(result, result.status === "invalid_request" ? 400 : 200);
  } catch {
    return json({ ok: false, status: "temporarily_unavailable" }, 503);
  }
}

async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.split(";").map((part) => part.trim()).includes("application/json")) {
    throw new Error("invalid_content_type");
  }
  const parsed = await request.json();
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("invalid_body");
  }
  return parsed as Record<string, unknown>;
}

function json(body: unknown, status: number): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

async function handleDrawKeeperTrigger(request: Request, env: Env): Promise<Response> {
  const token = env.DRAW_KEEPER_TRIGGER_TOKEN;
  if (!token) return json({ ok: false, status: "not_configured" }, 404);
  if (request.headers.get("authorization") !== `Bearer ${token}`) {
    return json({ ok: false, status: "unauthorized" }, 401);
  }

  const result = await runDrawKeeper(env, "manual");
  return json(result, result.ok ? 200 : result.status === "not_configured" ? 503 : 200);
}

async function handleKeeperAllTrigger(request: Request, env: Env): Promise<Response> {
  const token = env.DRAW_KEEPER_TRIGGER_TOKEN;
  if (!token) return json({ ok: false, status: "not_configured" }, 404);
  if (request.headers.get("authorization") !== `Bearer ${token}`) {
    return json({ ok: false, status: "unauthorized" }, 401);
  }

  const result = await runKeeperAll(env, "manual");
  return json(result, result.ok ? 200 : result.status === "not_configured" ? 503 : 200);
}

async function runKeeperAll(env: Env, source: "cron" | "manual") {
  const context = createKeeperContext(env);
  if (!context) {
    const result = { ok: false, source, status: "not_configured" as const };
    console.log(JSON.stringify(result));
    return result;
  }

  const lanes = {
    morpho: await runKeeperLane("morpho", () => runMorphoKeeper({
      ...context,
      maxTransactions: normalizeKeeperMaxTransactions(env.MORPHO_KEEPER_MAX_TXS),
      startBlock: parseRequiredBigint(env.MORPHO_KEEPER_START_BLOCK, "MORPHO_KEEPER_START_BLOCK"),
    })),
    withdrawal: await runKeeperLane("withdrawal", () => runWithdrawalKeeper(context)),
    draw: await runKeeperLane("draw", () => runDrawKeeperWithContext(context, env, source)),
  };
  const result = { ok: Object.values(lanes).every((lane) => lane.ok), source, status: "ran" as const, lanes };
  console.log(JSON.stringify(result));
  return result;
}

async function runKeeperLane(name: string, run: () => Promise<unknown>) {
  try {
    const result = await run();
    const body = result instanceof Response ? await result.json() : result;
    return { ok: true, name, result: serializeKeeperResult(body) };
  } catch (error) {
    return { ok: false, name, error: sanitizeKeeperError(error) };
  }
}

async function runScheduledWithdrawalKeeper(env: Env) {
  return runScheduledKeeperLane(env, "withdrawal", (context) => runWithdrawalKeeper(context));
}

async function runScheduledMorphoKeeper(env: Env) {
  return runScheduledKeeperLane(env, "morpho", (context) => runMorphoKeeper({
    ...context,
    maxTransactions: normalizeKeeperMaxTransactions(env.MORPHO_KEEPER_MAX_TXS),
    startBlock: parseRequiredBigint(env.MORPHO_KEEPER_START_BLOCK, "MORPHO_KEEPER_START_BLOCK"),
  }));
}

async function runScheduledKeeperLane(
  env: Env,
  name: "morpho" | "withdrawal",
  run: (context: NonNullable<ReturnType<typeof createKeeperContext>>) => Promise<unknown>,
) {
  const context = createKeeperContext(env);
  if (!context) {
    const result = { ok: false, source: "cron" as const, status: "not_configured" as const, name };
    console.log(JSON.stringify(result));
    return result;
  }

  const lane = await runKeeperLane(name, () => run(context));
  const result = { ok: lane.ok, source: "cron" as const, status: "ran" as const, lane };
  console.log(JSON.stringify(result));
  return result;
}

async function runDrawKeeper(env: Env, source: "cron" | "manual") {
  try {
    const context = createKeeperContext(env);
    if (!context) {
      const result = { ok: false, source, status: "not_configured" as const };
      console.log(JSON.stringify(result));
      return result;
    }
    const result = await runDrawKeeperWithContext(context, env, source);
    console.log(JSON.stringify(result));
    return result;
  } catch (error) {
    const result = { ok: false, source, status: "error" as const, error: sanitizeKeeperError(error) };
    console.log(JSON.stringify(result));
    return result;
  }
}

function createKeeperContext(env: Env) {
  const rpcUrl = env.SEPOLIA_RPC_URL ?? env.NEXT_PUBLIC_RPC_URL;
  const poolAddress = env.NEXT_PUBLIC_CONFIDENTIAL_PRIZE_POOL_ADDRESS;
  const privateKey = normalizePrivateKey(env.KEEPER_PRIVATE_KEY);
  if (!rpcUrl || !poolAddress || !privateKey) return undefined;

  const pool = getAddress(poolAddress);
  const account = privateKeyToAccount(privateKey);
  const publicClient = createPublicClient({ chain: sepolia, transport: http(rpcUrl) });
  const walletClient = createWalletClient({ account, chain: sepolia, transport: http(rpcUrl) });
  return { rpcUrl, pool, account, publicClient, walletClient };
}

async function runDrawKeeperWithContext(
  context: NonNullable<ReturnType<typeof createKeeperContext>>,
  env: Env,
  source: "cron" | "manual",
) {
  const block = await context.publicClient.getBlock();
  const [nextDrawAt, participantCount, publicPrizeReserve, morphoAccruedYieldAssets] = await Promise.all([
    context.publicClient.readContract({ address: context.pool, abi: confidentialPrizePoolAbi, functionName: "nextDrawAt" }),
    context.publicClient.readContract({ address: context.pool, abi: confidentialPrizePoolAbi, functionName: "participantCount" }),
    context.publicClient.readContract({ address: context.pool, abi: confidentialPrizePoolAbi, functionName: "publicPrizeReserve" }),
    context.publicClient.readContract({ address: context.pool, abi: confidentialPrizePoolAbi, functionName: "morphoAccruedYieldAssets" }),
  ]);
  const snapshot = {
    now: block.timestamp,
    nextDrawAt,
    participantCount,
    publicPrizeReserve,
    morphoAccruedYieldAssets,
  } satisfies DrawKeeperSnapshot;

  const action = chooseDrawKeeperAction(snapshot);
  if (!action) {
    return { ok: true, source, status: "idle" as const, snapshot: serializeDrawSnapshot(snapshot) };
  }

  const hash = await context.walletClient.writeContract({
    address: context.pool,
    abi: confidentialPrizePoolAbi,
    account: context.account,
    chain: sepolia,
    functionName: "closeDraw",
    args: [],
  });
  return { ok: true, source, status: "submitted" as const, action, hash, snapshot: serializeDrawSnapshot(snapshot) };
}

function normalizePrivateKey(value: string | undefined): Hex | undefined {
  if (!value) return undefined;
  return (value.startsWith("0x") ? value : `0x${value}`) as Hex;
}

function parseRequiredBigint(value: string | undefined, name: string): bigint {
  if (!value) throw new Error(`${name} is required`);
  const parsed = BigInt(value);
  if (parsed < 0n) throw new Error(`${name} must be non-negative`);
  return parsed;
}

function serializeDrawSnapshot(snapshot: DrawKeeperSnapshot) {
  return Object.fromEntries(
    Object.entries(snapshot).map(([key, value]) => [key, value.toString()]),
  );
}

function serializeKeeperResult(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(serializeKeeperResult);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, serializeKeeperResult(item)]),
    );
  }
  return value;
}
