import { D1Archive, type ArchiveDatabase, type Draw } from "./archive.ts";
import { checksum, decimal, uint, type Namespace } from "./domain.ts";
import { createRpc } from "./rpc.ts";

export type Env = Cloudflare.Env & {
  CHAIN_ID: string;
  POOL_ADDRESS: string;
  TREE_DEPTH: string;
  ZERO_HANDLE: string;
  EMPTY_HASHES_JSON: string;
  DEPLOYMENT_BLOCK: string;
  PRIMARY_RPC_URL?: string;
  HISTORICAL_RPC_URL?: string;
  CONFIRMATIONS?: string;
  MAX_BLOCKS_PER_SLICE?: string;
  OPERATOR_BEARER?: string;
  ALLOWED_ORIGINS?: string;
};

const MAX_URL = 2048;
const MAX_RATE_ENTRIES = 4096;
const RATE_WINDOW_MS = 60_000;
const MAX_REQUESTS_PER_WINDOW = 60;
const MAX_CONCURRENT = 8;
const rates = new Map<string, { count: number; expiresAt: number }>();
let activeRequests = 0;

function response(value: unknown, status = 200, headers: HeadersInit = {}) {
  return Response.json(value, { status, headers: { "cache-control": "no-store", ...headers } });
}
function outcome(
  code: "NOT_ELIGIBLE" | "INDEXING" | "HISTORY_UNAVAILABLE",
  status = 409,
  headers: HeadersInit = {},
) {
  return response({ outcome: code }, status, headers);
}
function namespace(e: Env): Namespace {
  return {
    chainId: decimal(e.CHAIN_ID, "chain id"),
    pool: checksum(e.POOL_ADDRESS),
    depth: Number(e.TREE_DEPTH),
    zero: e.ZERO_HANDLE,
    emptyHashes: JSON.parse(e.EMPTY_HASHES_JSON),
    deploymentBlock: Number(e.DEPLOYMENT_BLOCK),
  };
}
function primary(db: D1Database): ArchiveDatabase {
  return (db as D1Database & { withSession(bookmark?: string): ArchiveDatabase }).withSession(
    "first-primary",
  );
}
function cors(request: Request, env: Env): HeadersInit {
  const origin = request.headers.get("origin");
  const allowed = new Set(
    (env.ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
  return origin && allowed.has(origin)
    ? { "access-control-allow-origin": origin, vary: "origin" }
    : {};
}
function rateAllowed(request: Request) {
  const key = request.headers.get("cf-connecting-ip") ?? "anonymous";
  const now = Date.now();
  for (const [candidate, value] of rates) if (value.expiresAt <= now) rates.delete(candidate);
  const current = rates.get(key);
  if (current) {
    if (current.count >= MAX_REQUESTS_PER_WINDOW) return false;
    current.count += 1;
    return true;
  }
  if (rates.size >= MAX_RATE_ENTRIES) return false;
  rates.set(key, { count: 1, expiresAt: now + RATE_WINDOW_MS });
  return true;
}
function rpc(env: Env, n: Namespace) {
  if (!env.PRIMARY_RPC_URL || !env.HISTORICAL_RPC_URL) throw new Error("RPC unavailable");
  return createRpc(
    env.PRIMARY_RPC_URL,
    env.HISTORICAL_RPC_URL,
    n,
    Math.max(0, Number(env.CONFIRMATIONS ?? "6")),
  );
}
const isDecimalPathSegment = (value: string) =>
  value.length > 0 && [...value].every((character) => character >= "0" && character <= "9");
const isAddressPathSegment = (value: string) =>
  value.length === 42 &&
  value.startsWith("0x") &&
  [...value.slice(2)].every(
    (character) =>
      (character >= "0" && character <= "9") ||
      (character >= "a" && character <= "f") ||
      (character >= "A" && character <= "F"),
  );
type Route = { chainId: string; pool: string; drawId?: string; account?: string };
const hasFixedSegments = (segments: readonly string[], fixed: ReadonlyMap<number, string>) =>
  [...fixed].every(([index, value]) => segments[index] === value);
function listRoute(segments: readonly string[]): Route | undefined {
  if (
    segments.length !== 5 ||
    !hasFixedSegments(
      segments,
      new Map([
        [0, ""],
        [1, "v1"],
        [4, "draws"],
      ]),
    )
  )
    return;
  if (!isDecimalPathSegment(segments[2]) || !isAddressPathSegment(segments[3])) return;
  return { chainId: segments[2], pool: segments[3] };
}
function proofRoute(segments: readonly string[]): Route | undefined {
  if (
    segments.length !== 8 ||
    !hasFixedSegments(
      segments,
      new Map([
        [0, ""],
        [1, "v1"],
        [4, "draws"],
        [6, "proof"],
      ]),
    )
  )
    return;
  if (
    !isDecimalPathSegment(segments[2]) ||
    !isAddressPathSegment(segments[3]) ||
    !isDecimalPathSegment(segments[5]) ||
    !isAddressPathSegment(segments[7])
  )
    return;
  return { chainId: segments[2], pool: segments[3], drawId: segments[5], account: segments[7] };
}
function route(pathname: string): Route | undefined {
  const list = listRoute(pathname.split("/"));
  return list ?? proofRoute(pathname.split("/"));
}
async function authenticate(draw: Draw, env: Env, n: Namespace) {
  return rpc(env, n).withSource(async (source) => {
    const close = await source.block(draw.closeBlockNumber);
    if (close.hash !== draw.blockHash) throw new Error("orphan close block");
    const onchain = await source.drawSnapshot(draw.drawId, close);
    if (
      onchain.rootHash !== draw.rootHash ||
      onchain.rootSum !== draw.rootSum ||
      onchain.ticket !== draw.ticket ||
      onchain.upperBound !== draw.upperBound ||
      onchain.closeBlock !== draw.closeBlockNumber
    )
      throw new Error("onchain draw mismatch");
  });
}
async function authenticateCheckpoint(
  state: { lastFinalizedBlock: number; lastFinalizedHash: string },
  env: Env,
  n: Namespace,
) {
  if (state.lastFinalizedBlock < n.deploymentBlock) return;
  await rpc(env, n).withSource(async (source) => {
    const checkpoint = await source.block(state.lastFinalizedBlock);
    if (checkpoint.hash !== state.lastFinalizedHash) throw new Error("orphaned checkpoint");
  });
}
async function absentDrawOutcome(
  archive: D1Archive,
  env: Env,
  n: Namespace,
  drawId: string,
  headers: HeadersInit,
) {
  const state = await archive.status(n);
  return rpc(env, n).withSource(async (source) => {
    const head = await source.latestHead();
    const chainDraw = await source.drawSnapshot(drawId, head);
    if (chainDraw.closeBlock === 0) return outcome("HISTORY_UNAVAILABLE", 404, headers);
    if (chainDraw.closeBlock >= state.nextBlock) return outcome("INDEXING", 409, headers);
    return outcome("HISTORY_UNAVAILABLE", 409, headers);
  });
}
function validRoute(requestRoute: Route, n: Namespace) {
  return (
    decimal(requestRoute.chainId, "chain id") === n.chainId &&
    checksum(requestRoute.pool) === n.pool &&
    (requestRoute.drawId === undefined ||
      uint(requestRoute.drawId, 256, "draw id") === requestRoute.drawId)
  );
}
type ListRequest = { limit: number; cursor?: string };
function listRequest(url: URL): ListRequest | undefined {
  const limit = Number(url.searchParams.get("limit") ?? "20");
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) return;
  const cursor = url.searchParams.get("cursor") ?? undefined;
  if (cursor !== undefined && uint(cursor, 256, "cursor") !== cursor) return;
  return { limit, cursor };
}
async function listDraws(
  archive: D1Archive,
  n: Namespace,
  request: ListRequest,
  env: Env,
  headers: HeadersInit,
) {
  await archive.assertNamespace(n);
  const state = await archive.status(n);
  if (state.disabledReason) return outcome("HISTORY_UNAVAILABLE", 409, headers);
  await authenticateCheckpoint(state, env, n);
  return response(
    { draws: await archive.listDraws(n, request.cursor, request.limit) },
    200,
    headers,
  );
}
async function proofForRoute(
  archive: D1Archive,
  n: Namespace,
  requestRoute: Route,
  env: Env,
  headers: HeadersInit,
) {
  await archive.assertNamespace(n);
  const state = await archive.status(n);
  if (state.disabledReason) return outcome("HISTORY_UNAVAILABLE", 409, headers);
  const draw = await archive.drawById(n, requestRoute.drawId!);
  if (!draw) return absentDrawOutcome(archive, env, n, requestRoute.drawId!, headers);
  await authenticate(draw, env, n);
  const proof = await archive.proof(n, requestRoute.drawId!, requestRoute.account!);
  return proof ? response({ proof }, 200, headers) : outcome("NOT_ELIGIBLE", 404, headers);
}
async function proofResponse(url: URL, env: Env, n: Namespace, headers: HeadersInit) {
  const requestRoute = route(url.pathname);
  if (!requestRoute || !validRoute(requestRoute, n))
    return response({ outcome: "HISTORY_UNAVAILABLE" }, 404, headers);
  if (!requestRoute.drawId) {
    const request = listRequest(url);
    if (!request) return response({ outcome: "HISTORY_UNAVAILABLE" }, 400, headers);
    return listDraws(new D1Archive(primary(env.PROOF_DB)), n, request, env, headers);
  }
  const archive = new D1Archive(primary(env.PROOF_DB));
  return proofForRoute(archive, n, requestRoute, env, headers);
}

export async function handle(request: Request, env: Env): Promise<Response> {
  const headers = cors(request, env);
  if (request.method === "OPTIONS")
    return new Response(null, {
      status: 204,
      headers: {
        ...headers,
        "cache-control": "no-store",
        "access-control-allow-methods": "GET, OPTIONS",
        "access-control-allow-headers": "content-type",
      },
    });
  if (request.method !== "GET") return response({ outcome: "HISTORY_UNAVAILABLE" }, 405, headers);
  if (request.url.length > MAX_URL || !rateAllowed(request))
    return response({ outcome: "HISTORY_UNAVAILABLE" }, 429, headers);
  if (activeRequests >= MAX_CONCURRENT)
    return response({ outcome: "HISTORY_UNAVAILABLE" }, 429, headers);
  activeRequests += 1;
  try {
    const n = namespace(env);
    return await proofResponse(new URL(request.url), env, n, headers);
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown";
    console.error(JSON.stringify({ event: "proof-service-error", message: message.slice(0, 160) }));
    return outcome("HISTORY_UNAVAILABLE", 409, headers);
  } finally {
    activeRequests -= 1;
  }
}
