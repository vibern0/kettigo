import { decodeEventLog, decodeFunctionResult, encodeFunctionData, toEventSelector } from "viem";
import { confidentialPrizePoolAbi } from "@kettigo/protocol";
import { checksum, hash32, type ArchiveLog, type Namespace, type Node } from "./domain.ts";
import type { BlockHeader } from "./archive.ts";
import type { RpcSource } from "./ingest.ts";
import { throwIfAborted } from "./ingest.ts";

// A two-block slice with 18 receipts/block stays below the Worker external-subrequest budget.
const TIMEOUT_MS = 10_000,
  MAX_RESPONSE_BYTES = 1_000_000,
  MAX_RECEIPTS = 18;
const topics = new Set(
  [
    "NodeUpdated(uint256,uint256,bytes32,bytes32)",
    "SlotAssigned(address,uint256,uint64)",
    "SlotReleased(address,uint256,uint64)",
    "DrawSnapshotClosed(uint256,bytes32,bytes32,bytes32,bytes32,bytes32,uint64,uint256)",
  ].map((x) => toEventSelector(x).toLowerCase()),
);
type JsonRpc = { result?: unknown; error?: { code?: unknown; message?: unknown } };
class RpcFailure extends Error {
  constructor(
    readonly method: string,
    readonly code?: number,
    safeCause?: "transport" | "response",
  ) {
    super(
      `rpc ${method} failed${code === undefined ? "" : ` (${code})`}${safeCause ? `: ${safeCause}` : ""}`,
    );
  }
}
const number = (v: unknown, label: string) => {
  if (typeof v !== "string" || !/^0x[0-9a-fA-F]+$/.test(v)) throw new Error(`invalid ${label}`);
  const n = Number(BigInt(v));
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`invalid ${label}`);
  return n;
};
const sanitize = (e: unknown) => {
  if (e instanceof RpcFailure) return e.message;
  if (e instanceof Error && e.message === "rpc chain id mismatch") return e.message;
  return "provider operation failed";
};
const readLimitedBody = async (response: Response, method: string) => {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_RESPONSE_BYTES) throw new RpcFailure(method);
      chunks.push(next.value);
    }
  } finally {
    if (total > MAX_RESPONSE_BYTES) await reader.cancel();
  }
  return new TextDecoder().decode(
    chunks.reduce((all, chunk) => {
      const next = new Uint8Array(all.length + chunk.length);
      next.set(all);
      next.set(chunk, all.length);
      return next;
    }, new Uint8Array()),
  );
};
const mapWithConcurrency = async <T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<R>,
) => {
  const result: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (;;) {
        const index = next++;
        if (index >= items.length) return;
        result[index] = await task(items[index]);
      }
    }),
  );
  return result;
};

export class EthereumRpc implements RpcSource {
  constructor(
    private readonly url: string,
    private readonly namespace: Namespace,
    private readonly confirmations: number,
  ) {}
  private async call(
    method: string,
    params: unknown[] = [],
    signal?: AbortSignal,
  ): Promise<unknown> {
    throwIfAborted(signal);
    const controller = new AbortController(),
      timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });
    try {
      const response = await fetch(this.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: controller.signal,
      });
      const length = Number(response.headers.get("content-length") ?? "0");
      if (!Number.isSafeInteger(length) || length < 0 || length > MAX_RESPONSE_BYTES)
        throw new RpcFailure(method);
      const body = await readLimitedBody(response, method);
      let json: JsonRpc;
      try {
        json = JSON.parse(body) as JsonRpc;
      } catch {
        throw new RpcFailure(method);
      }
      if (!response.ok || json.error || json.result === undefined)
        throw new RpcFailure(
          method,
          typeof json.error?.code === "number" ? json.error.code : undefined,
          "response",
        );
      return json.result;
    } catch (e) {
      if (e instanceof RpcFailure) throw e;
      if (signal?.aborted) throwIfAborted(signal);
      throw new RpcFailure(method, undefined, "transport");
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }
  async chainId(signal?: AbortSignal) {
    return BigInt(number(await this.call("eth_chainId", [], signal), "chain id")).toString();
  }
  async finalizedHead(signal?: AbortSignal) {
    const latest = number(await this.call("eth_blockNumber", [], signal), "block number");
    return this.block(
      Math.max(this.namespace.deploymentBlock - 1, latest - this.confirmations),
      signal,
    );
  }
  async latestHead(signal?: AbortSignal) {
    const latest = number(await this.call("eth_blockNumber", [], signal), "block number");
    return this.block(latest, signal);
  }
  async block(value: number, signal?: AbortSignal): Promise<BlockHeader> {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("invalid block number");
    const block = await this.call(
      "eth_getBlockByNumber",
      [`0x${value.toString(16)}`, false],
      signal,
    );
    if (!block || typeof block !== "object" || Array.isArray(block))
      throw new Error("missing canonical block");
    const b = block as Record<string, unknown>;
    if (number(b.number, "block number") !== value) throw new Error("rpc block number mismatch");
    return {
      number: value,
      hash: hash32(b.hash, "block hash"),
      parentHash: hash32(b.parentHash, "parent hash"),
    };
  }
  private relevant(log: Record<string, unknown>) {
    return (
      Array.isArray(log.topics) &&
      typeof log.topics[0] === "string" &&
      topics.has(log.topics[0].toLowerCase())
    );
  }
  private decode(log: Record<string, unknown>, from: number, to: number): ArchiveLog | null {
    if (!this.relevant(log)) return null;
    if (checksum(log.address) !== checksum(this.namespace.pool))
      throw new Error("relevant log address mismatch");
    const blockNumber = number(log.blockNumber, "log block number"),
      logIndex = number(log.logIndex, "log index"),
      blockHash = hash32(log.blockHash, "log block hash");
    if (blockNumber < from || blockNumber > to)
      throw new Error("relevant log outside requested range");
    if (!Array.isArray(log.topics) || typeof log.data !== "string")
      throw new Error("malformed relevant log");
    try {
      const decoded = decodeEventLog({
        abi: confidentialPrizePoolAbi,
        data: log.data as `0x${string}`,
        topics: log.topics as [],
        strict: true,
      });
      if (
        !["NodeUpdated", "SlotAssigned", "SlotReleased", "DrawSnapshotClosed"].includes(
          decoded.eventName,
        )
      )
        throw new Error();
      const args: Record<string, string> = {};
      for (const [key, value] of Object.entries(decoded.args as Record<string, unknown>))
        args[key] = typeof value === "bigint" ? value.toString() : String(value);
      return {
        blockNumber,
        blockHash,
        logIndex,
        name: decoded.eventName as ArchiveLog["name"],
        args,
      };
    } catch {
      throw new Error("malformed relevant log");
    }
  }
  private decodeMany(raw: unknown, from: number, to: number, ignoreNonPool = false) {
    if (!Array.isArray(raw)) throw new Error("invalid rpc log array");
    return raw
      .map((entry) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry))
          throw new Error("invalid rpc log");
        const log = entry as Record<string, unknown>;
        if (ignoreNonPool && checksum(log.address) !== checksum(this.namespace.pool)) return null;
        return this.decode(log, from, to);
      })
      .filter((x): x is ArchiveLog => x !== null);
  }
  async logs(from: number, to: number, signal?: AbortSignal) {
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to < from)
      throw new Error("invalid log range");
    return this.decodeMany(
      await this.call(
        "eth_getLogs",
        [
          {
            address: checksum(this.namespace.pool),
            fromBlock: `0x${from.toString(16)}`,
            toBlock: `0x${to.toString(16)}`,
          },
        ],
        signal,
      ),
      from,
      to,
    );
  }
  private async checkedReceipt(raw: unknown, block: BlockHeader, expectedTransactionHash?: string) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid receipt");
    const receipt = raw as Record<string, unknown>;
    if (
      number(receipt.blockNumber, "receipt block number") !== block.number ||
      hash32(receipt.blockHash, "receipt block hash") !== block.hash ||
      typeof receipt.transactionHash !== "string" ||
      !/^0x[0-9a-fA-F]{64}$/.test(receipt.transactionHash) ||
      (expectedTransactionHash &&
        receipt.transactionHash.toLowerCase() !== expectedTransactionHash.toLowerCase())
    )
      throw new Error("receipt block identity mismatch");
    return {
      transactionHash: receipt.transactionHash.toLowerCase(),
      logs: this.decodeMany(receipt.logs, block.number, block.number, true),
    };
  }
  private async receiptTransactionHashes(block: BlockHeader, signal?: AbortSignal) {
    const full = await this.call(
      "eth_getBlockByNumber",
      [`0x${block.number.toString(16)}`, false],
      signal,
    );
    if (!full || typeof full !== "object" || Array.isArray(full))
      throw new Error("invalid full block response");
    const canonical = full as Record<string, unknown>;
    if (
      number(canonical.number, "block number") !== block.number ||
      hash32(canonical.hash, "block hash") !== block.hash ||
      !Array.isArray(canonical.transactions) ||
      canonical.transactions.length > MAX_RECEIPTS
    )
      throw new Error("invalid full block response");
    const transactionHashes = canonical.transactions.map((tx) => {
      if (typeof tx !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(tx))
        throw new Error("invalid block transaction hash");
      return tx.toLowerCase();
    });
    if (new Set(transactionHashes).size !== transactionHashes.length)
      throw new Error("duplicate block transaction hash");
    return transactionHashes;
  }
  private async receiptsForBlock(
    block: BlockHeader,
    transactionHashes: readonly string[],
    signal?: AbortSignal,
  ) {
    try {
      return {
        receipts: await this.call(
          "eth_getBlockReceipts",
          [`0x${block.number.toString(16)}`],
          signal,
        ),
        fallback: false,
      };
    } catch (e) {
      if (!(e instanceof RpcFailure) || e.code !== -32601) throw e;
      return {
        receipts: await mapWithConcurrency(transactionHashes, 4, (tx) =>
          this.call("eth_getTransactionReceipt", [tx], signal),
        ),
        fallback: true,
      };
    }
  }
  private async checkedReceipts(
    receipts: unknown,
    block: BlockHeader,
    transactionHashes: readonly string[],
    fallback: boolean,
  ) {
    if (!Array.isArray(receipts) || receipts.length !== transactionHashes.length)
      throw new Error("incomplete receipt array");
    return Promise.all(
      receipts.map((receipt, index) =>
        this.checkedReceipt(receipt, block, fallback ? transactionHashes[index] : undefined),
      ),
    );
  }
  private assertReceiptSet(
    receipts: readonly { transactionHash: string }[],
    transactionHashes: readonly string[],
  ) {
    const receiptHashes = new Set(receipts.map((receipt) => receipt.transactionHash));
    if (
      receiptHashes.size !== transactionHashes.length ||
      transactionHashes.some((tx) => !receiptHashes.has(tx))
    )
      throw new Error("incomplete receipt transaction set");
  }
  async receiptLogs(block: BlockHeader, signal?: AbortSignal) {
    const transactionHashes = await this.receiptTransactionHashes(block, signal);
    const { receipts, fallback } = await this.receiptsForBlock(block, transactionHashes, signal);
    const checked = await this.checkedReceipts(receipts, block, transactionHashes, fallback);
    this.assertReceiptSet(checked, transactionHashes);
    return checked.flatMap((receipt) => receipt.logs);
  }
  private callAt(data: `0x${string}`, block: BlockHeader, signal?: AbortSignal) {
    return this.call(
      "eth_call",
      [
        { to: checksum(this.namespace.pool), data },
        { blockHash: block.hash, requireCanonical: true },
      ],
      signal,
    ) as Promise<`0x${string}`>;
  }
  async drawSnapshot(drawId: string, block: BlockHeader, signal?: AbortSignal) {
    const data = encodeFunctionData({
      abi: confidentialPrizePoolAbi,
      functionName: "draws",
      args: [BigInt(drawId)],
    });
    const draw = decodeFunctionResult({
      abi: confidentialPrizePoolAbi,
      functionName: "draws",
      data: await this.callAt(data, block, signal),
    });
    return {
      rootHash: hash32(draw[0]),
      rootSum: hash32(draw[1]),
      ticket: hash32(draw[2]),
      upperBound: BigInt(draw[5]).toString(),
      closeBlock: Number(draw[6]),
    };
  }
  async membershipRoot(block: BlockHeader, signal?: AbortSignal): Promise<Node> {
    const data = encodeFunctionData({
      abi: confidentialPrizePoolAbi,
      functionName: "membershipNode",
      args: [BigInt(this.namespace.depth), 0n],
    });
    const node = decodeFunctionResult({
      abi: confidentialPrizePoolAbi,
      functionName: "membershipNode",
      data: await this.callAt(data, block, signal),
    });
    return { hash: hash32(node[0]), sum: hash32(node[1]) };
  }
}

/** Pins one chain-validated source for an entire operation: no silent branch mixing. */
export class FallbackRpc {
  constructor(
    private readonly primary: RpcSource,
    private readonly fallback: RpcSource,
    private readonly namespace: Namespace,
  ) {}
  private async valid(source: RpcSource, signal?: AbortSignal) {
    throwIfAborted(signal);
    if ((await source.chainId(signal)) !== this.namespace.chainId)
      throw new Error("rpc chain id mismatch");
    return source;
  }
  async withSource<T>(
    operation: (source: RpcSource) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    let primary: unknown;
    try {
      return await operation(await this.valid(this.primary, signal));
    } catch (e) {
      throwIfAborted(signal);
      primary = e;
    }
    try {
      throwIfAborted(signal);
      return await operation(await this.valid(this.fallback, signal));
    } catch (fallback) {
      throw new Error(
        `rpc sources failed: primary=${sanitize(primary)}; fallback=${sanitize(fallback)}`,
      );
    }
  }
}

/** Shared constructor so every future HTTP or scheduler operation gets identical chain validation. */
export const createRpc = (
  primaryUrl: string,
  historicalUrl: string,
  namespace: Namespace,
  confirmations: number,
) =>
  new FallbackRpc(
    new EthereumRpc(primaryUrl, namespace, confirmations),
    new EthereumRpc(historicalUrl, namespace, confirmations),
    namespace,
  );
