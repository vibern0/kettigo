import { handle, type Env } from "./server.ts";
import { D1Archive } from "./archive.ts";
import { validateNamespace } from "./domain.ts";
import { ingestOneSlice } from "./ingest.ts";
import { createRpc } from "./rpc.ts";
import { throwIfAborted } from "./ingest.ts";

const MAX_TICK_MS = 25_000;

const MAX_OPERATOR_INPUT_BYTES = 1024;

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
async function readBoundedBody(request: Request) {
  const reader = request.body?.getReader();
  if (!reader) return;
  let total = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) return;
      total += part.value.byteLength;
      if (total > MAX_OPERATOR_INPUT_BYTES) throw new Error("operator body too large");
    }
  } finally {
    if (total > MAX_OPERATOR_INPUT_BYTES) await reader.cancel();
  }
}
/** Cancels future network work at the deadline; an already-started D1 batch still settles atomically. */
export async function runWithinDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  deadlineMs = MAX_TICK_MS,
) {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error("tick deadline exceeded")),
    deadlineMs,
  ) as unknown as number;
  try {
    return await operation(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}
async function boundedTick(env: Env) {
  return runWithinDeadline((signal) => tick(env, signal));
}
async function tick(env: Env, signal?: AbortSignal) {
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
    const anchor = await rpc.withSource(
      (source) => source.block(n.deploymentBlock - 1, signal),
      signal,
    );
    throwIfAborted(signal);
    await archive.initialize(n, anchor.hash);
  } else await archive.assertNamespace(n);
  throwIfAborted(signal);
  return rpc.withSource(
    (source) =>
      ingestOneSlice(
        archive,
        n,
        source,
        Math.min(2, Math.max(1, Number(env.MAX_BLOCKS_PER_SLICE ?? "2"))),
        signal,
      ),
    signal,
  );
}
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const u = new URL(request.url);
    if (u.pathname === "/internal/tick") {
      if (request.method !== "POST")
        return new Response(null, { status: 405, headers: { allow: "POST" } });
      const contentLength = request.headers.get("content-length");
      if (
        (contentLength !== null &&
          (!/^\d+$/.test(contentLength) || Number(contentLength) > MAX_OPERATOR_INPUT_BYTES)) ||
        new TextEncoder().encode(request.headers.get("authorization") ?? "").byteLength >
          MAX_OPERATOR_INPUT_BYTES
      )
        return new Response(null, { status: 413 });
      try {
        await readBoundedBody(request);
      } catch {
        return new Response(null, { status: 413, headers: { "cache-control": "no-store" } });
      }
      if (
        !(await fixedTokenMatch(
          request.headers.get("authorization"),
          env.OPERATOR_BEARER ? `Bearer ${env.OPERATOR_BEARER}` : undefined,
        ))
      )
        return new Response(null, { status: 401 });
      try {
        const state = await boundedTick(env);
        return Response.json(
          {
            nextBlock: state.nextBlock,
            lastFinalizedBlock: state.lastFinalizedBlock,
          },
          { headers: { "cache-control": "no-store" } },
        );
      } catch {
        return Response.json(
          { outcome: "HISTORY_UNAVAILABLE" },
          { status: 503, headers: { "cache-control": "no-store" } },
        );
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
