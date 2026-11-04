import { handle, type Env } from "./server.ts";
import { D1Archive } from "./archive.ts";
import { validateNamespace } from "./domain.ts";
import { ingestOneSlice } from "./ingest.ts";
import { EthereumRpc, FallbackRpc } from "./rpc.ts";
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
  const archive = new D1Archive(env.PROOF_DB);
  // Initialization belongs to the scheduler path; it never relies on a client GET.
  const rpc = new FallbackRpc(
    new EthereumRpc(env.PRIMARY_RPC_URL, n, c),
    new EthereumRpc(env.HISTORICAL_RPC_URL, n, c),
  );
  const status = await archive.status(n).catch(() => undefined);
  if (!status) {
    if (n.deploymentBlock === 0) throw new Error("deployment block zero is unsupported");
    const anchor = await rpc.block(n.deploymentBlock - 1);
    await archive.initialize(n, anchor.hash);
  }
  return ingestOneSlice(
    archive,
    n,
    rpc,
    Math.min(20, Math.max(1, Number(env.MAX_BLOCKS_PER_SLICE ?? "2"))),
  );
}
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const u = new URL(request.url);
    if (u.pathname === "/internal/tick") {
      if (
        !env.OPERATOR_BEARER ||
        request.headers.get("authorization") !== `Bearer ${env.OPERATOR_BEARER}`
      )
        return new Response(null, { status: 401 });
      ctx.waitUntil(tick(env));
      return Response.json({ accepted: true }, { status: 202 });
    }
    return handle(request, env);
  },
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      tick(env).catch((e) =>
        console.error(
          JSON.stringify({
            event: "ingest_error",
            message: e instanceof Error ? e.message : "unknown",
          }),
        ),
      ),
    );
  },
} satisfies ExportedHandler<Env>;
