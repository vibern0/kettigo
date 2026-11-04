import { handle, type Env } from "./server.ts";
import { D1Archive } from "./archive.ts";
import { validateNamespace } from "./domain.ts";
import { ingestOneSlice } from "./ingest.ts";
import { createRpc } from "./rpc.ts";

const MAX_TICK_MS = 25_000;

async function fixedTokenMatch(actual: string | null, expected: string | undefined) {
  if (!expected) return false;
  const bytes = new TextEncoder();
  const [actualDigest, expectedDigest] = await Promise.all([
    crypto.subtle.digest("SHA-256", bytes.encode(actual ?? "")),
    crypto.subtle.digest("SHA-256", bytes.encode(expected)),
  ]);
  return (
    crypto.subtle as SubtleCrypto & { timingSafeEqual(a: ArrayBuffer, b: ArrayBuffer): boolean }
  ).timingSafeEqual(actualDigest, expectedDigest);
}
async function boundedTick(env: Env) {
  let timer: number | undefined;
  try {
    return await Promise.race([
      tick(env),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("tick timeout")),
          MAX_TICK_MS,
        ) as unknown as number;
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
async function tick(env: Env) {
  const n = validateNamespace({
    chainId: env.CHAIN_ID,
    pool: env.POOL_ADDRESS as `0x${string}`,
    depth: Number(env.TREE_DEPTH),
    zero: env.ZERO_HANDLE,
    emptyHashes: JSON.parse(env.EMPTY_HASHES_JSON),
    deploymentBlock: Number(env.DEPLOYMENT_BLOCK),
  });
  if (!env.PRIMARY_RPC_URL || !env.HISTORICAL_RPC_URL) throw new Error("RPC endpoints unavailable");
  const c = Math.max(0, Number(env.CONFIRMATIONS ?? "6"));
  const archive = new D1Archive(
    (env.PROOF_DB as D1Database & { withSession(bookmark?: string): D1Database }).withSession(
      "first-primary",
    ),
  );
  // Initialization belongs to the scheduler path; it never relies on a client GET.
  const rpc = createRpc(env.PRIMARY_RPC_URL, env.HISTORICAL_RPC_URL, n, c);
  const status = await archive.status(n).catch(() => undefined);
  if (!status) {
    if (n.deploymentBlock === 0) throw new Error("deployment block zero is unsupported");
    const anchor = await rpc.withSource((source) => source.block(n.deploymentBlock - 1));
    await archive.initialize(n, anchor.hash);
  }
  return rpc.withSource((source) =>
    ingestOneSlice(
      archive,
      n,
      source,
      Math.min(2, Math.max(1, Number(env.MAX_BLOCKS_PER_SLICE ?? "2"))),
    ),
  );
}
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const u = new URL(request.url);
    if (u.pathname === "/internal/tick") {
      if (
        request.headers.get("content-length") &&
        Number(request.headers.get("content-length")) > 1024
      )
        return new Response(null, { status: 413 });
      if (
        !(await fixedTokenMatch(
          request.headers.get("authorization"),
          env.OPERATOR_BEARER ? `Bearer ${env.OPERATOR_BEARER}` : undefined,
        ))
      )
        return new Response(null, { status: 401 });
      try {
        const state = await boundedTick(env);
        return Response.json({
          nextBlock: state.nextBlock,
          lastFinalizedBlock: state.lastFinalizedBlock,
        });
      } catch {
        return Response.json({ outcome: "HISTORY_UNAVAILABLE" }, { status: 503 });
      }
    }
    return handle(request, env);
  },
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      boundedTick(env).catch((e) =>
        console.error(
          JSON.stringify({
            event: "ingest_error",
            message: e instanceof Error ? e.message.slice(0, 160) : "unknown",
          }),
        ),
      ),
    );
  },
} satisfies ExportedHandler<Env>;
