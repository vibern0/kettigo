import { encodeAbiParameters, getAddress, keccak256 } from "viem";

export type PrizeDraw = {
  drawId: bigint;
  rootHash: `0x${string}`;
  rootSum: `0x${string}`;
  ticket: `0x${string}`;
  upperBound: bigint;
  closeBlockNumber: bigint;
};
export type PrizeArchiveDraw = PrizeDraw & {
  closeLogIndex: number;
  chainId: bigint;
  pool: `0x${string}`;
  blockHash: `0x${string}`;
};
export type PrizeProof = PrizeArchiveDraw & {
  account: `0x${string}`;
  index: bigint;
  generation: bigint;
  balance: `0x${string}`;
  siblingHashes: readonly `0x${string}`[];
  siblingSums: readonly `0x${string}`[];
  parentSums: readonly `0x${string}`[];
};
export type PrizeProofResult =
  | { kind: "proof"; proof: PrizeProof }
  | { kind: "not-eligible" }
  | { kind: "indexing" | "history-unavailable" | "unavailable"; reason?: string };
export type PrizeReadOptions = { signal?: AbortSignal };
export type PrizeChainReader = {
  readDraw(
    drawId: bigint,
    options?: PrizeReadOptions,
  ): Promise<
    Pick<PrizeDraw, "rootHash" | "rootSum" | "ticket" | "upperBound" | "closeBlockNumber">
  >;
  getBlockHash(blockNumber: bigint, options?: PrizeReadOptions): Promise<`0x${string}`>;
};
export type PrizeProofClientOptions = {
  chainId: bigint | number;
  pool: `0x${string}`;
  account: `0x${string}`;
  baseUrl: string;
  chainReader: PrizeChainReader;
  fetch?: typeof fetch;
  timeoutMs?: number;
};

const DEPTH = 32,
  MAX_BODY_BYTES = 128_000,
  UINT256_MAX = (1n << 256n) - 1n,
  UINT64_MAX = (1n << 64n) - 1n,
  UINT32_MAX = (1n << 32n) - 1n,
  TREE_CAPACITY = 1n << 32n;
const abort = () => new DOMException("request aborted", "AbortError");
const live = (signal?: AbortSignal) => {
  if (signal?.aborted) throw abort();
};
const unavailable = (reason: string): PrizeProofResult => ({ kind: "unavailable", reason });
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
function decimal(value: unknown, label: string, max = UINT256_MAX): bigint {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value))
    throw new Error(`invalid ${label}`);
  const v = BigInt(value);
  if (v > max) throw new Error(`invalid ${label}`);
  return v;
}
function h32(value: unknown, label: string): `0x${string}` {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value))
    throw new Error(`invalid ${label}`);
  return value.toLowerCase() as `0x${string}`;
}
function addr(value: unknown, label: string): `0x${string}` {
  try {
    return getAddress(value as `0x${string}`);
  } catch {
    throw new Error(`invalid ${label}`);
  }
}
function obj(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid response");
  return value as Record<string, unknown>;
}
function parseDraw(raw: unknown): PrizeArchiveDraw {
  const v = obj(raw),
    b = v.closeBlockNumber,
    l = v.closeLogIndex;
  if (
    !Number.isSafeInteger(b) ||
    (b as number) < 0 ||
    !Number.isSafeInteger(l) ||
    (l as number) < 0
  )
    throw new Error("invalid close location");
  return {
    drawId: decimal(v.drawId, "draw id"),
    rootHash: h32(v.rootHash, "root hash"),
    rootSum: h32(v.rootSum, "root sum"),
    ticket: h32(v.ticket, "ticket"),
    upperBound: decimal(v.upperBound, "upper bound", TREE_CAPACITY),
    closeBlockNumber: BigInt(b as number),
    closeLogIndex: l as number,
    chainId: decimal(v.chainId, "chain id"),
    pool: addr(v.pool, "pool"),
    blockHash: h32(v.blockHash, "block hash"),
  };
}
function hashes(v: Record<string, unknown>, field: string) {
  if (!Array.isArray(v[field]) || v[field].length !== DEPTH) throw new Error(`invalid ${field}`);
  return v[field].map((x, i) => h32(x, `${field}[${i}]`));
}
function parseProof(raw: unknown): PrizeProof {
  const v = obj(raw);
  return {
    ...parseDraw(v),
    account: addr(v.account, "account"),
    index: decimal(v.index, "index", UINT32_MAX),
    generation: decimal(v.generation, "generation", UINT64_MAX),
    balance: h32(v.balance, "balance"),
    siblingHashes: hashes(v, "siblingHashes"),
    siblingSums: hashes(v, "siblingSums"),
    parentSums: hashes(v, "parentSums"),
  };
}
function leaf(a: `0x${string}`, g: bigint, b: `0x${string}`) {
  return keccak256(
    encodeAbiParameters(
      [{ type: "uint8" }, { type: "address" }, { type: "uint64" }, { type: "bytes32" }],
      [0, a, g, b],
    ),
  );
}
function branch(a: `0x${string}`, b: `0x${string}`, c: `0x${string}`, d: `0x${string}`) {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "uint8" },
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "bytes32" },
      ],
      [1, a, b, c, d],
    ),
  );
}
function path(p: PrizeProof) {
  if (!p.drawId || !p.generation || !p.upperBound || p.index >= p.upperBound)
    throw new Error("invalid proof bounds");
  let hash = leaf(p.account, p.generation, p.balance),
    sum = p.balance;
  for (let i = 0; i < DEPTH; i++)
    [hash, sum] =
      ((p.index >> BigInt(i)) & 1n) === 0n
        ? [branch(hash, sum, p.siblingHashes[i], p.siblingSums[i]), p.parentSums[i]]
        : [branch(p.siblingHashes[i], p.siblingSums[i], hash, sum), p.parentSums[i]];
  if (!same(hash, p.rootHash) || !same(sum, p.rootSum))
    throw new Error("proof path does not match root");
}
async function readJson(response: Response, signal?: AbortSignal) {
  const length = response.headers.get("content-length");
  if (length && (!/^\d+$/.test(length) || BigInt(length) > BigInt(MAX_BODY_BYTES)))
    throw new Error("archive response too large");
  if (!response.body) throw new Error("empty archive response");
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      live(signal);
      const item = await reader.read();
      live(signal);
      if (item.done) break;
      size += item.value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new Error("archive response too large");
      }
      chunks.push(item.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return obj(JSON.parse(new TextDecoder().decode(bytes)));
}
function outcome(status: number, body: Record<string, unknown>): PrizeProofResult | null {
  if (status === 404 && body.outcome === "NOT_ELIGIBLE") return { kind: "not-eligible" };
  if (status === 409 && body.outcome === "INDEXING") return { kind: "indexing" };
  if ((status === 404 || status === 409) && body.outcome === "HISTORY_UNAVAILABLE")
    return { kind: "history-unavailable" };
  return null;
}

export function createPrizeProofClient(options: PrizeProofClientOptions) {
  const chainId = BigInt(options.chainId);
  if (chainId !== 11155111n) throw new Error("unsupported chain");
  const pool = addr(options.pool, "pool"),
    account = addr(options.account, "account"),
    base = new URL(options.baseUrl);
  const request = async (
    url: string,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown> | PrizeProofResult> => {
    live(signal);
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, options.timeoutMs ?? 10_000),
      cancel = () => controller.abort();
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      const response = await (options.fetch ?? fetch)(new URL(url, base), {
          signal: controller.signal,
          headers: { accept: "application/json" },
        }),
        body = await readJson(response, signal);
      live(signal);
      return (
        outcome(response.status, body) ??
        (response.ok ? body : unavailable(`archive HTTP ${response.status}`))
      );
    } catch (e) {
      live(signal);
      return unavailable(
        timedOut ? "archive timeout" : e instanceof Error ? e.message : "archive unavailable",
      );
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
    }
  };
  const validate = async (
    raw: unknown,
    drawId: bigint,
    signal?: AbortSignal,
  ): Promise<PrizeProofResult> => {
    try {
      live(signal);
      const p = parseProof(raw);
      if (
        p.drawId !== drawId ||
        p.chainId !== chainId ||
        !same(p.pool, pool) ||
        !same(p.account, account)
      )
        throw new Error("wrong proof scope");
      path(p);
      live(signal);
      const draw = await options.chainReader.readDraw(drawId, { signal });
      live(signal);
      if (
        !same(draw.rootHash, p.rootHash) ||
        !same(draw.rootSum, p.rootSum) ||
        !same(draw.ticket, p.ticket) ||
        draw.upperBound !== p.upperBound ||
        draw.closeBlockNumber !== p.closeBlockNumber
      )
        throw new Error("snapshot mismatch");
      const blockHash = await options.chainReader.getBlockHash(p.closeBlockNumber, { signal });
      live(signal);
      if (!same(blockHash, p.blockHash)) throw new Error("close block mismatch");
      return { kind: "proof", proof: p };
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") throw e;
      return unavailable(e instanceof Error ? e.message : "invalid proof");
    }
  };
  return {
    async getProof(drawId: bigint, requestOptions: PrizeReadOptions = {}) {
      if (drawId <= 0n || drawId > UINT256_MAX) throw new Error("invalid draw id");
      const result = await request(
        `v1/${chainId}/${pool}/draws/${drawId}/proof/${account}`,
        requestOptions.signal,
      );
      return "kind" in result
        ? result
        : "proof" in result
          ? validate(result.proof, drawId, requestOptions.signal)
          : unavailable("invalid proof response");
    },
    async listDraws(
      requestOptions: { cursor?: bigint; limit?: number; signal?: AbortSignal } = {},
    ) {
      const limit = requestOptions.limit ?? 25;
      if (
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > 100 ||
        (requestOptions.cursor !== undefined &&
          (requestOptions.cursor < 0n || requestOptions.cursor > UINT256_MAX))
      )
        throw new Error("invalid pagination");
      const q = new URLSearchParams({ limit: String(limit) });
      if (requestOptions.cursor !== undefined) q.set("cursor", requestOptions.cursor.toString());
      const result = await request(`v1/${chainId}/${pool}/draws?${q}`, requestOptions.signal);
      if ("kind" in result) return result;
      if (!Array.isArray(result.draws) || result.draws.length > limit)
        return unavailable("invalid draw response");
      try {
        const draws = result.draws.map(parseDraw);
        let previous: bigint | undefined;
        for (const draw of draws) {
          if (
            !draw.drawId ||
            draw.chainId !== chainId ||
            !same(draw.pool, pool) ||
            (previous !== undefined && draw.drawId >= previous)
          )
            throw new Error("invalid draw ordering or scope");
          previous = draw.drawId;
        }
        return { kind: "draws" as const, draws };
      } catch (e) {
        return unavailable(e instanceof Error ? e.message : "invalid draw response");
      }
    },
  };
}
