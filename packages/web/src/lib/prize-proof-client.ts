import { encodeAbiParameters, getAddress, keccak256 } from "viem";

/** Browser-safe contract for the proof archive. It deliberately does not send transactions. */
export type PrizeDraw = { drawId: bigint; rootHash: `0x${string}`; rootSum: `0x${string}`; ticket: `0x${string}`; upperBound: bigint; closeBlockNumber: bigint };
export type PrizeArchiveDraw = PrizeDraw & { closeLogIndex: number; chainId: bigint; pool: `0x${string}`; blockHash: `0x${string}` };
export type PrizeProof = PrizeDraw & { closeLogIndex: number; chainId: bigint; pool: `0x${string}`; blockHash: `0x${string}`; account: `0x${string}`; index: bigint; generation: bigint; balance: `0x${string}`; siblingHashes: readonly `0x${string}`[]; siblingSums: readonly `0x${string}`[]; parentSums: readonly `0x${string}`[] };
export type PrizeProofResult = { kind: "proof"; proof: PrizeProof } | { kind: "not-eligible" } | { kind: "indexing" | "history-unavailable" | "unavailable"; reason?: string };
export type PrizeChainReader = { readDraw(drawId: bigint): Promise<Pick<PrizeDraw, "rootHash" | "rootSum" | "ticket" | "upperBound" | "closeBlockNumber">>; getBlockHash(blockNumber: bigint): Promise<`0x${string}`> };
export type PrizeProofClientOptions = { chainId: bigint | number; pool: `0x${string}`; account: `0x${string}`; baseUrl: string; chainReader: PrizeChainReader; fetch?: typeof fetch; timeoutMs?: number };

const DEPTH = 32;
const MAX_BODY_BYTES = 128_000;
const UINT_64_MAX = (1n << 64n) - 1n;
const UINT_32_MAX = (1n << 32n) - 1n;
const TREE_CAPACITY = 1n << 32n;
const hash32 = (value: unknown, label: string): `0x${string}` => {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error(`invalid ${label}`);
  return value.toLowerCase() as `0x${string}`;
};
const decimal = (value: unknown, label: string, max?: bigint): bigint => {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) throw new Error(`invalid ${label}`);
  const parsed = BigInt(value); if (max !== undefined && parsed > max) throw new Error(`invalid ${label}`); return parsed;
};
const address = (value: unknown, label: string): `0x${string}` => { try { return getAddress(value as `0x${string}`); } catch { throw new Error(`invalid ${label}`); } };
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const asObject = (value: unknown): Record<string, unknown> => { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid response"); return value as Record<string, unknown>; };
const hashLeaf = (account: `0x${string}`, generation: bigint, balance: `0x${string}`) => keccak256(encodeAbiParameters([{ type: "uint8" }, { type: "address" }, { type: "uint64" }, { type: "bytes32" }], [0, account, generation, balance]));
const hashBranch = (leftHash: `0x${string}`, leftSum: `0x${string}`, rightHash: `0x${string}`, rightSum: `0x${string}`) => keccak256(encodeAbiParameters([{ type: "uint8" }, { type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }], [1, leftHash, leftSum, rightHash, rightSum]));

function parseProof(raw: unknown): PrizeProof {
  const v = asObject(raw); const list = (name: string) => { const x = v[name]; if (!Array.isArray(x) || x.length !== DEPTH) throw new Error(`invalid ${name}`); return x.map((entry, i) => hash32(entry, `${name}[${i}]`)); };
  const closeBlockNumber = v.closeBlockNumber;
  const closeLogIndex = v.closeLogIndex;
  if (!Number.isSafeInteger(closeBlockNumber) || (closeBlockNumber as number) < 0 || !Number.isSafeInteger(closeLogIndex) || (closeLogIndex as number) < 0) throw new Error("invalid close location");
  return { ...parseDraw(v), account: address(v.account, "account"), index: decimal(v.index, "index", UINT_32_MAX), generation: decimal(v.generation, "generation", UINT_64_MAX), balance: hash32(v.balance, "balance"), siblingHashes: list("siblingHashes"), siblingSums: list("siblingSums"), parentSums: list("parentSums") };
}

function parseDraw(raw: unknown): PrizeArchiveDraw {
  const v = asObject(raw); const closeBlockNumber = v.closeBlockNumber; const closeLogIndex = v.closeLogIndex;
  if (!Number.isSafeInteger(closeBlockNumber) || (closeBlockNumber as number) < 0 || !Number.isSafeInteger(closeLogIndex) || (closeLogIndex as number) < 0) throw new Error("invalid close location");
  return { drawId: decimal(v.drawId, "draw id"), rootHash: hash32(v.rootHash, "root hash"), rootSum: hash32(v.rootSum, "root sum"), ticket: hash32(v.ticket, "ticket"), upperBound: decimal(v.upperBound, "upper bound", TREE_CAPACITY), closeBlockNumber: BigInt(closeBlockNumber as number), closeLogIndex: closeLogIndex as number, chainId: decimal(v.chainId, "chain id"), pool: address(v.pool, "pool"), blockHash: hash32(v.blockHash, "block hash") };
}

function assertPath(proof: PrizeProof): void {
  if (proof.generation === 0n || proof.index >= proof.upperBound) throw new Error("invalid proof bounds");
  let nodeHash = hashLeaf(proof.account, proof.generation, proof.balance); let nodeSum = proof.balance;
  for (let level = 0; level < DEPTH; level++) { const siblingHash = proof.siblingHashes[level]; const siblingSum = proof.siblingSums[level]; [nodeHash, nodeSum] = ((proof.index >> BigInt(level)) & 1n) === 0n ? [hashBranch(nodeHash, nodeSum, siblingHash, siblingSum), proof.parentSums[level]] : [hashBranch(siblingHash, siblingSum, nodeHash, nodeSum), proof.parentSums[level]]; }
  if (!same(nodeHash, proof.rootHash) || !same(nodeSum, proof.rootSum)) throw new Error("proof path does not match root");
}

export function createPrizeProofClient(options: PrizeProofClientOptions) {
  const chainId = BigInt(options.chainId); const pool = address(options.pool, "pool"); const account = address(options.account, "account"); const baseUrl = new URL(options.baseUrl);
  const request = async (path: string, signal?: AbortSignal): Promise<Record<string, unknown>> => {
    if (signal?.aborted) throw new DOMException("request aborted", "AbortError");
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000); const abort = () => controller.abort(); signal?.addEventListener("abort", abort, { once: true });
    try { const response = await (options.fetch ?? fetch)(new URL(path, baseUrl), { signal: controller.signal, headers: { accept: "application/json" } }); const contentLength = Number(response.headers.get("content-length") ?? 0); if (!response.ok || !Number.isSafeInteger(contentLength) || contentLength > MAX_BODY_BYTES) throw new Error("archive unavailable"); const body = await response.text(); if (body.length > MAX_BODY_BYTES) throw new Error("archive response too large"); return asObject(JSON.parse(body)); } finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
  };
  const outcome = (body: Record<string, unknown>): PrizeProofResult | null => body.outcome === "NOT_ELIGIBLE" ? { kind: "not-eligible" } : body.outcome === "INDEXING" ? { kind: "indexing" } : body.outcome === "HISTORY_UNAVAILABLE" ? { kind: "history-unavailable" } : null;
  const validate = async (raw: unknown): Promise<PrizeProofResult> => { try { const proof = parseProof(raw); if (proof.chainId !== chainId || !same(proof.pool, pool) || !same(proof.account, account)) throw new Error("wrong proof scope"); assertPath(proof); const draw = await options.chainReader.readDraw(proof.drawId); if (!same(draw.rootHash, proof.rootHash) || !same(draw.rootSum, proof.rootSum) || !same(draw.ticket, proof.ticket) || draw.upperBound !== proof.upperBound || draw.closeBlockNumber !== proof.closeBlockNumber) throw new Error("snapshot mismatch"); if (!same(await options.chainReader.getBlockHash(proof.closeBlockNumber), proof.blockHash)) throw new Error("close block mismatch"); return { kind: "proof", proof }; } catch (error) { if (error instanceof DOMException && error.name === "AbortError") throw error; return { kind: "unavailable", reason: error instanceof Error ? error.message : "invalid proof" }; } };
  return {
    async getProof(drawId: bigint, requestOptions: { signal?: AbortSignal } = {}): Promise<PrizeProofResult> { if (drawId < 0n) throw new Error("invalid draw id"); const body = await request(`v1/${chainId}/${pool}/draws/${drawId}/proof/${account}`, requestOptions.signal); return outcome(body) ?? ("proof" in body ? validate(body.proof) : { kind: "unavailable", reason: "invalid proof response" }); },
    async listDraws(requestOptions: { cursor?: bigint; limit?: number; signal?: AbortSignal } = {}): Promise<{ kind: "draws"; draws: PrizeArchiveDraw[] } | PrizeProofResult> { const limit = requestOptions.limit ?? 25; if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || (requestOptions.cursor !== undefined && requestOptions.cursor < 0n)) throw new Error("invalid pagination"); const query = new URLSearchParams({ limit: String(limit) }); if (requestOptions.cursor !== undefined) query.set("cursor", requestOptions.cursor.toString()); const body = await request(`v1/${chainId}/${pool}/draws?${query}`, requestOptions.signal); const result = outcome(body); if (result) return result; if (!Array.isArray(body.draws) || body.draws.length > limit) return { kind: "unavailable", reason: "invalid draw response" }; try { const draws = body.draws.map(parseDraw); for (const draw of draws) if (draw.chainId !== chainId || !same(draw.pool, pool)) throw new Error("wrong draw scope"); return { kind: "draws", draws }; } catch (error) { return { kind: "unavailable", reason: error instanceof Error ? error.message : "invalid draw response" }; } },
  };
}
