import { env as workerEnv } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { D1Archive, type BlockHeader, type Checkpoint } from "../src/archive.ts";
import { ingestOneSlice, type RpcSource } from "../src/ingest.ts";
import { branchHash, leafHash, type ArchiveLog, type Namespace } from "../src/domain.ts";
import { FallbackRpc } from "../src/rpc.ts";
import { drainScheduledSlices, initializeArchiveForTick } from "../src/worker.ts";

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
function retainedHeaders(last = 130) {
  return Array.from({ length: last }, (_, offset) => {
    const number = offset + 1;
    return header(
      number,
      (number % 16).toString(16),
      offset ? `0x${(offset % 16).toString(16).repeat(64)}` : zero,
    );
  });
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
  async drawSnapshot(): ReturnType<RpcSource["drawSnapshot"]> {
    throw new Error("unused");
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
  it("repairs a legacy interrupted scheduler initialization through its scheduler path", async () => {
    expect.hasAssertions();
    const n = namespace();
    const parent = header(0, "a");
    const archive = new D1Archive(env.PROOF_DB);
    // Exact old interruption shape: namespace and state existed, but no parent anchor.
    await env.PROOF_DB
      .prepare("INSERT INTO namespaces VALUES(?,?,?,?,?,?)")
      .bind(n.chainId, n.pool, n.depth, n.zero, JSON.stringify(n.emptyHashes), n.deploymentBlock)
      .run();
    await env.PROOF_DB
      .prepare("INSERT INTO ingestion_state VALUES(?,?,?,?,?,?,?,?)")
      .bind(n.chainId, n.pool, n.deploymentBlock, 0, parent.hash, 0, null, new Date().toISOString())
      .run();

    await initializeArchiveForTick(archive, n, new FixtureRpc([parent], [], n));

    expect(await archive.canonicalBlock(n, 0)).toEqual(parent);
    expect(await archive.status(n)).toMatchObject({ nextBlock: 1, lastFinalizedHash: parent.hash });
  });
  it(
    "drains five finalized empty blocks per scheduled minute without exceeding three two-block slices",
    { timeout: 5000 },
    async () => {
      expect.hasAssertions();
      const n = namespace(),
        archive = new D1Archive(env.PROOF_DB),
        h1 = header(1, "1"),
        h2 = header(2, "2", h1.hash),
        h3 = header(3, "3", h2.hash),
        h4 = header(4, "4", h3.hash),
        h5 = header(5, "5", h4.hash),
        h6 = header(6, "6", h5.hash),
        h7 = header(7, "7", h6.hash),
        h8 = header(8, "8", h7.hash),
        h9 = header(9, "9", h8.hash),
        h10 = header(10, "a", h9.hash),
        ranges: Array<[number, number]> = [];
      class RangeFixtureRpc extends FixtureRpc {
        override async logs(from: number, to: number) {
          ranges.push([from, to]);
          return super.logs(from, to);
        }
      }
      const rpc = new RangeFixtureRpc([h1, h2, h3, h4, h5], [], n);
      await archive.initialize(n);

      await drainScheduledSlices(archive, n, rpc, 2);
      rpc.blocks.push(h6, h7, h8, h9, h10);
      const state = await drainScheduledSlices(archive, n, rpc, 2);

      expect(state).toMatchObject({ nextBlock: 11, lastFinalizedBlock: 10 });
      expect(ranges).toEqual([
        [1, 2],
        [3, 4],
        [5, 5],
        [6, 7],
        [8, 9],
        [10, 10],
      ]);
      expect(ranges.every(([from, to]) => to - from + 1 <= 2)).toBe(true);
    },
  );

  it(
    "stops after one slice when the archive is already caught up or disabled",
    { timeout: 5000 },
    async () => {
      expect.hasAssertions();
      const n = namespace(),
        archive = new D1Archive(env.PROOF_DB),
        h1 = header(1, "1"),
        rpc = new FixtureRpc([h1], [], n);
      let chainIdCalls = 0;
      rpc.chainId = async () => {
        chainIdCalls += 1;
        return n.chainId;
      };
      await archive.initialize(n);
      await archive.ingest(n, await archive.status(n), [], [h1]);

      const caughtUp = await drainScheduledSlices(archive, n, rpc, 2);
      await archive.disable(n, caughtUp, "operator disabled");
      const disabled = await drainScheduledSlices(archive, n, rpc, 2);

      expect(caughtUp).toMatchObject({ nextBlock: 2, lastFinalizedBlock: 1 });
      expect(disabled).toMatchObject({ nextBlock: 2, disabledReason: "operator disabled" });
      expect(chainIdCalls).toBe(1);
    },
  );

  it("stops after a rollback instead of starting a later slice", { timeout: 5000 }, async () => {
    expect.hasAssertions();
    const n = namespace(),
      archive = new D1Archive(env.PROOF_DB),
      h1 = header(1, "1"),
      orphan2 = header(2, "2", h1.hash),
      orphan3 = header(3, "3", orphan2.hash),
      canonical2 = header(2, "a", h1.hash),
      canonical3 = header(3, "b", canonical2.hash),
      ranges: Array<[number, number]> = [];
    class RangeFixtureRpc extends FixtureRpc {
      override async logs(from: number, to: number) {
        ranges.push([from, to]);
        return super.logs(from, to);
      }
    }
    await archive.initialize(n);
    await archive.ingest(n, await archive.status(n), [], [h1, orphan2, orphan3]);

    const state = await drainScheduledSlices(
      archive,
      n,
      new RangeFixtureRpc([h1, canonical2, canonical3], [], n),
      2,
    );

    expect(state).toMatchObject({
      nextBlock: 2,
      lastFinalizedBlock: 1,
      lastFinalizedHash: h1.hash,
    });
    expect(ranges).toEqual([]);
  });

  it(
    "does not begin a later slice after an in-flight atomic settlement aborts the tick",
    { timeout: 5000 },
    async () => {
      expect.hasAssertions();
      const n = namespace(),
        archive = new D1Archive(env.PROOF_DB),
        h1 = header(1, "1"),
        h2 = header(2, "2", h1.hash),
        h3 = header(3, "3", h2.hash),
        ranges: Array<[number, number]> = [],
        controller = new AbortController();
      class RangeFixtureRpc extends FixtureRpc {
        override async logs(from: number, to: number) {
          ranges.push([from, to]);
          return super.logs(from, to);
        }
      }
      await archive.initialize(n);
      const abortingArchive = archive as unknown as {
        ingest(
          namespace: Namespace,
          expected: Checkpoint,
          logs: readonly ArchiveLog[],
          headers: readonly BlockHeader[],
        ): Promise<Checkpoint>;
      };
      const ingest = abortingArchive.ingest.bind(archive);
      abortingArchive.ingest = async (namespace, expected, logs, headers) => {
        const state = await ingest(namespace, expected, logs, headers);
        controller.abort(new Error("tick deadline exceeded"));
        return state;
      };

      await expect(
        drainScheduledSlices(
          archive,
          n,
          new RangeFixtureRpc([h1, h2, h3], [], n),
          2,
          controller.signal,
        ),
      ).rejects.toThrow("tick deadline exceeded");
      expect(await archive.status(n)).toMatchObject({ nextBlock: 3, lastFinalizedBlock: 2 });
      expect(ranges).toEqual([[1, 2]]);
    },
  );

  it(
    "persists the real deployment-parent anchor for the first canonical header",
    { timeout: 5000 },
    async () => {
      expect.hasAssertions();
      const n = namespace(),
        archive = new D1Archive(env.PROOF_DB);
      const anchor = `0x${"9".repeat(64)}`;
      await archive.initialize(n, anchor);
      const first = header(1, "1", anchor);
      const state = await ingestOneSlice(archive, n, new FixtureRpc([first], [], n), 2);
      expect(state.lastFinalizedHash).toBe(first.hash);
      expect((await archive.canonicalBlock(n, 0))?.hash).toBe(anchor);
    },
  );

  it(
    "checks the saved checkpoint before returning when the head has not advanced",
    { timeout: 5000 },
    async () => {
      expect.hasAssertions();
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
    },
  );

  it(
    "rejects an older matching provider head without deleting retained proof and draw history",
    { timeout: 5000 },
    async () => {
      expect.hasAssertions();
      const n = namespace(),
        archive = new D1Archive(env.PROOF_DB),
        headers = retainedHeaders(),
        account = "0x00000000000000000000000000000000000000a1",
        h2 = headers[1],
        leaf = leafHash(account, "1", zero),
        root = branchHash({ hash: leaf, sum: zero }, { hash: n.emptyHashes[0], sum: zero }),
        logs: ArchiveLog[] = [
          {
            blockNumber: 2,
            blockHash: h2.hash,
            logIndex: 0,
            name: "SlotAssigned",
            args: { account, index: "0", generation: "1" },
          },
          {
            blockNumber: 2,
            blockHash: h2.hash,
            logIndex: 1,
            name: "NodeUpdated",
            args: { level: "0", index: "0", hash: leaf, sum: zero },
          },
          {
            blockNumber: 2,
            blockHash: h2.hash,
            logIndex: 2,
            name: "NodeUpdated",
            args: { level: "1", index: "0", hash: root, sum: zero },
          },
          {
            blockNumber: 2,
            blockHash: h2.hash,
            logIndex: 3,
            name: "DrawSnapshotClosed",
            args: {
              drawId: "1",
              rootHash: root,
              rootSum: zero,
              ticket: zero,
              upperBound: "1",
              closeBlockNumber: "2",
            },
          },
        ];
      await archive.initialize(n);
      await archive.ingest(n, await archive.status(n), logs, headers);

      await expect(
        ingestOneSlice(archive, n, new FixtureRpc([headers[0]], logs, n), 2),
      ).rejects.toThrow("finalized head behind retained checkpoint");
      expect(await archive.status(n)).toMatchObject({
        nextBlock: 131,
        lastFinalizedBlock: 130,
        lastFinalizedHash: headers[129].hash,
        disabledReason: undefined,
      });
      expect((await archive.canonicalBlock(n, 130))?.hash).toBe(headers[129].hash);
      expect(await archive.proof(n, "1", account)).toMatchObject({
        drawId: "1",
        closeBlockNumber: 2,
      });
      expect(await archive.drawById(n, "1")).toMatchObject({ blockHash: h2.hash });
    },
  );

  it(
    "fails over from an older provider head and advances from the retained checkpoint",
    { timeout: 5000 },
    async () => {
      expect.hasAssertions();
      const n = namespace(),
        archive = new D1Archive(env.PROOF_DB),
        retained = retainedHeaders(),
        h131 = header(131, "3", retained[129].hash),
        h132 = header(132, "4", h131.hash);
      await archive.initialize(n);
      await archive.ingest(n, await archive.status(n), [], retained);

      const state = await new FallbackRpc(
        new FixtureRpc([retained[0]], [], n),
        new FixtureRpc([...retained, h131, h132], [], n),
        n,
      ).withSource((source) => ingestOneSlice(archive, n, source, 2));

      expect(state).toMatchObject({
        nextBlock: 133,
        lastFinalizedBlock: 132,
        lastFinalizedHash: h132.hash,
      });
      expect((await archive.canonicalBlock(n, 130))?.hash).toBe(retained[129].hash);
    },
  );

  it(
    "keeps retained state unchanged when both providers report older finalized heads",
    { timeout: 5000 },
    async () => {
      expect.hasAssertions();
      const n = namespace(),
        archive = new D1Archive(env.PROOF_DB),
        retained = retainedHeaders();
      await archive.initialize(n);
      await archive.ingest(n, await archive.status(n), [], retained);

      await expect(
        new FallbackRpc(
          new FixtureRpc([retained[0]], [], n),
          new FixtureRpc([retained[0]], [], n),
          n,
        ).withSource((source) => ingestOneSlice(archive, n, source, 2)),
      ).rejects.toThrow("rpc sources failed");
      expect(await archive.status(n)).toMatchObject({
        nextBlock: 131,
        lastFinalizedBlock: 130,
        lastFinalizedHash: retained[129].hash,
        disabledReason: undefined,
      });
      expect((await archive.canonicalBlock(n, 130))?.hash).toBe(retained[129].hash);
    },
  );

  it(
    "waits for the first eligible block when an unindexed deployment parent is above the finalized cutoff",
    { timeout: 5000 },
    async () => {
      expect.hasAssertions();
      const n = namespace(),
        archive = new D1Archive(env.PROOF_DB),
        parent = header(0, "f");
      await archive.initialize(n, parent.hash);

      const state = await ingestOneSlice(archive, n, new FixtureRpc([parent], [], n), 2);

      expect(state).toMatchObject({
        nextBlock: 1,
        lastFinalizedBlock: 0,
        lastFinalizedHash: parent.hash,
        disabledReason: undefined,
      });
    },
  );

  it(
    "finds a multi-block common ancestor and atomically rolls back the orphaned suffix",
    { timeout: 5000 },
    async () => {
      expect.hasAssertions();
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
    },
  );

  it("keeps empty blocks in a complete bounded backfill", { timeout: 5000 }, async () => {
    expect.hasAssertions();
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

  it(
    "fails closed when the end-of-slice membership root proves an omitted transaction",
    { timeout: 5000 },
    async () => {
      expect.hasAssertions();
      const n = namespace(),
        archive = new D1Archive(env.PROOF_DB);
      await archive.initialize(n);
      const h1 = header(1, "1");
      const rpc = new FixtureRpc([h1], [], n, { hash: `0x${"4".repeat(64)}`, sum: zero });
      await expect(ingestOneSlice(archive, n, rpc, 2)).rejects.toThrow(
        "onchain membership root mismatch",
      );
      expect((await archive.status(n)).nextBlock).toBe(1);
    },
  );

  it(
    "does not mutate the archive when an operation is cancelled before ingestion",
    { timeout: 5000 },
    async () => {
      expect.hasAssertions();
      const n = namespace(),
        archive = new D1Archive(env.PROOF_DB),
        controller = new AbortController();
      await archive.initialize(n);
      controller.abort(new Error("tick deadline exceeded"));
      await expect(
        ingestOneSlice(archive, n, new FixtureRpc([header(1, "1")], [], n), 2, controller.signal),
      ).rejects.toThrow("tick deadline exceeded");
      expect(await archive.status(n)).toMatchObject({ nextBlock: 1, lastFinalizedBlock: 0 });
    },
  );

  it(
    "rejects conflicting duplicate receipt logs before archive mutation",
    { timeout: 5000 },
    async () => {
      expect.hasAssertions();
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
        ingestOneSlice(
          archive,
          n,
          new FixtureRpc([h1], [event], n, undefined, [event, conflict]),
          2,
        ),
      ).rejects.toThrow("conflicting receipt log payload");
      expect((await archive.status(n)).nextBlock).toBe(1);
    },
  );
});
