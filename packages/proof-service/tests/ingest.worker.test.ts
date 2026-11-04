import { env as workerEnv } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { D1Archive, type BlockHeader } from "../src/archive.ts";
import { ingestOneSlice, type RpcSource } from "../src/ingest.ts";
import { branchHash, leafHash, type ArchiveLog, type Namespace } from "../src/domain.ts";

const zero = `0x${"00".repeat(32)}`;
const env = workerEnv as unknown as { PROOF_DB: D1Database };
let serial = 100;

function namespace(): Namespace {
  serial += 1;
  const leaf = leafHash("0x0000000000000000000000000000000000000000", "0", zero);
  return {
    chainId: "11155111",
    pool: `0x${serial.toString().padStart(40, "3")}`,
    depth: 1,
    zero,
    emptyHashes: [leaf, branchHash({ hash: leaf, sum: zero }, { hash: leaf, sum: zero })],
    deploymentBlock: 1,
  };
}
function header(number: number, nibble: string, parentHash = zero): BlockHeader {
  return { number, hash: `0x${nibble.repeat(64)}`, parentHash };
}
class FixtureRpc implements RpcSource {
  constructor(
    readonly blocks: BlockHeader[],
    readonly allLogs: ArchiveLog[] = [],
    readonly n?: Namespace,
    readonly root?: { hash: string; sum: string },
    readonly receipts?: ArchiveLog[],
  ) {}
  async chainId() {
    return "11155111";
  }
  async finalizedHead() {
    const x = this.blocks.at(-1)!;
    return { number: x.number, hash: x.hash };
  }
  async latestHead() {
    return this.blocks.at(-1)!;
  }
  async block(number: number) {
    const x = this.blocks.find((b) => b.number === number);
    if (!x) throw new Error("missing block");
    return x;
  }
  async logs(from: number, to: number) {
    return this.allLogs.filter((x) => x.blockNumber >= from && x.blockNumber <= to);
  }
  async receiptLogs(block: BlockHeader) {
    return (this.receipts ?? this.allLogs).filter((x) => x.blockNumber === block.number);
  }
  async drawSnapshot() {
    throw new Error("unused");
    return { rootHash: zero, rootSum: zero, ticket: zero, upperBound: "0", closeBlock: 0 };
  }
  async membershipRoot() {
    if (this.root) return this.root;
    const root = [...this.allLogs]
      .reverse()
      .find((log) => log.name === "NodeUpdated" && log.args.level === String(this.n?.depth));
    return root
      ? { hash: root.args.hash, sum: root.args.sum }
      : { hash: this.n?.emptyHashes[this.n.depth] ?? zero, sum: zero };
  }
}

describe("finalized RPC ingestion", () => {
  it("persists the real deployment-parent anchor for the first canonical header", async () => {
    const n = namespace(),
      archive = new D1Archive(env.PROOF_DB);
    const anchor = `0x${"9".repeat(64)}`;
    await archive.initialize(n, anchor);
    const first = header(1, "1", anchor);
    const state = await ingestOneSlice(archive, n, new FixtureRpc([first], [], n), 2);
    expect(state.lastFinalizedHash).toBe(first.hash);
    expect((await archive.canonicalBlock(n, 0))?.hash).toBe(anchor);
  });

  it("checks the saved checkpoint before returning when the head has not advanced", async () => {
    const n = namespace(),
      archive = new D1Archive(env.PROOF_DB);
    await archive.initialize(n);
    const h1 = header(1, "1"),
      h2 = header(2, "2", h1.hash),
      h3 = header(3, "3", h2.hash);
    await archive.ingest(n, await archive.status(n), [], [h1, h2, h3]);
    const replacement2 = header(2, "a", h1.hash),
      replacement3 = header(3, "b", replacement2.hash);
    const state = await ingestOneSlice(
      archive,
      n,
      new FixtureRpc([h1, replacement2, replacement3], [], n),
      2,
    );
    expect(state).toMatchObject({
      nextBlock: 2,
      lastFinalizedBlock: 1,
      lastFinalizedHash: h1.hash,
    });
  });

  it("finds a multi-block common ancestor and atomically rolls back the orphaned suffix", async () => {
    const n = namespace(),
      archive = new D1Archive(env.PROOF_DB);
    await archive.initialize(n);
    const h1 = header(1, "1"),
      h2 = header(2, "2", h1.hash),
      h3 = header(3, "3", h2.hash),
      h4 = header(4, "4", h3.hash);
    await archive.ingest(n, await archive.status(n), [], [h1, h2, h3, h4]);
    const canonical2 = header(2, "a", h1.hash),
      canonical3 = header(3, "b", canonical2.hash),
      canonical4 = header(4, "c", canonical3.hash);
    const state = await ingestOneSlice(
      archive,
      n,
      new FixtureRpc([h1, canonical2, canonical3, canonical4], [], n),
      2,
    );
    expect(state).toMatchObject({
      nextBlock: 2,
      lastFinalizedBlock: 1,
      lastFinalizedHash: h1.hash,
    });
    expect(await archive.canonicalBlock(n, 2)).toBeNull();
  });

  it("keeps empty blocks in a complete bounded backfill", async () => {
    const n = namespace(),
      archive = new D1Archive(env.PROOF_DB);
    await archive.initialize(n);
    const h1 = header(1, "1"),
      h2 = header(2, "2", h1.hash),
      h3 = header(3, "3", h2.hash);
    const rpc = new FixtureRpc([h1, h2, h3], [], n);
    await ingestOneSlice(archive, n, rpc, 2);
    const state = await ingestOneSlice(archive, n, rpc, 2);
    expect(state).toMatchObject({
      nextBlock: 4,
      lastFinalizedBlock: 3,
      lastFinalizedHash: h3.hash,
    });
    expect((await archive.canonicalBlock(n, 2))?.hash).toBe(h2.hash);
  });

  it("fails closed when the end-of-slice membership root proves an omitted transaction", async () => {
    const n = namespace(),
      archive = new D1Archive(env.PROOF_DB);
    await archive.initialize(n);
    const h1 = header(1, "1");
    const rpc = new FixtureRpc([h1], [], n, { hash: `0x${"4".repeat(64)}`, sum: zero });
    await expect(ingestOneSlice(archive, n, rpc, 2)).rejects.toThrow(
      "onchain membership root mismatch",
    );
    expect((await archive.status(n)).nextBlock).toBe(1);
  });

  it("rejects conflicting duplicate receipt logs before archive mutation", async () => {
    const n = namespace(),
      archive = new D1Archive(env.PROOF_DB);
    await archive.initialize(n);
    const h1 = header(1, "1");
    const event: ArchiveLog = {
      blockNumber: 1,
      blockHash: h1.hash,
      logIndex: 0,
      name: "NodeUpdated",
      args: { level: "1", index: "0", hash: n.emptyHashes[1], sum: zero },
    };
    const conflict = { ...event, args: { ...event.args, sum: `0x${"5".repeat(64)}` } };
    await expect(
      ingestOneSlice(archive, n, new FixtureRpc([h1], [event], n, undefined, [event, conflict]), 2),
    ).rejects.toThrow("conflicting receipt log payload");
    expect((await archive.status(n)).nextBlock).toBe(1);
  });
});
