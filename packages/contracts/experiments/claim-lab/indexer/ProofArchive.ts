import { DatabaseSync, StatementSync } from "node:sqlite";
import { AbiCoder, getAddress, keccak256, ZeroAddress } from "ethers";

/** Decoded pool logs, with block-global (not transaction-local) log indexes. */
export interface ArchiveLog {
  blockNumber: number;
  blockHash: string;
  logIndex: number;
  name: string;
  args: Record<string, any>;
}

export interface ArchiveOptions {
  path: string;
  chainId: string;
  pool: string;
  depth: number;
  zero: string;
  emptyHashes: string[];
}

export interface ArchivedProof {
  drawId: number;
  account: string;
  index: bigint;
  generation: bigint;
  balance: string;
  siblingHashes: string[];
  siblingSums: string[];
  parentSums: string[];
  rootHash: string;
  rootSum: string;
  chainId: string;
  pool: string;
}

export interface DrawMetadata {
  drawId: number;
  rootHash: string;
  rootSum: string;
  ticket: string;
  upperBound: string;
  blockNumber: number;
  blockHash: string;
  logIndex: number;
  chainId: string;
  pool: string;
}

type Node = { hash: string; sum: string };
type SlotRow = { account: string; slot_index: string; generation: string; assigned: number };
type DrawRow = {
  draw_id: number; root_hash: string; root_sum: string; ticket: string; upper_bound: string;
  block_number: number; block_hash: string; log_index: number;
};
type NormalizedLog = Omit<ArchiveLog, "args"> & { args: Record<string, string | number> };
const abi = AbiCoder.defaultAbiCoder();
const uint256Max = (1n << 256n) - 1n;
const uint64Max = (1n << 64n) - 1n;

function integer(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid ${label}`);
  return value;
}

function uint(value: unknown, label: string, max = uint256Max): bigint {
  if (typeof value === "number" && (!Number.isSafeInteger(value) || value < 0)) throw new Error(`Invalid ${label}`);
  if (!["string", "number", "bigint"].includes(typeof value) || !/^(0|[1-9][0-9]*)$/.test(String(value))) {
    throw new Error(`Invalid ${label}`);
  }
  const result = BigInt(value as string | number | bigint);
  if (result > max) throw new Error(`Invalid ${label}: out of range`);
  return result;
}

function bytes32(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error(`Invalid ${label}`);
  return value.toLowerCase();
}

function address(value: unknown): string {
  if (typeof value !== "string") throw new Error("Invalid account address");
  return getAddress(value);
}

function leafHash(account: string, generation: bigint, balance: string): string {
  return keccak256(abi.encode(["uint8", "address", "uint64", "bytes32"], [0, account, generation, balance]));
}

function branchHash(left: Node, right: Node): string {
  return keccak256(abi.encode(
    ["uint8", "bytes32", "bytes32", "bytes32", "bytes32"], [1, left.hash, left.sum, right.hash, right.sum],
  ));
}

/**
 * Single-pool research archive. Handles are opaque bytes32 values: no signing,
 * decryption, plaintext accounting, RPC calls, or current-state slot lookups.
 * A caller must ingest the complete event stream and explicitly roll back forks.
 */
export class ProofArchive {
  private readonly db: DatabaseSync;
  private readonly config: Omit<ArchiveOptions, "path">;
  private readonly nodeAt: StatementSync;
  private readonly accountAt: StatementSync;
  private readonly slotAt: StatementSync;
  private readonly drawById: StatementSync;
  private readonly drawPage: StatementSync;
  private closed = false;

  constructor(options: ArchiveOptions) {
    const depth = integer(options.depth, "tree depth");
    if (depth < 1 || depth > 64) throw new Error("Invalid tree depth: supported range is 1..64");
    const chainId = uint(options.chainId, "chain id").toString();
    if (chainId === "0") throw new Error("Invalid chain id");
    const zero = bytes32(options.zero, "zero handle");
    if (!Array.isArray(options.emptyHashes) || options.emptyHashes.length !== depth + 1) throw new Error("Invalid empty hashes length");
    const emptyHashes = options.emptyHashes.map(hash => bytes32(hash, "empty hash"));
    let empty = leafHash(ZeroAddress, 0n, zero);
    for (let level = 0; level <= depth; level++) {
      if (emptyHashes[level] !== empty) throw new Error(`Invalid empty hash at level ${level}`);
      const child = { hash: empty, sum: zero };
      empty = branchHash(child, child);
    }
    this.config = { chainId, pool: address(options.pool), depth, zero, emptyHashes };
    this.db = new DatabaseSync(options.path);
    try {
      this.db.exec(`
        PRAGMA foreign_keys = ON;
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = FULL;
        CREATE TABLE IF NOT EXISTS archive_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS canonical_blocks (
          block_number INTEGER PRIMARY KEY, block_hash TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS event_logs (
          block_number INTEGER NOT NULL REFERENCES canonical_blocks(block_number) ON DELETE CASCADE,
          log_index INTEGER NOT NULL, payload TEXT NOT NULL,
          PRIMARY KEY (block_number, log_index)
        ) WITHOUT ROWID;
        CREATE TABLE IF NOT EXISTS node_versions (
          level INTEGER NOT NULL, node_index TEXT NOT NULL,
          block_number INTEGER NOT NULL, log_index INTEGER NOT NULL,
          hash TEXT NOT NULL, sum TEXT NOT NULL,
          PRIMARY KEY (block_number, log_index),
          FOREIGN KEY (block_number, log_index) REFERENCES event_logs(block_number, log_index) ON DELETE CASCADE
        ) WITHOUT ROWID;
        CREATE INDEX IF NOT EXISTS node_at_position ON node_versions
          (level, node_index, block_number DESC, log_index DESC);
        CREATE TABLE IF NOT EXISTS slot_versions (
          account TEXT NOT NULL, slot_index TEXT NOT NULL, generation TEXT NOT NULL,
          assigned INTEGER NOT NULL CHECK (assigned IN (0, 1)),
          block_number INTEGER NOT NULL, log_index INTEGER NOT NULL,
          PRIMARY KEY (block_number, log_index),
          FOREIGN KEY (block_number, log_index) REFERENCES event_logs(block_number, log_index) ON DELETE CASCADE
        ) WITHOUT ROWID;
        CREATE INDEX IF NOT EXISTS account_at_position ON slot_versions
          (account, block_number DESC, log_index DESC);
        CREATE INDEX IF NOT EXISTS slot_at_position ON slot_versions
          (slot_index, block_number DESC, log_index DESC);
        CREATE TABLE IF NOT EXISTS draws (
          draw_id INTEGER PRIMARY KEY, root_hash TEXT NOT NULL, root_sum TEXT NOT NULL,
          ticket TEXT NOT NULL, upper_bound TEXT NOT NULL,
          block_number INTEGER NOT NULL, log_index INTEGER NOT NULL,
          UNIQUE (block_number, log_index),
          FOREIGN KEY (block_number, log_index) REFERENCES event_logs(block_number, log_index) ON DELETE CASCADE
        );
      `);
      const namespace = JSON.stringify({ version: 1, ...this.config });
      // One atomic insert avoids two openers silently selecting different pools.
      this.db.prepare("INSERT OR IGNORE INTO archive_metadata (key, value) VALUES ('namespace', ?)").run(namespace);
      const stored = this.db.prepare("SELECT value FROM archive_metadata WHERE key = 'namespace'").get() as { value: string };
      if (stored.value !== namespace) throw new Error("Archive namespace mismatch; use a separate database for this chain/pool/tree");

      this.nodeAt = this.db.prepare(`SELECT hash, sum FROM node_versions
        WHERE level = ? AND node_index = ? AND (block_number, log_index) < (?, ?)
        ORDER BY block_number DESC, log_index DESC LIMIT 1`);
      this.accountAt = this.db.prepare(`SELECT account, slot_index, generation, assigned FROM slot_versions
        WHERE account = ? AND (block_number, log_index) < (?, ?)
        ORDER BY block_number DESC, log_index DESC LIMIT 1`);
      this.slotAt = this.db.prepare(`SELECT account, slot_index, generation, assigned FROM slot_versions
        WHERE slot_index = ? AND (block_number, log_index) < (?, ?)
        ORDER BY block_number DESC, log_index DESC LIMIT 1`);
      const drawColumns = `SELECT d.*, b.block_hash FROM draws d
        JOIN canonical_blocks b ON b.block_number = d.block_number`;
      this.drawById = this.db.prepare(`${drawColumns} WHERE draw_id = ?`);
      this.drawPage = this.db.prepare(`${drawColumns} WHERE draw_id < ? ORDER BY draw_id DESC LIMIT ?`);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  /** Shuffled/backfilled logs and exact duplicates are safe. Forks require rollbackFrom. */
  ingest(logs: readonly ArchiveLog[]): void {
    this.assertOpen();
    if (!Array.isArray(logs)) throw new Error("Invalid event logs");
    const ordered = logs.map(log => this.normalize(log)).sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
    this.transaction(() => {
      const blockAt = this.db.prepare("SELECT block_hash FROM canonical_blocks WHERE block_number = ?");
      const addBlock = this.db.prepare("INSERT INTO canonical_blocks (block_number, block_hash) VALUES (?, ?)");
      const logAt = this.db.prepare("SELECT payload FROM event_logs WHERE block_number = ? AND log_index = ?");
      const addLog = this.db.prepare("INSERT INTO event_logs (block_number, log_index, payload) VALUES (?, ?, ?)");
      const addNode = this.db.prepare("INSERT INTO node_versions (level, node_index, block_number, log_index, hash, sum) VALUES (?, ?, ?, ?, ?, ?)");
      const addSlot = this.db.prepare("INSERT INTO slot_versions (account, slot_index, generation, assigned, block_number, log_index) VALUES (?, ?, ?, ?, ?, ?)");
      const addDraw = this.db.prepare("INSERT INTO draws (draw_id, root_hash, root_sum, ticket, upper_bound, block_number, log_index) VALUES (?, ?, ?, ?, ?, ?, ?)");
      for (const log of ordered) {
        const block = blockAt.get(log.blockNumber) as { block_hash: string } | undefined;
        if (block && block.block_hash !== log.blockHash) throw new Error(`Canonical block conflict at ${log.blockNumber}; rollback required`);
        if (!block) addBlock.run(log.blockNumber, log.blockHash);
        const payload = JSON.stringify({ name: log.name, args: log.args });
        const existing = logAt.get(log.blockNumber, log.logIndex) as { payload: string } | undefined;
        if (existing) {
          if (existing.payload !== payload) throw new Error(`Event payload conflict at ${log.blockNumber}:${log.logIndex}; rollback required`);
          continue;
        }
        addLog.run(log.blockNumber, log.logIndex, payload);
        const a = log.args;
        if (log.name === "NodeUpdated") addNode.run(a.level, a.index, log.blockNumber, log.logIndex, a.hash, a.sum);
        else if (log.name === "SlotAssigned" || log.name === "SlotReleased") {
          addSlot.run(a.account, a.index, a.generation, log.name === "SlotAssigned" ? 1 : 0, log.blockNumber, log.logIndex);
        } else {
          if (this.drawById.get(a.id)) throw new Error(`Draw id conflict at ${a.id}`);
          addDraw.run(a.id, a.rootHash, a.sum, a.ticket, a.upperBound, log.blockNumber, log.logIndex);
        }
      }
    });
  }

  /** Removes the fork block and all later versions/draws in one transaction. */
  rollbackFrom(blockNumber: number): void {
    integer(blockNumber, "rollback block number");
    this.transaction(() => { this.db.prepare("DELETE FROM canonical_blocks WHERE block_number >= ?").run(blockNumber); });
  }

  /** O(depth) indexed temporal lookups; no event-history replay on this path. */
  proof(drawId: number, account: string, expectedRoot?: { rootHash: string; rootSum: string }): ArchivedProof {
    this.assertOpen();
    integer(drawId, "draw id");
    const owner = address(account);
    const draw = this.drawById.get(drawId) as DrawRow | undefined;
    if (!draw) throw new Error(`Unknown draw ${drawId}`);
    if (expectedRoot && (bytes32(expectedRoot.rootHash, "expected root hash") !== draw.root_hash
      || bytes32(expectedRoot.rootSum, "expected root sum") !== draw.root_sum)) throw new Error("Onchain root mismatch");
    const position = [draw.block_number, draw.log_index];
    const slot = this.accountAt.get(owner, ...position) as SlotRow | undefined;
    if (!slot?.assigned) throw new Error("Account had no eligible slot at this draw");
    const occupant = this.slotAt.get(slot.slot_index, ...position) as SlotRow | undefined;
    if (!occupant?.assigned || occupant.account !== owner || occupant.generation !== slot.generation) {
      throw new Error("Incomplete or corrupt slot ownership history");
    }
    const index = BigInt(slot.slot_index), generation = BigInt(slot.generation);
    const findNode = (level: number, at: bigint, required = false): Node => {
      const found = this.nodeAt.get(level, at.toString(), ...position) as Node | undefined;
      if (found) return found;
      if (required) throw new Error(`Incomplete proof: missing node ${level}:${at}`);
      return { hash: this.config.emptyHashes[level], sum: this.config.zero };
    };
    let current = findNode(0, index, true), cursor = index;
    const balance = current.sum;
    if (current.hash !== leafHash(owner, generation, balance)) throw new Error("Incomplete or corrupt leaf: owner/generation/hash mismatch");
    const siblingHashes: string[] = [], siblingSums: string[] = [], parentSums: string[] = [];
    for (let level = 0; level < this.config.depth; level++) {
      const sibling = findNode(level, cursor ^ 1n);
      const parent = findNode(level + 1, cursor >> 1n, true);
      const hash = (cursor & 1n) === 0n ? branchHash(current, sibling) : branchHash(sibling, current);
      if (parent.hash !== hash) throw new Error(`Incomplete or corrupt proof: parent hash mismatch at level ${level + 1}`);
      siblingHashes.push(sibling.hash); siblingSums.push(sibling.sum); parentSums.push(parent.sum);
      current = parent; cursor >>= 1n;
    }
    if (current.hash !== draw.root_hash || current.sum !== draw.root_sum) throw new Error("Incomplete or corrupt proof: closed root mismatch");
    return {
      drawId, account: owner, index, generation, balance, siblingHashes, siblingSums, parentSums,
      rootHash: draw.root_hash, rootSum: draw.root_sum, chainId: this.config.chainId, pool: this.config.pool,
    };
  }

  /** Newest draw ids first; the optional cursor is exclusive. Maximum 100 rows. */
  listDraws(cursor?: number, limit = 20): DrawMetadata[] {
    this.assertOpen();
    if (cursor !== undefined) integer(cursor, "draw cursor");
    integer(limit, "page limit");
    if (limit < 1) throw new Error("Invalid page limit");
    const before = cursor ?? BigInt(Number.MAX_SAFE_INTEGER) + 1n;
    return (this.drawPage.all(before, Math.min(limit, 100)) as DrawRow[]).map(draw => ({
      drawId: draw.draw_id, rootHash: draw.root_hash, rootSum: draw.root_sum, ticket: draw.ticket,
      upperBound: draw.upper_bound, blockNumber: draw.block_number, blockHash: draw.block_hash,
      logIndex: draw.log_index, chainId: this.config.chainId, pool: this.config.pool,
    }));
  }

  close(): void {
    if (!this.closed) { this.db.close(); this.closed = true; }
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("Proof archive is closed");
  }

  private transaction(work: () => void): void {
    this.assertOpen();
    this.db.exec("BEGIN IMMEDIATE");
    try { work(); this.db.exec("COMMIT"); }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  private normalize(log: ArchiveLog): NormalizedLog {
    const blockNumber = integer(log.blockNumber, "block number"), logIndex = integer(log.logIndex, "log index");
    const blockHash = bytes32(log.blockHash, "block hash");
    if (!log.args || typeof log.args !== "object") throw new Error("Invalid event args");
    const a = log.args;
    let args: NormalizedLog["args"];
    if (log.name === "SlotAssigned" || log.name === "SlotReleased") {
      args = {
        account: address(a.account), index: uint(a.index, "slot index", (1n << BigInt(this.config.depth)) - 1n).toString(),
        generation: uint(a.generation, "slot generation", uint64Max).toString(),
      };
    } else if (log.name === "NodeUpdated") {
      const level = Number(uint(a.level, "node level", BigInt(this.config.depth)));
      args = {
        level, index: uint(a.index, "node index", (1n << BigInt(this.config.depth - level)) - 1n).toString(),
        hash: bytes32(a.hash, "node hash"), sum: bytes32(a.sum, "node sum"),
      };
    } else if (log.name === "Closed") {
      args = {
        id: Number(uint(a.id, "draw id", BigInt(Number.MAX_SAFE_INTEGER))), rootHash: bytes32(a.rootHash, "root hash"),
        sum: bytes32(a.sum, "root sum"), ticket: bytes32(a.ticket, "ticket"), upperBound: uint(a.upperBound, "upper bound").toString(),
      };
    } else throw new Error(`Invalid event name ${log.name}`);
    return { blockNumber, blockHash, logIndex, name: log.name, args };
  }
}
