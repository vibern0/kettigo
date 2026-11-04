import { env as workerEnv } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { D1Archive, type BlockHeader } from "../src/archive.ts";
import { branchHash, leafHash, type ArchiveLog, type Namespace } from "../src/domain.ts";

const zero = `0x${"00".repeat(32)}`;
const account = "0x1111111111111111111111111111111111111111";
const env = workerEnv as unknown as { PROOF_DB: D1Database };
let serial = 0;

function ns(depth = 1): Namespace {
  serial += 1;
  const empty = [leafHash("0x0000000000000000000000000000000000000000", "0", zero)];
  for (let i = 0; i < depth; i += 1)
    empty.push(branchHash({ hash: empty[i], sum: zero }, { hash: empty[i], sum: zero }));
  return {
    chainId: "11155111",
    pool: `0x${serial.toString(16).padStart(40, "2")}`,
    depth,
    zero,
    emptyHashes: empty,
    deploymentBlock: 1,
  };
}

function header(number = 1, hash = `0x${"11".repeat(32)}`): BlockHeader {
  return { number, hash, parentHash: zero };
}

function fixture(depth = 32): { n: Namespace; logs: ArchiveLog[]; root: string } {
  const n = ns(depth);
  const logs: ArchiveLog[] = [
    {
      blockNumber: 1,
      blockHash: header().hash,
      logIndex: 0,
      name: "SlotAssigned",
      args: { account, index: "0", generation: "1" },
    },
  ];
  let node = { hash: leafHash(account, "1", zero), sum: zero };
  logs.push({
    blockNumber: 1,
    blockHash: header().hash,
    logIndex: 1,
    name: "NodeUpdated",
    args: { level: "0", index: "0", hash: node.hash, sum: zero },
  });
  for (let level = 0; level < depth; level += 1) {
    node = { hash: branchHash(node, { hash: n.emptyHashes[level], sum: zero }), sum: zero };
    logs.push({
      blockNumber: 1,
      blockHash: header().hash,
      logIndex: level + 2,
      name: "NodeUpdated",
      args: { level: String(level + 1), index: "0", hash: node.hash, sum: zero },
    });
  }
  logs.push({
    blockNumber: 1,
    blockHash: header().hash,
    logIndex: depth + 2,
    name: "DrawSnapshotClosed",
    args: {
      drawId: "1",
      rootHash: node.hash,
      rootSum: zero,
      ticket: zero,
      upperBound: "1",
      closeBlockNumber: "1",
    },
  });
  return { n, logs, root: node.hash };
}

describe("D1 proof archive", () => {
  it("rejects immutable namespace differences", async () => {
    const a = new D1Archive(env.PROOF_DB);
    const n = ns();
    await a.initialize(n);
    await expect(a.initialize({ ...n, deploymentBlock: 2 })).rejects.toThrow("namespace mismatch");
    await expect(a.assertNamespace({ ...n, deploymentBlock: 2 })).rejects.toThrow(
      "namespace mismatch",
    );
  });
  it("builds and verifies a genuine depth-32 historical proof in D1", async () => {
    const a = new D1Archive(env.PROOF_DB);
    const { n, logs, root } = fixture();
    await a.initialize(n);
    await a.ingest(n, await a.status(n), [...logs].reverse(), [header()]);
    const proof = await a.proof(n, "1", account);
    expect(proof?.rootHash).toBe(root);
    expect(proof?.siblingHashes).toHaveLength(32);
    expect(proof?.generation).toBe("1");
  });
  it("rejects a closed draw whose assigned range cannot contain its slot", async () => {
    const a = new D1Archive(env.PROOF_DB);
    const { n, logs } = fixture(1);
    logs.at(-1)!.args.upperBound = "0";
    await a.initialize(n);
    await expect(a.ingest(n, await a.status(n), logs, [header()])).rejects.toThrow(
      "invalid draw upper bound",
    );
  });
  it("deduplicates exact logs and rejects conflicting payloads before writes", async () => {
    const a = new D1Archive(env.PROOF_DB);
    const { n, logs } = fixture(1);
    await a.initialize(n);
    await a.ingest(n, await a.status(n), [logs[0], logs[0], ...logs.slice(1)], [header()]);
    const base = { ...logs[0], blockNumber: 2, logIndex: 0 };
    const h2 = { number: 2, hash: `0x${"22".repeat(32)}`, parentHash: header().hash };
    await expect(
      a.ingest(
        n,
        await a.status(n),
        [base, { ...base, args: { ...base.args, generation: "2" } }],
        [h2],
      ),
    ).rejects.toThrow("conflicting log payload");
    expect((await a.status(n)).nextBlock).toBe(2);
  });
  it("guards stale and unexpected revisions atomically", async () => {
    const a = new D1Archive(env.PROOF_DB);
    const n = ns();
    await a.initialize(n);
    const stale = await a.status(n);
    await a.ingest(n, stale, [], [header()]);
    const h2 = [{ number: 2, hash: `0x${"22".repeat(32)}`, parentHash: header().hash }];
    await expect(a.ingest(n, stale, [], [header()])).rejects.toThrow("checkpoint conflict");
    await expect(a.ingest(n, { ...(await a.status(n)), revision: 99 }, [], h2)).rejects.toThrow(
      "checkpoint conflict",
    );
    expect(await a.status(n)).toMatchObject({ nextBlock: 2, revision: 1 });
  });
  it("orders uint256 draw ids exactly", async () => {
    const a = new D1Archive(env.PROOF_DB);
    const n = ns();
    await a.initialize(n);
    const ids = [
      "1",
      "9223372036854775808",
      "115792089237316195423570985008687907853269984665640564039457584007913129639935",
    ];
    const logs = ids.map((drawId, logIndex) => ({
      blockNumber: 1,
      blockHash: header().hash,
      logIndex,
      name: "DrawSnapshotClosed" as const,
      args: {
        drawId,
        rootHash: n.emptyHashes[1],
        rootSum: zero,
        ticket: zero,
        upperBound: "1",
        closeBlockNumber: "1",
      },
    }));
    await a.ingest(n, await a.status(n), logs, [header()]);
    expect((await a.listDraws(n)).map((draw) => draw.drawId)).toEqual([...ids].reverse());
  });
  it("rolls back and restores the preceding canonical hash", async () => {
    const a = new D1Archive(env.PROOF_DB);
    const n = ns();
    await a.initialize(n);
    const h1 = header();
    const h2 = { number: 2, hash: `0x${"22".repeat(32)}`, parentHash: h1.hash };
    await a.ingest(n, await a.status(n), [], [h1, h2]);
    const after = await a.rollbackFrom(n, await a.status(n), 2);
    expect(after).toMatchObject({
      nextBlock: 2,
      lastFinalizedBlock: 1,
      lastFinalizedHash: h1.hash,
    });
  });
});
