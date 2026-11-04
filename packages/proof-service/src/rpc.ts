import { decodeEventLog, decodeFunctionResult, encodeFunctionData, toEventSelector } from "viem";
import { confidentialPrizePoolAbi } from "@kettigo/protocol";
import { checksum, hash32, type ArchiveLog, type Namespace, type Node } from "./domain.ts";
import type { BlockHeader } from "./archive.ts";
import type { RpcSource } from "./ingest.ts";

// A two-block slice with 18 receipts/block stays below the Worker external-subrequest budget.
const TIMEOUT_MS = 10_000, MAX_RESPONSE_BYTES = 1_000_000, MAX_RECEIPTS = 18;
const topics = new Set(["NodeUpdated(uint256,uint256,bytes32,bytes32)", "SlotAssigned(address,uint256,uint64)", "SlotReleased(address,uint256,uint64)", "DrawSnapshotClosed(uint256,bytes32,bytes32,bytes32,bytes32,bytes32,uint64,uint256)"].map((x) => toEventSelector(x).toLowerCase()));
type JsonRpc = { result?: unknown; error?: { code?: unknown; message?: unknown } };
class RpcFailure extends Error { constructor(readonly method: string, readonly code?: number, detail?: string) { super(`rpc ${method} failed${detail ? `: ${detail}` : ""}`); } }
const number = (v: unknown, label: string) => { if (typeof v !== "string" || !/^0x[0-9a-fA-F]+$/.test(v)) throw new Error(`invalid ${label}`); const n = Number(BigInt(v)); if (!Number.isSafeInteger(n) || n < 0) throw new Error(`invalid ${label}`); return n; };
const sanitize = (e: unknown) => String(e instanceof Error ? e.message : e).replace(/https?:\/\/[^\s@/]+@/g, "https://").replace(/\?.*$/g, "").slice(0, 240);

export class EthereumRpc implements RpcSource {
  constructor(private readonly url: string, private readonly namespace: Namespace, private readonly confirmations: number) {}
  private async call(method: string, params: unknown[] = []): Promise<unknown> {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await fetch(this.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: controller.signal });
      const length = Number(response.headers.get("content-length") ?? "0");
      if (!Number.isSafeInteger(length) || length < 0 || length > MAX_RESPONSE_BYTES) throw new RpcFailure(method);
      const body = await response.text(); if (body.length > MAX_RESPONSE_BYTES) throw new RpcFailure(method);
      let json: JsonRpc; try { json = JSON.parse(body) as JsonRpc; } catch { throw new RpcFailure(method); }
      if (!response.ok || json.error || json.result === undefined) throw new RpcFailure(method, typeof json.error?.code === "number" ? json.error.code : undefined, typeof json.error?.message === "string" ? sanitize(json.error.message) : undefined);
      return json.result;
    } catch (e) { if (e instanceof RpcFailure) throw e; throw new RpcFailure(method, undefined, "transport failure"); } finally { clearTimeout(timer); }
  }
  async chainId() { return BigInt(number(await this.call("eth_chainId"), "chain id")).toString(); }
  async finalizedHead() { const latest = number(await this.call("eth_blockNumber"), "block number"); return this.block(Math.max(this.namespace.deploymentBlock - 1, latest - this.confirmations)); }
  async block(value: number): Promise<BlockHeader> {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("invalid block number"); const block = await this.call("eth_getBlockByNumber", [`0x${value.toString(16)}`, false]);
    if (!block || typeof block !== "object" || Array.isArray(block)) throw new Error("missing canonical block"); const b = block as Record<string, unknown>;
    if (number(b.number, "block number") !== value) throw new Error("rpc block number mismatch"); return { number: value, hash: hash32(b.hash, "block hash"), parentHash: hash32(b.parentHash, "parent hash") };
  }
  private relevant(log: Record<string, unknown>) { return Array.isArray(log.topics) && typeof log.topics[0] === "string" && topics.has(log.topics[0].toLowerCase()); }
  private decode(log: Record<string, unknown>, from: number, to: number): ArchiveLog | null {
    if (!this.relevant(log)) return null; if (checksum(log.address) !== checksum(this.namespace.pool)) throw new Error("relevant log address mismatch");
    const blockNumber = number(log.blockNumber, "log block number"), logIndex = number(log.logIndex, "log index"), blockHash = hash32(log.blockHash, "log block hash"); if (blockNumber < from || blockNumber > to) throw new Error("relevant log outside requested range");
    if (!Array.isArray(log.topics) || typeof log.data !== "string") throw new Error("malformed relevant log");
    try { const decoded = decodeEventLog({ abi: confidentialPrizePoolAbi, data: log.data as `0x${string}`, topics: log.topics as [], strict: true }); if (!["NodeUpdated", "SlotAssigned", "SlotReleased", "DrawSnapshotClosed"].includes(decoded.eventName)) throw new Error(); const args: Record<string, string> = {}; for (const [key, value] of Object.entries(decoded.args as Record<string, unknown>)) args[key] = typeof value === "bigint" ? value.toString() : String(value); return { blockNumber, blockHash, logIndex, name: decoded.eventName as ArchiveLog["name"], args }; } catch { throw new Error("malformed relevant log"); }
  }
  private decodeMany(raw: unknown, from: number, to: number) { if (!Array.isArray(raw)) throw new Error("invalid rpc log array"); return raw.map((entry) => { if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("invalid rpc log"); return this.decode(entry as Record<string, unknown>, from, to); }).filter((x): x is ArchiveLog => x !== null); }
  async logs(from: number, to: number) { if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to < from) throw new Error("invalid log range"); return this.decodeMany(await this.call("eth_getLogs", [{ address: checksum(this.namespace.pool), fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}` }]), from, to); }
  private async checkedReceipt(raw: unknown, block: BlockHeader) { if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid receipt"); const receipt = raw as Record<string, unknown>; if (number(receipt.blockNumber, "receipt block number") !== block.number || hash32(receipt.blockHash, "receipt block hash") !== block.hash || typeof receipt.transactionHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(receipt.transactionHash)) throw new Error("receipt block identity mismatch"); return this.decodeMany(receipt.logs, block.number, block.number); }
  async receiptLogs(block: BlockHeader) {
    let receipts: unknown; try { receipts = await this.call("eth_getBlockReceipts", [`0x${block.number.toString(16)}`]); } catch (e) { if (!(e instanceof RpcFailure) || e.code !== -32601) throw e; const full = await this.call("eth_getBlockByNumber", [`0x${block.number.toString(16)}`, true]); if (!full || typeof full !== "object" || Array.isArray(full)) throw new Error("invalid full block response"); const b = full as Record<string, unknown>; if (number(b.number, "block number") !== block.number || hash32(b.hash, "block hash") !== block.hash || !Array.isArray(b.transactions) || b.transactions.length > MAX_RECEIPTS) throw new Error("invalid full block response"); receipts = await Promise.all(b.transactions.map((tx) => { if (typeof tx !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(tx)) throw new Error("invalid block transaction hash"); return this.call("eth_getTransactionReceipt", [tx]); })); }
    if (!Array.isArray(receipts)) throw new Error("invalid receipt array"); return (await Promise.all(receipts.map((r) => this.checkedReceipt(r, block)))).flat();
  }
  private callAt(data: `0x${string}`, block: BlockHeader) { return this.call("eth_call", [{ to: checksum(this.namespace.pool), data }, { blockHash: block.hash, requireCanonical: true }]) as Promise<`0x${string}`>; }
  async drawSnapshot(drawId: string, block: BlockHeader) { const data = encodeFunctionData({ abi: confidentialPrizePoolAbi, functionName: "draws", args: [BigInt(drawId)] }); const draw = decodeFunctionResult({ abi: confidentialPrizePoolAbi, functionName: "draws", data: await this.callAt(data, block) }); return { rootHash: hash32(draw[0]), rootSum: hash32(draw[1]), closeBlock: Number(draw[6]) }; }
  async membershipRoot(block: BlockHeader): Promise<Node> { const data = encodeFunctionData({ abi: confidentialPrizePoolAbi, functionName: "membershipNode", args: [BigInt(this.namespace.depth), 0n] }); const node = decodeFunctionResult({ abi: confidentialPrizePoolAbi, functionName: "membershipNode", data: await this.callAt(data, block) }); return { hash: hash32(node[0]), sum: hash32(node[1]) }; }
}

/** Pins one chain-validated source for an entire operation: no silent branch mixing. */
export class FallbackRpc {
  constructor(private readonly primary: RpcSource, private readonly fallback: RpcSource, private readonly namespace: Namespace) {}
  private async valid(source: RpcSource) { if ((await source.chainId()) !== this.namespace.chainId) throw new Error("rpc chain id mismatch"); return source; }
  async withSource<T>(operation: (source: RpcSource) => Promise<T>): Promise<T> { let primary: unknown; try { return await operation(await this.valid(this.primary)); } catch (e) { primary = e; } try { return await operation(await this.valid(this.fallback)); } catch (fallback) { throw new Error(`rpc sources failed: primary=${sanitize(primary)}; fallback=${sanitize(fallback)}`); } }
}

/** Shared constructor so every future HTTP or scheduler operation gets identical chain validation. */
export const createRpc = (primaryUrl: string, historicalUrl: string, namespace: Namespace, confirmations: number) =>
  new FallbackRpc(
    new EthereumRpc(primaryUrl, namespace, confirmations),
    new EthereumRpc(historicalUrl, namespace, confirmations),
    namespace,
  );
