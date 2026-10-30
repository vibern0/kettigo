import { expect } from "chai";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AbiCoder, getAddress, keccak256, toBeHex, ZeroAddress } from "ethers";
import { ProofArchive, ArchiveLog } from "../indexer/ProofArchive";

const abi = AbiCoder.defaultAbiCoder();
const zero = toBeHex(0, 32);
const alice = getAddress("0x000000000000000000000000000000000000a11c");
const bob = getAddress("0x000000000000000000000000000000000000b0b0");
const pool = getAddress("0x000000000000000000000000000000000000cafe");
const leafHash = (account: string, generation: bigint, balance: string) => keccak256(abi.encode(
  ["uint8", "address", "uint64", "bytes32"], [0, account, generation, balance],
));
const branchHash = (left: Node, right: Node) => keccak256(abi.encode(
  ["uint8", "bytes32", "bytes32", "bytes32", "bytes32"], [1, left.hash, left.sum, right.hash, right.sum],
));
type Node = { hash: string; sum: string };

function emptyHashes(depth = 2, handle = zero): string[] {
  const hashes = [leafHash(ZeroAddress, 0n, handle)];
  for (let level = 1; level <= depth; level++) {
    const child = { hash: hashes[level - 1], sum: handle };
    hashes.push(branchHash(child, child));
  }
  return hashes;
}

// The fixture uses unrelated bytes32 handles. It never treats a handle as a balance.
class Events {
  readonly logs: ArchiveLog[] = [];
  readonly nodes = new Map<string, Node>();
  readonly empties = emptyHashes();
  private nonce = 100;
  private positions = new Map<number, number>();
  constructor(readonly branch = 0) {}
  node(level: number, index: number): Node {
    return this.nodes.get(`${level}:${index}`) ?? { hash: this.empties[level], sum: zero };
  }
  emit(blockNumber: number, name: string, args: Record<string, unknown>) {
    const logIndex = this.positions.get(blockNumber) ?? 0;
    this.positions.set(blockNumber, logIndex + 1);
    const log = { blockNumber, blockHash: toBeHex(1_000 + blockNumber + this.branch * 10_000, 32), logIndex, name, args };
    this.logs.push(log);
    return log;
  }
  update(block: number, account: string, index: number, generation: bigint, balance: string) {
    let cursor = index;
    this.nodes.set(`0:${cursor}`, { hash: leafHash(account, generation, balance), sum: balance });
    this.emit(block, "NodeUpdated", { level: 0n, index: BigInt(cursor), ...this.node(0, cursor) });
    for (let level = 1; level <= 2; level++) {
      cursor = Math.floor(cursor / 2);
      const left = this.node(level - 1, cursor * 2), right = this.node(level - 1, cursor * 2 + 1);
      const node = { hash: branchHash(left, right), sum: toBeHex(++this.nonce, 32) };
      this.nodes.set(`${level}:${cursor}`, node);
      this.emit(block, "NodeUpdated", { level: BigInt(level), index: BigInt(cursor), ...node });
    }
  }
  assign(block: number, account: string, index: number, generation: bigint, balance: string) {
    this.emit(block, "SlotAssigned", { account, index: BigInt(index), generation });
    this.update(block, account, index, generation, balance);
  }
  release(block: number, account: string, index: number, generation: bigint) {
    this.update(block, ZeroAddress, index, 0n, zero);
    this.emit(block, "SlotReleased", { account, index: BigInt(index), generation });
  }
  close(block: number, id: number) {
    const root = this.node(2, 0);
    return this.emit(block, "Closed", { id: BigInt(id), rootHash: root.hash, sum: root.sum, ticket: toBeHex(50_000 + id, 32), upperBound: 4n });
  }
}

describe("SQLite proof archive", function () {
  let directory: string;
  const opened: ProofArchive[] = [];
  beforeEach(function () { directory = mkdtempSync(path.join(tmpdir(), "claim-proof-")); });
  afterEach(function () {
    for (const archive of opened.splice(0)) archive.close();
    rmSync(directory, { recursive: true, force: true });
  });
  function options(overrides: Record<string, unknown> = {}) {
    return { path: path.join(directory, "archive.sqlite"), chainId: "11155111", pool, depth: 2, zero, emptyHashes: emptyHashes(), ...overrides } as ConstructorParameters<typeof ProofArchive>[0];
  }
  function open(overrides: Record<string, unknown> = {}) {
    const archive = new ProofArchive(options(overrides));
    opened.push(archive);
    return archive;
  }

  it("persists a locally verified historical path across process restarts", function () {
    const events = new Events();
    events.assign(1, alice, 1, 1n, toBeHex(7, 32));
    events.assign(2, bob, 2, 1n, toBeHex(9, 32));
    events.close(3, 1);
    const archive = open();
    archive.ingest(events.logs);
    const proof = archive.proof(1, alice.toLowerCase());
    expect(proof).to.include({ drawId: 1, account: alice, index: 1n, generation: 1n, balance: toBeHex(7, 32), chainId: "11155111", pool });
    expect(proof.siblingHashes).to.deep.equal([events.empties[0], events.node(1, 1).hash]);
    expect(proof.siblingSums).to.deep.equal([zero, events.node(1, 1).sum]);
    expect(proof.parentSums).to.deep.equal([events.node(1, 0).sum, events.node(2, 0).sum]);
    expect(proof.rootHash).to.equal(events.node(2, 0).hash);
    expect(proof.rootSum).to.equal(events.node(2, 0).sum);
    archive.close();
    expect(open().proof(1, alice, { rootHash: proof.rootHash, rootSum: proof.rootSum })).to.deep.equal(proof);
    expect(() => open().proof(1, alice, { rootHash: zero, rootSum: proof.rootSum })).to.throw(/root/i);
    expect(() => open().proof(1, alice, { rootHash: proof.rootHash, rootSum: zero })).to.throw(/root/i);
  });

  it("recovers the owner and generation before a slot is reused and its old owner rejoins elsewhere", function () {
    const events = new Events();
    events.assign(1, alice, 0, 1n, toBeHex(7, 32)); events.close(2, 1);
    events.release(3, alice, 0, 1n);
    events.assign(4, bob, 0, 2n, toBeHex(9, 32));
    events.assign(5, alice, 3, 1n, toBeHex(11, 32)); events.close(6, 2);
    const archive = open(); archive.ingest(events.logs);
    expect(archive.proof(1, alice)).to.include({ index: 0n, generation: 1n, balance: toBeHex(7, 32) });
    expect(() => archive.proof(1, bob)).to.throw(/slot|eligible/i);
    expect(archive.proof(2, bob)).to.include({ index: 0n, generation: 2n, balance: toBeHex(9, 32) });
    expect(archive.proof(2, alice)).to.include({ index: 3n, generation: 1n, balance: toBeHex(11, 32) });
  });

  for (const damage of ["missing leaf", "missing parent", "corrupt sibling", "corrupt parent sum", "wrong generation"] as const) {
    it(`rejects a ${damage} instead of serving an invalid claim`, function () {
      const events = new Events();
      events.assign(1, alice, 0, 1n, toBeHex(7, 32));
      events.assign(2, bob, 2, 1n, toBeHex(9, 32)); events.close(3, 1);
      let logs = events.logs.map(log => ({ ...log, args: { ...log.args } }));
      if (damage === "missing leaf") logs = logs.filter(log => !(log.name === "NodeUpdated" && log.args.level === 0n && log.args.index === 0n));
      if (damage === "missing parent") logs = logs.filter(log => !(log.name === "NodeUpdated" && log.args.level === 1n && log.args.index === 0n));
      if (damage === "corrupt sibling") logs.find(log => log.name === "NodeUpdated" && log.args.level === 1n && log.args.index === 1n)!.args.hash = zero;
      if (damage === "corrupt parent sum") logs.find(log => log.name === "NodeUpdated" && log.args.level === 1n && log.args.index === 0n)!.args.sum = zero;
      if (damage === "wrong generation") logs.find(log => log.name === "SlotAssigned" && log.args.account === alice)!.args.generation = 2n;
      const archive = open(); archive.ingest(logs);
      expect(() => archive.proof(1, alice)).to.throw(/incomplete|corrupt|mismatch/i);
    });
  }

  it("accepts shuffled duplicates and out-of-order backfills but rejects conflicting positions atomically", function () {
    const events = new Events();
    events.assign(1, alice, 0, 1n, toBeHex(7, 32)); events.close(2, 1);
    const archive = open();
    archive.ingest(events.logs.filter(log => log.blockNumber === 2));
    archive.ingest([...events.logs].reverse().concat(events.logs));
    const first = archive.proof(1, alice);
    const conflict = { ...events.logs[1], args: { ...events.logs[1].args, sum: zero } };
    // Sort this valid insert before the conflicting log, so the assertion below
    // detects a missing transaction rather than merely detecting early failure.
    const extra = { ...events.logs.at(-1)!, blockNumber: 0, blockHash: toBeHex(1000, 32), args: { ...events.logs.at(-1)!.args, id: 2n } };
    expect(() => archive.ingest([extra, conflict])).to.throw(/conflict/i);
    expect(archive.listDraws().map(draw => draw.drawId)).to.deep.equal([1]);
    expect(archive.proof(1, alice)).to.deep.equal(first);
    expect(() => archive.ingest([{ ...extra, blockNumber: 1, blockHash: toBeHex(9999, 32), logIndex: 99 }])).to.throw(/conflict|rollback/i);
  });

  it("uses the exact close log index for same-block balance changes and ownership transfers", function () {
    const events = new Events();
    events.assign(1, alice, 0, 1n, toBeHex(7, 32));
    events.update(2, alice, 0, 1n, toBeHex(8, 32)); events.close(2, 1);
    events.release(2, alice, 0, 1n); events.assign(2, bob, 0, 2n, toBeHex(9, 32)); events.close(2, 2);
    const archive = open(); archive.ingest([...events.logs].reverse());
    expect(archive.proof(1, alice)).to.include({ index: 0n, generation: 1n, balance: toBeHex(8, 32) });
    expect(() => archive.proof(1, bob)).to.throw(/slot|eligible/i);
    expect(archive.proof(2, bob)).to.include({ index: 0n, generation: 2n, balance: toBeHex(9, 32) });
    expect(() => archive.proof(2, alice)).to.throw(/slot|eligible/i);
  });

  it("rolls back every forked version and accepts a replacement canonical branch", function () {
    const events = new Events();
    events.assign(1, alice, 0, 1n, toBeHex(7, 32)); events.close(2, 1);
    const initial = events.logs.slice();
    events.release(3, alice, 0, 1n); events.assign(3, bob, 0, 2n, toBeHex(9, 32)); events.close(4, 2);
    const archive = open(); archive.ingest(events.logs);
    const orphan = archive.proof(2, bob);
    archive.rollbackFrom(3);
    expect(() => archive.proof(2, bob)).to.throw(/draw/i);
    expect(archive.proof(1, alice).balance).to.equal(toBeHex(7, 32));
    const canonical = new Events(1);
    canonical.assign(1, alice, 0, 1n, toBeHex(7, 32));
    canonical.update(3, alice, 0, 1n, toBeHex(11, 32)); canonical.close(4, 2);
    archive.ingest(canonical.logs.filter(log => log.blockNumber >= 3));
    expect(archive.proof(2, alice).rootHash).not.to.equal(orphan.rootHash);
    expect(archive.proof(2, alice).balance).to.equal(toBeHex(11, 32));
    expect(() => archive.proof(2, bob)).to.throw(/slot|eligible/i);
    archive.rollbackFrom(0);
    expect(archive.listDraws()).to.deep.equal([]);
    archive.ingest(initial);
    expect(archive.proof(1, alice).balance).to.equal(toBeHex(7, 32));
  });

  it("rejects reopening a database under another chain, pool, depth, zero handle, or empty tree", function () {
    open().close();
    for (const override of [
      { chainId: "1" }, { pool: bob }, { depth: 3, emptyHashes: emptyHashes(3) },
      { zero: toBeHex(1, 32), emptyHashes: emptyHashes(2, toBeHex(1, 32)) },
      { emptyHashes: [zero, ...emptyHashes().slice(1)] },
    ]) expect(() => open(override)).to.throw(/namespace|empty/i);
    expect(open().listDraws()).to.deep.equal([]);
  });

  it("bounds draw pagination to 100 metadata rows with an exclusive cursor", function () {
    const events = new Events(); events.assign(1, alice, 0, 1n, toBeHex(7, 32));
    for (let id = 1; id <= 105; id++) events.close(id + 1, id);
    const archive = open(); archive.ingest(events.logs);
    const first = archive.listDraws(undefined, 500);
    expect(first).to.have.length(100);
    expect(first[0].drawId).to.equal(105); expect(first.at(-1)!.drawId).to.equal(6);
    expect(first[0]).to.include({ rootHash: events.node(2, 0).hash, rootSum: events.node(2, 0).sum, chainId: "11155111", pool });
    expect(first[0]).not.to.have.property("account");
    expect(archive.listDraws(6, 10).map(draw => draw.drawId)).to.deep.equal([5, 4, 3, 2, 1]);
    expect(archive.listDraws()).to.have.length(20);
    expect(() => archive.listDraws(-1)).to.throw(/invalid/i);
    expect(() => archive.listDraws(undefined, 0)).to.throw(/invalid/i);
  });

  it("includes the largest supported draw id on the first page", function () {
    const events = new Events(); events.assign(1, alice, 0, 1n, toBeHex(7, 32));
    const closed = events.close(2, 1);
    closed.args.id = BigInt(Number.MAX_SAFE_INTEGER);
    const archive = open(); archive.ingest(events.logs);
    expect(archive.listDraws().map(draw => draw.drawId)).to.deep.equal([Number.MAX_SAFE_INTEGER]);
    expect(archive.proof(Number.MAX_SAFE_INTEGER, alice).balance).to.equal(toBeHex(7, 32));
  });

  it("rejects malformed event coordinates and query inputs without retaining partial writes", function () {
    const events = new Events(); events.assign(1, alice, 0, 1n, toBeHex(7, 32)); events.close(2, 1);
    const archive = open();
    for (const malformed of [
      { ...events.logs[0], blockNumber: -1 },
      { ...events.logs[0], logIndex: 1.5 },
      { ...events.logs[0], blockHash: "0x00" },
      { ...events.logs[0], args: { ...events.logs[0].args, index: 4n } },
      { ...events.logs[0], args: { ...events.logs[0].args, generation: 1n << 64n } },
      { ...events.logs[1], args: { ...events.logs[1].args, level: 3n } },
    ]) expect(() => archive.ingest([...events.logs, malformed])).to.throw(/invalid|range/i);
    expect(archive.listDraws()).to.deep.equal([]);
    archive.ingest(events.logs);
    expect(() => archive.proof(1, "0x12")).to.throw(/address|invalid/i);
    expect(() => archive.proof(Number.MAX_SAFE_INTEGER + 1, alice)).to.throw(/invalid/i);
    expect(() => archive.rollbackFrom(-1)).to.throw(/invalid/i);
  });
});
