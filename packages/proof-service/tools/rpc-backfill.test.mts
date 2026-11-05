import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { D1Archive, type BlockHeader } from "../src/archive.ts";
import { type RpcSource } from "../src/ingest.ts";
import { branchHash, leafHash, type ArchiveLog, type Namespace, type Node } from "../src/domain.ts";
import { depth32Fixture, zero } from "../tests/fixtures.ts";
import { SqliteD1, migrate } from "./replay-retained.mts";
import { runRpcBackfill } from "./rpc-backfill.mts";
import { FallbackRpc } from "../src/rpc.ts";
import { initializeArchiveForTick } from "../src/worker.ts";

const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
const headers = (target: number): BlockHeader[] =>
  Array.from({ length: target + 1 }, (_, number) => ({
    number,
    hash: hash(number + 1),
    parentHash: number === 0 ? zero : hash(number),
  }));

function logsFor(namespace: Namespace, block: BlockHeader): ArchiveLog[] {
  const account = "0x1111111111111111111111111111111111111111";
  const logs: ArchiveLog[] = [{
    blockNumber: block.number,
    blockHash: block.hash,
    logIndex: 0,
    name: "SlotAssigned",
    args: { account, index: "0", generation: "1" },
  }];
  let node: Node = { hash: leafHash(account, "1", zero), sum: zero };
  logs.push({
    blockNumber: block.number,
    blockHash: block.hash,
    logIndex: 1,
    name: "NodeUpdated",
    args: { level: "0", index: "0", hash: node.hash, sum: zero },
  });
  for (let level = 0; level < namespace.depth; level += 1) {
    node = { hash: branchHash(node, { hash: namespace.emptyHashes[level], sum: zero }), sum: zero };
    logs.push({
      blockNumber: block.number,
      blockHash: block.hash,
      logIndex: level + 2,
      name: "NodeUpdated",
      args: { level: String(level + 1), index: "0", hash: node.hash, sum: zero },
    });
  }
  return logs;
}

class FixtureRpc implements RpcSource {
  readonly calls: number[] = [];
  constructor(
    readonly chain: BlockHeader[],
    readonly logsByBlock: Map<number, ArchiveLog[]>,
    readonly namespace: Namespace,
    readonly chainIdValue = "11155111",
    readonly finalized = chain.at(-1)!,
  ) {}
  async chainId() { return this.chainIdValue; }
  async finalizedHead() { return { number: this.finalized.number, hash: this.finalized.hash }; }
  async latestHead() { return this.chain.at(-1)!; }
  async block(number: number) { this.calls.push(number); return this.chain[number]!; }
  async logs(from: number, to: number) {
    return Array.from({ length: to - from + 1 }, (_, i) => this.logsByBlock.get(from + i) ?? []).flat();
  }
  async receiptLogs(block: BlockHeader) { return this.logsByBlock.get(block.number) ?? []; }
  async drawSnapshot() { throw new Error("unexpected draw snapshot"); }
  async membershipRoot(block: BlockHeader) {
    const updates = [...this.logsByBlock.entries()]
      .filter(([number]) => number <= block.number)
      .flatMap(([, logs]) => logs)
      .filter((log) => log.name === "NodeUpdated" && log.args.level === String(this.namespace.depth));
    const update = updates.at(-1);
    return update ? { hash: update.args.hash, sum: update.args.sum } : { hash: this.namespace.emptyHashes[this.namespace.depth], sum: zero };
  }
}

function namespaceAtTwo() {
  const fixture = depth32Fixture();
  return { ...fixture.namespace, deploymentBlock: 2 };
}

test("backfill builds an absent SQLite archive through the exact fixed target", async () => {
  const directory = mkdtempSync("/tmp/kettigo-rpc-backfill-");
  const namespace = namespaceAtTwo();
  const chain = headers(5);
  const rpc = new FixtureRpc(chain, new Map([[2, logsFor(namespace, chain[2])]]), namespace);
  const output = join(directory, "backfill.sqlite");

  const result = await runRpcBackfill({
    namespace,
    target: { chainId: "11155111", number: 4, hash: chain[4].hash },
    output,
    source: rpc,
    maxBlocksPerSlice: 2,
    maxSlices: 4,
    deadlineMs: 1_000,
  });

  assert.equal(result.checkpoint.lastFinalizedBlock, 4);
  assert.equal(result.checkpoint.lastFinalizedHash, chain[4].hash);
  assert.equal(existsSync(output), true);
  assert.equal(rpc.calls.includes(5), false);
  const db = new DatabaseSync(output, { readOnly: true });
  const archive = new D1Archive(new SqliteD1(db));
  assert.equal((await archive.status(namespace)).nextBlock, 5);
  db.close();
});

test("backfill never publishes a partial archive on a fixed-target reorg or no progress", async (t) => {
  const directory = mkdtempSync("/tmp/kettigo-rpc-backfill-fail-");
  const namespace = namespaceAtTwo();
  const chain = headers(4);
  await t.test("reorg", async () => {
    const rpc = new FixtureRpc(chain, new Map(), namespace);
    let calls = 0;
    const original = rpc.block.bind(rpc);
    rpc.block = async (number) => {
      calls += 1;
      const block = await original(number);
      return number === 4 && calls > 2 ? { ...block, hash: hash(99) } : block;
    };
    const output = join(directory, "reorg.sqlite");
    await assert.rejects(
      () => runRpcBackfill({ namespace, target: { chainId: "11155111", number: 4, hash: chain[4].hash }, output, source: rpc, maxBlocksPerSlice: 2, maxSlices: 4, deadlineMs: 1_000 }),
      /target canonicality changed/,
    );
    assert.equal(existsSync(output), false);
  });
  await t.test("no progress", async () => {
    const rpc = new FixtureRpc(chain, new Map(), namespace, "11155111", chain[1]);
    const output = join(directory, "lagging.sqlite");
    await assert.rejects(
      () => runRpcBackfill({ namespace, target: { chainId: "11155111", number: 4, hash: chain[4].hash }, output, source: rpc, maxBlocksPerSlice: 2, maxSlices: 4, deadlineMs: 1_000 }),
      /target is not confirmed/,
    );
    assert.equal(existsSync(output), false);
  });
});

test("backfill rejects an existing output without changing it", async () => {
  const directory = mkdtempSync("/tmp/kettigo-rpc-backfill-existing-");
  const output = join(directory, "existing.sqlite");
  await import("node:fs/promises").then(({ writeFile }) => writeFile(output, "leave-me"));
  const namespace = namespaceAtTwo();
  const chain = headers(4);
  await assert.rejects(
    () => runRpcBackfill({ namespace, target: { chainId: "11155111", number: 4, hash: chain[4].hash }, output, source: new FixtureRpc(chain, new Map(), namespace), maxBlocksPerSlice: 2, maxSlices: 4, deadlineMs: 1_000 }),
    /output already exists/,
  );
  assert.equal(readFileSync(output, "utf8"), "leave-me");
});

test("native SQLite restart repairs the only legacy scheduler interruption shape", async () => {
  const directory = mkdtempSync("/tmp/kettigo-rpc-backfill-init-");
  const namespace = namespaceAtTwo();
  const chain = headers(2);
  const db = migrate(join(directory, "interrupted.sqlite"));
  // Simulate the old crash after state insertion but before canonical_blocks insertion.
  db.prepare("INSERT INTO namespaces VALUES(?,?,?,?,?,?)").run(
    namespace.chainId,
    namespace.pool,
    namespace.depth,
    namespace.zero,
    JSON.stringify(namespace.emptyHashes),
    namespace.deploymentBlock,
  );
  db.prepare("INSERT INTO ingestion_state VALUES(?,?,?,?,?,?,?,?)").run(
    namespace.chainId,
    namespace.pool,
    namespace.deploymentBlock,
    namespace.deploymentBlock - 1,
    chain[1].hash,
    0,
    null,
    new Date().toISOString(),
  );
  const archive = new D1Archive(new SqliteD1(db));
  await initializeArchiveForTick(archive, namespace, new FixtureRpc(chain, new Map(), namespace));
  assert.deepEqual(await archive.canonicalBlock(namespace, 1), {
    number: 1,
    hash: chain[1].hash,
    parentHash: zero,
  });
  db.close();
});

test("backfill pins a fallback source when the primary is pruned and aborts disabled or expired work", async (t) => {
  const directory = mkdtempSync("/tmp/kettigo-rpc-backfill-limits-");
  const namespace = namespaceAtTwo();
  const chain = headers(4);
  const options = (output: string, source: RpcSource, deadlineMs = 1_000) => ({
    namespace,
    target: { chainId: "11155111", number: 4, hash: chain[4].hash },
    output,
    source,
    maxBlocksPerSlice: 2,
    maxSlices: 4,
    deadlineMs,
  });
  await t.test("fallback", async () => {
    const primary = new FixtureRpc(chain, new Map(), namespace);
    primary.logs = async () => { throw new Error("pruned primary"); };
    const fallback = new FixtureRpc(chain, new Map(), namespace);
    const rpc = new FallbackRpc(primary, fallback, namespace);
    const output = join(directory, "fallback.sqlite");
    await rpc.withSource((source) => runRpcBackfill(options(output, source)));
    assert.equal(existsSync(output), true);
  });
  await t.test("disabled", async () => {
    const source = new FixtureRpc(chain, new Map(), namespace);
    let calls = 0;
    source.chainId = async () => (calls++ === 0 ? namespace.chainId : "1");
    const output = join(directory, "disabled.sqlite");
    await assert.rejects(() => runRpcBackfill(options(output, source)), /archive disabled/);
    assert.equal(existsSync(output), false);
  });
  await t.test("deadline", async () => {
    const source = new FixtureRpc(chain, new Map(), namespace);
    source.finalizedHead = async (signal) =>
      new Promise((_, reject) => signal?.addEventListener("abort", () => reject(signal.reason), { once: true }));
    const output = join(directory, "deadline.sqlite");
    await assert.rejects(() => runRpcBackfill(options(output, source, 5)), /deadline exceeded/);
    assert.equal(existsSync(output), false);
  });
});

test("CLI rejects malformed inputs and existing output without contacting an RPC", () => {
  const directory = mkdtempSync("/tmp/kettigo-rpc-backfill-cli-");
  const namespace = join(directory, "namespace.json");
  const target = join(directory, "target.json");
  const output = join(directory, "existing.sqlite");
  writeFileSync(namespace, "{");
  writeFileSync(target, "{}");
  writeFileSync(output, "leave-me");
  const driver = process.cwd().endsWith("/packages/proof-service")
    ? "tools/rpc-backfill.mts"
    : "packages/proof-service/tools/rpc-backfill.mts";
  const run = (...args: string[]) =>
    execFileSync(process.execPath, ["--experimental-transform-types", driver, ...args], {
      cwd: process.cwd(),
      stdio: "pipe",
    });
  assert.throws(
    () => run(namespace, target, join(directory, "missing.sqlite"), "--deadline-ms", "1", "--max-slices", "1"),
    /SyntaxError/,
  );
  assert.throws(
    () => run(namespace, target, output, "--deadline-ms", "1", "--max-slices", "1"),
    /backfill output already exists/,
  );
  assert.equal(readFileSync(output, "utf8"), "leave-me");
});
