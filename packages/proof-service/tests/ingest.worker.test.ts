import { env as workerEnv } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { D1Archive } from "../src/archive.ts";
import { ingestOneSlice } from "../src/ingest.ts";
import { type ArchiveLog } from "../src/domain.ts";
import { drainScheduledSlices, initializeArchiveForTick } from "../src/worker.ts";
import {
  abortAfterFirstIngest,
  FixtureRpc,
  header,
  namespace,
  zero,
} from "./ingest.worker.fixture.ts";

const env = workerEnv as unknown as { PROOF_DB: D1Database };

describe("finalized RPC ingestion", () => {
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
        ranges: Array<[number, number]> = [];
      class RangeFixtureRpc extends FixtureRpc {
        override async logs(from: number, to: number) {
          ranges.push([from, to]);
          return super.logs(from, to);
        }
      }
      await archive.initialize(n);
      const controller = abortAfterFirstIngest(archive);

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
