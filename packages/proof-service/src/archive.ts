import {
  hash32,
  validateNamespace,
  type ArchiveLog,
  type Namespace,
  type Node,
  CheckpointConflict,
} from "./domain.ts";
import { commitStatement, ingest as ingestEvents } from "./archive-ingest.ts";
import {
  drawById as readDrawById,
  listDraws as readDraws,
  proof as readProof,
} from "./archive-read.ts";

export type Checkpoint = {
  nextBlock: number;
  lastFinalizedBlock: number;
  lastFinalizedHash: string;
  revision: number;
  disabledReason?: string;
};
export type BlockHeader = { number: number; hash: string; parentHash: string };
export type Draw = {
  drawId: string;
  rootHash: string;
  rootSum: string;
  ticket: string;
  upperBound: string;
  closeBlockNumber: number;
  closeLogIndex: number;
  chainId: string;
  pool: string;
  blockHash: string;
};
export type Proof = Draw & {
  account: string;
  index: string;
  generation: string;
  balance: string;
  siblingHashes: string[];
  siblingSums: string[];
  parentSums: string[];
};

const ZERO_HASH = `0x${"00".repeat(32)}`;
const now = () => new Date().toISOString();

export type ArchiveDatabase = Pick<D1Database, "prepare" | "batch">;

export class D1Archive {
  constructor(private readonly db: ArchiveDatabase) {}

  /** The deployment-parent anchor is persisted so first ingestion accepts the real chain parent. */
  async initialize(namespace: Namespace, deploymentParentHash = ZERO_HASH): Promise<void> {
    const n = validateNamespace(namespace);
    const anchor = hash32(deploymentParentHash, "deployment parent hash");
    await this.db
      .prepare("INSERT OR IGNORE INTO namespaces VALUES(?,?,?,?,?,?)")
      .bind(n.chainId, n.pool, n.depth, n.zero, JSON.stringify(n.emptyHashes), n.deploymentBlock)
      .run();
    await this.assertNamespace(n);
    await this.db
      .prepare("INSERT OR IGNORE INTO ingestion_state VALUES(?,?,?,?,?,?,?,?)")
      .bind(n.chainId, n.pool, n.deploymentBlock, n.deploymentBlock - 1, anchor, 0, null, now())
      .run();
    // A rollback to deployment uses this durable anchor instead of guessing zero.
    await this.db
      .prepare("INSERT OR IGNORE INTO canonical_blocks VALUES(?,?,?,?,?)")
      .bind(n.chainId, n.pool, n.deploymentBlock - 1, anchor, ZERO_HASH)
      .run();
    const initial = await this.status(n);
    if (initial.nextBlock === n.deploymentBlock && initial.lastFinalizedHash !== anchor)
      throw new Error("deployment parent anchor mismatch");
  }

  /** Read-only immutable namespace check for Worker requests and scheduler restarts. */
  async assertNamespace(namespace: Namespace): Promise<void> {
    const n = validateNamespace(namespace);
    const row = await this.db
      .prepare(
        "SELECT depth,zero_handle,empty_hashes_json,deployment_block FROM namespaces WHERE chain_id=? AND pool=?",
      )
      .bind(n.chainId, n.pool)
      .first<Record<string, unknown>>();
    if (
      !row ||
      row.depth !== n.depth ||
      row.zero_handle !== n.zero ||
      row.empty_hashes_json !== JSON.stringify(n.emptyHashes) ||
      row.deployment_block !== n.deploymentBlock
    )
      throw new Error("namespace mismatch");
  }

  async status(n: Namespace): Promise<Checkpoint> {
    const row = await this.db
      .prepare(
        "SELECT next_block,last_finalized_block,last_finalized_hash,revision,disabled_reason FROM ingestion_state WHERE chain_id=? AND pool=?",
      )
      .bind(n.chainId, n.pool)
      .first<Record<string, unknown>>();
    if (!row) throw new Error("uninitialized namespace");
    return {
      nextBlock: Number(row.next_block),
      lastFinalizedBlock: Number(row.last_finalized_block),
      lastFinalizedHash: String(row.last_finalized_hash),
      revision: Number(row.revision),
      disabledReason: row.disabled_reason ? String(row.disabled_reason) : undefined,
    };
  }

  /** Canonical history is deliberately exposed to ingestion only; proof reads stay temporal. */
  async canonicalBlock(n: Namespace, number: number): Promise<BlockHeader | null> {
    const row = await this.db
      .prepare(
        "SELECT block_number,block_hash,parent_hash FROM canonical_blocks WHERE chain_id=? AND pool=? AND block_number=?",
      )
      .bind(n.chainId, n.pool, number)
      .first<Record<string, unknown>>();
    return row
      ? {
          number: Number(row.block_number),
          hash: String(row.block_hash),
          parentHash: String(row.parent_hash),
        }
      : null;
  }

  /** Root immediately after `block`, used to reconstruct and authenticate a new slice. */
  async membershipRoot(n: Namespace, block: number): Promise<Node | null> {
    const row = await this.db
      .prepare(
        "SELECT hash,sum_handle FROM node_versions WHERE chain_id=? AND pool=? AND level=? AND node_index=? AND block_number<=? ORDER BY block_number DESC,log_index DESC LIMIT 1",
      )
      .bind(n.chainId, n.pool, n.depth, "0", block)
      .first<Record<string, unknown>>();
    return row ? { hash: hash32(row.hash), sum: hash32(row.sum_handle) } : null;
  }

  async disable(n: Namespace, expected: Checkpoint, reason: string): Promise<Checkpoint> {
    if (!reason || reason.length > 160) throw new Error("invalid disabled reason");
    try {
      await this.db.batch([
        commitStatement(
          this.db,
          n,
          expected,
          "disable",
          expected.nextBlock,
          expected.lastFinalizedBlock,
        ),
        this.db
          .prepare(
            "UPDATE ingestion_state SET disabled_reason=?,revision=revision+1,updated_at=? WHERE chain_id=? AND pool=? AND revision=?",
          )
          .bind(reason, now(), n.chainId, n.pool, expected.revision),
      ]);
    } catch (error) {
      this.conflict(error);
    }
    return this.status(n);
  }

  async ingest(
    n: Namespace,
    expected: Checkpoint,
    logs: readonly ArchiveLog[],
    headers: readonly BlockHeader[],
  ): Promise<Checkpoint>;
  /** Compatibility adapter for the original finalized-block API. New callers pass all headers. */
  async ingest(
    n: Namespace,
    expected: Checkpoint,
    logs: readonly ArchiveLog[],
    finalizedBlock: number,
    finalizedHash: string,
  ): Promise<Checkpoint>;
  async ingest(
    n: Namespace,
    expected: Checkpoint,
    logs: readonly ArchiveLog[],
    headersOrBlock: readonly BlockHeader[] | number,
    finalHash?: string,
  ): Promise<Checkpoint> {
    const headers =
      typeof headersOrBlock === "number"
        ? [{ number: headersOrBlock, hash: finalHash!, parentHash: expected.lastFinalizedHash }]
        : headersOrBlock;
    try {
      await ingestEvents(this.db, n, expected, logs, headers);
    } catch (error) {
      this.conflict(error);
    }
    return this.status(n);
  }

  async rollbackFrom(n: Namespace, expected: Checkpoint, block: number): Promise<Checkpoint> {
    if (!Number.isSafeInteger(block) || block < n.deploymentBlock || block > expected.nextBlock)
      throw new Error("invalid rollback block");
    const predecessor = await this.db
      .prepare(
        "SELECT block_hash FROM canonical_blocks WHERE chain_id=? AND pool=? AND block_number=?",
      )
      .bind(n.chainId, n.pool, block - 1)
      .first<Record<string, unknown>>();
    if (!predecessor) throw new Error("missing rollback predecessor");
    const priorHash =
      typeof predecessor === "string" ? predecessor : String(predecessor.block_hash);
    const scoped = (sql: string) => this.db.prepare(sql).bind(n.chainId, n.pool, block);
    try {
      await this.db.batch([
        commitStatement(this.db, n, expected, "rollback", block, block - 1),
        scoped("DELETE FROM draws WHERE chain_id=? AND pool=? AND close_block_number>=?"),
        scoped("DELETE FROM node_versions WHERE chain_id=? AND pool=? AND block_number>=?"),
        scoped("DELETE FROM slot_versions WHERE chain_id=? AND pool=? AND block_number>=?"),
        scoped("DELETE FROM event_logs WHERE chain_id=? AND pool=? AND block_number>=?"),
        scoped("DELETE FROM canonical_blocks WHERE chain_id=? AND pool=? AND block_number>=?"),
        this.db
          .prepare(
            "UPDATE ingestion_state SET next_block=?,last_finalized_block=?,last_finalized_hash=?,revision=revision+1,updated_at=? WHERE chain_id=? AND pool=? AND revision=?",
          )
          .bind(block, block - 1, priorHash, now(), n.chainId, n.pool, expected.revision),
      ]);
    } catch (error) {
      this.conflict(error);
    }
    return this.status(n);
  }

  async listDraws(n: Namespace, cursor?: string, limit = 20): Promise<Draw[]> {
    return readDraws(this.db, n, cursor, limit);
  }

  async proof(n: Namespace, drawId: string, account: string): Promise<Proof | null> {
    return readProof(this.db, n, drawId, account);
  }

  async drawById(n: Namespace, drawId: string): Promise<Draw | null> {
    return readDrawById(this.db, n, drawId);
  }

  private conflict(error: unknown): never {
    if (
      String(error).includes("checkpoint conflict") ||
      String(error).includes("UNIQUE constraint failed: ingestion_commits")
    )
      throw new CheckpointConflict();
    throw error;
  }
}
