import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeAbiParameters, encodeEventTopics, keccak256, toHex } from "viem";
import { confidentialPrizePoolAbi } from "@kettigo/protocol";
import { EthereumRpc, FallbackRpc } from "../src/rpc.ts";
import { runWithinDeadline } from "../src/worker.ts";
import { branchHash, leafHash, type Namespace } from "../src/domain.ts";
import type { RpcSource } from "../src/ingest.ts";

const zero = `0x${"00".repeat(32)}`;
const pool = "0x00000000000000000000000000000000000000a1" as const;
const blockHash = `0x${"11".repeat(32)}`;
const parentHash = `0x${"22".repeat(32)}`;
const txHash = `0x${"33".repeat(32)}`;

function namespace(): Namespace {
  const leaf = leafHash("0x0000000000000000000000000000000000000000", "0", zero);
  return {
    chainId: "11155111",
    pool,
    depth: 1,
    zero,
    emptyHashes: [leaf, branchHash({ hash: leaf, sum: zero }, { hash: leaf, sum: zero })],
    deploymentBlock: 1,
  };
}

function response(result: unknown, status = 200): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { status });
}

function rpcLog(overrides: Record<string, unknown> = {}) {
  const event = confidentialPrizePoolAbi.find(
    (x) => x.type === "event" && x.name === "NodeUpdated",
  )!;
  return {
    address: pool,
    blockNumber: "0x1",
    blockHash,
    transactionHash: txHash,
    transactionIndex: "0x0",
    logIndex: "0x0",
    removed: false,
    topics: encodeEventTopics({
      abi: [event],
      eventName: "NodeUpdated",
      args: { level: 0n, index: 0n },
    }),
    data: encodeAbiParameters(
      [{ type: "bytes32" }, { type: "bytes32" }],
      [zero as `0x${string}`, zero as `0x${string}`],
    ),
    ...overrides,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("EthereumRpc", () => {
  it(
    "aborts an in-flight provider request at the operation deadline",
    { timeout: 5000 },
    async () => {
      expect.hasAssertions();
      vi.useFakeTimers();
      let aborted = false;
      vi.stubGlobal(
        "fetch",
        vi.fn(
          (_url: string, init: RequestInit) =>
            new Promise<Response>((_resolve, reject) => {
              init.signal?.addEventListener("abort", () => {
                aborted = true;
                reject(new DOMException("aborted", "AbortError"));
              });
            }),
        ),
      );
      const result = runWithinDeadline(
        (signal) => new EthereumRpc("https://example.test", namespace(), 0).chainId(signal),
        25,
      );
      const rejected = expect(result).rejects.toThrow("tick deadline exceeded");
      await vi.advanceTimersByTimeAsync(25);
      await rejected;
      expect(aborted).toBe(true);
      vi.useRealTimers();
    },
  );
  it(
    "fails closed for a malformed relevant event but ignores unrelated topics",
    { timeout: 5000 },
    async () => {
      expect.hasAssertions();
      const relevant = rpcLog({ data: "0x12" });
      const unrelated = rpcLog({ topics: [keccak256(toHex("unrelated"))], data: "0x" });
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => response([unrelated, relevant])),
      );
      await expect(
        new EthereumRpc("https://user:secret@example.test/rpc", namespace(), 0).logs(1, 1),
      ).rejects.toThrow("malformed relevant log");
    },
  );

  it(
    "rejects out-of-range, wrong-address, wrong-hash and unsafe numeric logs",
    { timeout: 5000 },
    async () => {
      expect.hasAssertions();
      for (const bad of [
        rpcLog({ address: "0x00000000000000000000000000000000000000a2" }),
        rpcLog({ blockNumber: "0x2" }),
        rpcLog({ logIndex: "0x20000000000000" }),
      ]) {
        vi.stubGlobal(
          "fetch",
          vi.fn(async () => response([bad])),
        );
        await expect(
          new EthereumRpc("https://example.test", namespace(), 0).logs(1, 1),
        ).rejects.toThrow();
        vi.unstubAllGlobals();
      }
    },
  );

  it(
    "uses full-block transactions and every receipt only when block receipts is unsupported",
    { timeout: 5000 },
    async () => {
      expect.hasAssertions();
      const indirect = rpcLog();
      const calls: string[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (_url: string, init: RequestInit) => {
          const request = JSON.parse(String(init.body));
          calls.push(request.method);
          if (request.method === "eth_getBlockReceipts")
            return new Response(
              JSON.stringify({ error: { code: -32601, message: "method not found" } }),
            );
          if (request.method === "eth_getBlockByNumber")
            return response({ number: "0x1", hash: blockHash, parentHash, transactions: [txHash] });
          if (request.method === "eth_getTransactionReceipt")
            return response({
              transactionHash: txHash,
              blockNumber: "0x1",
              blockHash,
              logs: [indirect],
            });
          throw new Error(`unexpected ${request.method}`);
        }),
      );
      await expect(
        new EthereumRpc("https://example.test", namespace(), 0).receiptLogs({
          number: 1,
          hash: blockHash,
          parentHash,
        }),
      ).resolves.toHaveLength(1);
      expect(calls).toEqual([
        "eth_getBlockByNumber",
        "eth_getBlockReceipts",
        "eth_getTransactionReceipt",
      ]);
    },
  );

  it(
    "does not fall back for a non-unsupported block receipts error",
    { timeout: 5000 },
    async () => {
      expect.hasAssertions();
      vi.stubGlobal(
        "fetch",
        vi.fn(async (_url: string, init: RequestInit) => {
          const request = JSON.parse(String(init.body));
          if (request.method === "eth_getBlockByNumber")
            return response({ number: "0x1", hash: blockHash, parentHash, transactions: [] });
          return new Response(JSON.stringify({ error: { code: -32000, message: "busy" } }));
        }),
      );
      await expect(
        new EthereumRpc("https://example.test", namespace(), 0).receiptLogs({
          number: 1,
          hash: blockHash,
          parentHash,
        }),
      ).rejects.toThrow("rpc eth_getBlockReceipts failed");
    },
  );

  it(
    "ignores non-pool receipt logs while retaining callback pool logs",
    { timeout: 5000 },
    async () => {
      expect.hasAssertions();
      const other = rpcLog({ address: "0x00000000000000000000000000000000000000a2" });
      vi.stubGlobal(
        "fetch",
        vi.fn(async (_url: string, init: RequestInit) => {
          const request = JSON.parse(String(init.body));
          if (request.method === "eth_getBlockByNumber")
            return response({ number: "0x1", hash: blockHash, parentHash, transactions: [txHash] });
          if (request.method === "eth_getBlockReceipts")
            return response([
              { transactionHash: txHash, blockNumber: "0x1", blockHash, logs: [other, rpcLog()] },
            ]);
          throw new Error(`unexpected ${request.method}`);
        }),
      );
      await expect(
        new EthereumRpc("https://example.test", namespace(), 0).receiptLogs({
          number: 1,
          hash: blockHash,
          parentHash,
        }),
      ).resolves.toHaveLength(1);
    },
  );

  it(
    "rejects a chunked response after the byte bound without consuming the whole body",
    { timeout: 5000 },
    async () => {
      expect.hasAssertions();
      let pulls = 0;
      let cancelled = false;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          pulls += 1;
          controller.enqueue(new Uint8Array(600_000));
        },
        cancel() {
          cancelled = true;
        },
      });
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(stream)),
      );
      await expect(
        new EthereumRpc("https://example.test", namespace(), 0).logs(1, 1),
      ).rejects.toThrow("rpc eth_getLogs failed");
      expect(pulls).toBeLessThan(10);
      expect(cancelled).toBe(true);
    },
  );
});

class FakeRpc implements RpcSource {
  constructor(
    readonly label: string,
    readonly fail = false,
    readonly chain = "11155111",
  ) {}
  private run<T>(value: T): Promise<T> {
    if (this.fail)
      throw new Error(
        `${this.label} https://host/v2/path-secret?querysecret invalid API key: raw-secret`,
      );
    return Promise.resolve(value);
  }
  chainId() {
    return this.run(this.chain);
  }
  finalizedHead() {
    return this.run({ number: 1, hash: blockHash });
  }
  latestHead() {
    return this.run({ number: 1, hash: blockHash, parentHash });
  }
  block(number: number) {
    return this.run({ number, hash: blockHash, parentHash });
  }
  logs() {
    return this.run([]);
  }
  receiptLogs() {
    return this.run([]);
  }
  drawSnapshot() {
    return this.run({
      rootHash: zero,
      rootSum: zero,
      ticket: zero,
      upperBound: "1",
      closeBlock: 1,
    });
  }
  membershipRoot() {
    return this.run({ hash: zero, sum: zero });
  }
}

describe("FallbackRpc", () => {
  it(
    "does not start the fallback source after the operation has been aborted",
    { timeout: 5000 },
    async () => {
      expect.hasAssertions();
      vi.useFakeTimers();
      const calls: string[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn((_url: string, init: RequestInit) => {
          const method = JSON.parse(String(init.body)).method;
          calls.push(method);
          return new Promise<Response>((_resolve, reject) =>
            init.signal?.addEventListener("abort", () =>
              reject(new DOMException("aborted", "AbortError")),
            ),
          );
        }),
      );
      const rpc = new FallbackRpc(
        new EthereumRpc("https://primary.test", namespace(), 0),
        new EthereumRpc("https://historical.test", namespace(), 0),
        namespace(),
      );
      const result = runWithinDeadline(
        (signal) => rpc.withSource((source) => source.block(1, signal), signal),
        25,
      );
      const rejected = expect(result).rejects.toThrow("tick deadline exceeded");
      await vi.advanceTimersByTimeAsync(25);
      await rejected;
      expect(calls).toEqual(["eth_chainId"]);
      vi.useRealTimers();
    },
  );
  it(
    "pins one validated source for an ingestion operation and redacts both provider causes",
    { timeout: 5000 },
    async () => {
      expect.hasAssertions();
      const rpc = new FallbackRpc(
        new FakeRpc("primary", true),
        new FakeRpc("fallback", true),
        namespace(),
      );
      await expect(rpc.withSource((source) => source.block(1))).rejects.toThrow("primary");
      await expect(rpc.withSource((source) => source.block(1))).rejects.toThrow("fallback");
      await expect(rpc.withSource((source) => source.block(1))).rejects.not.toThrow(
        /path-secret|querysecret|raw-secret/,
      );
    },
  );

  it(
    "rejects a fallback source on the wrong chain before using it",
    { timeout: 5000 },
    async () => {
      expect.hasAssertions();
      const rpc = new FallbackRpc(
        new FakeRpc("primary", true),
        new FakeRpc("fallback", false, "1"),
        namespace(),
      );
      await expect(rpc.withSource((source) => source.block(1))).rejects.toThrow(
        "chain id mismatch",
      );
    },
  );
});
