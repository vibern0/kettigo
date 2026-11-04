import {
  branchHash,
  checksum,
  decimal,
  hash32,
  leafHash,
  uint,
  validateNamespace,
  type ArchiveLog,
  type Namespace,
  type Node,
  CheckpointConflict,
} from "./domain.ts";

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
const before = "(block_number<? OR (block_number=? AND log_index<?))";

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
        this.commit(n, expected, "disable", expected.nextBlock, expected.lastFinalizedBlock),
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
    const blocks = [...headers].sort((a, b) => a.number - b.number);
    if (!blocks.length || blocks[0].number !== expected.nextBlock)
      throw new Error("invalid header range");
    for (let i = 0; i < blocks.length; i += 1) {
      if (
        !Number.isSafeInteger(blocks[i].number) ||
        blocks[i].number < 0 ||
        (i && blocks[i].number !== blocks[i - 1].number + 1)
      )
        throw new Error("invalid header range");
      hash32(blocks[i].hash);
      hash32(blocks[i].parentHash);
      if (
        hash32(blocks[i].parentHash) !==
        (i ? hash32(blocks[i - 1].hash) : expected.lastFinalizedHash)
      )
        throw new Error("non-canonical header range");
    }
    const statements: D1PreparedStatement[] = [
      this.commit(n, expected, "ingest", expected.nextBlock, blocks.at(-1)!.number),
    ];
    for (const block of blocks)
      statements.push(
        this.db
          .prepare("INSERT INTO canonical_blocks VALUES(?,?,?,?,?)")
          .bind(n.chainId, n.pool, block.number, hash32(block.hash), hash32(block.parentHash)),
      );
    const uniqueLogs = new Map<string, ArchiveLog>();
    for (const log of logs) {
      const key = `${log.blockNumber}:${log.logIndex}`;
      const prior = uniqueLogs.get(key);
      if (prior && JSON.stringify(prior) !== JSON.stringify(log))
        throw new Error("conflicting log payload");
      uniqueLogs.set(key, log);
    }
    for (const log of [...uniqueLogs.values()].sort(
      (a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex,
    )) {
      if (log.blockNumber < blocks[0].number || log.blockNumber > blocks.at(-1)!.number)
        throw new Error("log outside header range");
      const header = blocks[log.blockNumber - blocks[0].number];
      if (!header || hash32(log.blockHash, "log block hash") !== hash32(header.hash))
        throw new Error("log block hash mismatch");
      statements.push(
        this.db
          .prepare("INSERT INTO event_logs VALUES(?,?,?,?,?)")
          .bind(
            n.chainId,
            n.pool,
            log.blockNumber,
            log.logIndex,
            JSON.stringify({ name: log.name, args: log.args }),
          ),
      );
      if (log.name === "NodeUpdated") {
        const level = Number(decimal(log.args.level, "level"));
        const index = decimal(log.args.index, "node index");
        if (
          !Number.isSafeInteger(level) ||
          level < 0 ||
          level > n.depth ||
          BigInt(index) >= 1n << BigInt(n.depth - level)
        )
          throw new Error("invalid node position");
        statements.push(
          this.db
            .prepare("INSERT INTO node_versions VALUES(?,?,?,?,?,?,?,?)")
            .bind(
              n.chainId,
              n.pool,
              level,
              index,
              log.blockNumber,
              log.logIndex,
              hash32(log.args.hash),
              hash32(log.args.sum),
            ),
        );
      } else if (log.name === "SlotAssigned" || log.name === "SlotReleased")
        statements.push(
          this.db
            .prepare("INSERT INTO slot_versions VALUES(?,?,?,?,?,?,?,?)")
            .bind(
              n.chainId,
              n.pool,
              checksum(log.args.account),
              this.slotIndex(n, log.args.index),
              uint(log.args.generation, 64, "generation"),
              log.name === "SlotAssigned" ? 1 : 0,
              log.blockNumber,
              log.logIndex,
            ),
        );
      else {
        const upperBound = uint(log.args.upperBound, 64, "draw upper bound");
        if (BigInt(upperBound) === 0n || BigInt(upperBound) > 1n << BigInt(n.depth))
          throw new Error("invalid draw upper bound");
        statements.push(
          this.db
            .prepare("INSERT INTO draws VALUES(?,?,?,?,?,?,?,?,?)")
            .bind(
              n.chainId,
              n.pool,
              decimal(log.args.drawId),
              hash32(log.args.rootHash),
              hash32(log.args.rootSum),
              hash32(log.args.ticket),
              upperBound,
              Number(log.args.closeBlockNumber),
              log.logIndex,
            ),
        );
      }
    }
    const final = blocks.at(-1)!;
    statements.push(
      this.db
        .prepare(
          "UPDATE ingestion_state SET next_block=?,last_finalized_block=?,last_finalized_hash=?,revision=revision+1,updated_at=? WHERE chain_id=? AND pool=? AND revision=?",
        )
        .bind(
          final.number + 1,
          final.number,
          hash32(final.hash),
          now(),
          n.chainId,
          n.pool,
          expected.revision,
        ),
    );
    try {
      await this.db.batch(statements);
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
        this.commit(n, expected, "rollback", block, block - 1),
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
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("invalid limit");
    const c = cursor === undefined ? undefined : decimal(cursor, "cursor");
    const predicate =
      c === undefined
        ? ""
        : " AND (length(d.draw_id)<length(?) OR (length(d.draw_id)=length(?) AND d.draw_id<?))";
    const query = `SELECT d.*,b.block_hash FROM draws d JOIN canonical_blocks b ON b.chain_id=d.chain_id AND b.pool=d.pool AND b.block_number=d.close_block_number WHERE d.chain_id=? AND d.pool=?${predicate} ORDER BY length(d.draw_id) DESC,d.draw_id DESC LIMIT ?`;
    const result =
      c === undefined
        ? await this.db.prepare(query).bind(n.chainId, n.pool, limit).all<Record<string, unknown>>()
        : await this.db
            .prepare(query)
            .bind(n.chainId, n.pool, c, c, c, limit)
            .all<Record<string, unknown>>();
    return result.results.map((row) => this.draw(n, row));
  }

  async proof(n: Namespace, drawId: string, account: string): Promise<Proof | null> {
    const row = await this.db
      .prepare(
        "SELECT d.*,b.block_hash FROM draws d JOIN canonical_blocks b ON b.chain_id=d.chain_id AND b.pool=d.pool AND b.block_number=d.close_block_number WHERE d.chain_id=? AND d.pool=? AND d.draw_id=?",
      )
      .bind(n.chainId, n.pool, decimal(drawId))
      .first<Record<string, unknown>>();
    if (!row) return null;
    const draw = this.draw(n, row);
    const owner = checksum(account);
    const args = [
      n.chainId,
      n.pool,
      owner,
      draw.closeBlockNumber,
      draw.closeBlockNumber,
      draw.closeLogIndex,
    ];
    const slot = await this.db
      .prepare(
        `SELECT * FROM slot_versions WHERE chain_id=? AND pool=? AND account=? AND ${before} ORDER BY block_number DESC,log_index DESC LIMIT 1`,
      )
      .bind(...args)
      .first<Record<string, unknown>>();
    if (!slot || Number(slot.assigned) !== 1) return null;
    if (BigInt(String(slot.slot_index)) >= BigInt(draw.upperBound)) return null;
    const occupant = await this.db
      .prepare(
        `SELECT * FROM slot_versions WHERE chain_id=? AND pool=? AND slot_index=? AND ${before} ORDER BY block_number DESC,log_index DESC LIMIT 1`,
      )
      .bind(
        n.chainId,
        n.pool,
        String(slot.slot_index),
        draw.closeBlockNumber,
        draw.closeBlockNumber,
        draw.closeLogIndex,
      )
      .first<Record<string, unknown>>();
    if (
      !occupant ||
      Number(occupant.assigned) !== 1 ||
      occupant.account !== owner ||
      occupant.generation !== slot.generation
    )
      throw new Error("ownership history unavailable");
    let index = BigInt(String(slot.slot_index));
    const queries: D1PreparedStatement[] = [];
    for (let level = 0; level <= n.depth; level += 1) {
      queries.push(this.nodeQuery(n, level, index, draw));
      if (level < n.depth) queries.push(this.nodeQuery(n, level, index ^ 1n, draw));
      index >>= 1n;
    }
    const results = await this.db.batch(queries);
    let position = 0;
    index = BigInt(String(slot.slot_index));
    const read = (level: number, required: boolean): Node => {
      const result = results[position++].results[0] as Record<string, unknown> | undefined;
      if (result) return { hash: String(result.hash), sum: String(result.sum_handle) };
      if (required) throw new Error("node history unavailable");
      return { hash: n.emptyHashes[level], sum: n.zero };
    };
    let current = read(0, true);
    if (current.hash !== leafHash(owner, String(slot.generation), current.sum))
      throw new Error("leaf mismatch");
    const balance = current.sum;
    const siblingHashes: string[] = [];
    const siblingSums: string[] = [];
    const parentSums: string[] = [];
    for (let level = 0; level < n.depth; level += 1) {
      const sibling = read(level, false);
      const parent = read(level + 1, true);
      if (
        parent.hash !==
        branchHash((index & 1n) === 1n ? sibling : current, (index & 1n) === 1n ? current : sibling)
      )
        throw new Error("parent mismatch");
      siblingHashes.push(sibling.hash);
      siblingSums.push(sibling.sum);
      parentSums.push(parent.sum);
      current = parent;
      index >>= 1n;
    }
    if (current.hash !== draw.rootHash || current.sum !== draw.rootSum)
      throw new Error("root mismatch");
    return {
      ...draw,
      account: owner,
      index: String(slot.slot_index),
      generation: String(slot.generation),
      balance,
      siblingHashes,
      siblingSums,
      parentSums,
    };
  }

  async drawById(n: Namespace, drawId: string): Promise<Draw | null> {
    const row = await this.db
      .prepare(
        "SELECT d.*,b.block_hash FROM draws d JOIN canonical_blocks b ON b.chain_id=d.chain_id AND b.pool=d.pool AND b.block_number=d.close_block_number WHERE d.chain_id=? AND d.pool=? AND d.draw_id=?",
      )
      .bind(n.chainId, n.pool, decimal(drawId, "draw id"))
      .first<Record<string, unknown>>();
    return row ? this.draw(n, row) : null;
  }

  private nodeQuery(n: Namespace, level: number, index: bigint, draw: Draw): D1PreparedStatement {
    return this.db
      .prepare(
        `SELECT hash,sum_handle FROM node_versions WHERE chain_id=? AND pool=? AND level=? AND node_index=? AND ${before} ORDER BY block_number DESC,log_index DESC LIMIT 1`,
      )
      .bind(
        n.chainId,
        n.pool,
        level,
        index.toString(),
        draw.closeBlockNumber,
        draw.closeBlockNumber,
        draw.closeLogIndex,
      );
  }
  private slotIndex(n: Namespace, value: string): string {
    const index = decimal(value, "slot index");
    if (BigInt(index) >= 1n << BigInt(n.depth)) throw new Error("invalid slot index");
    return index;
  }
  private commit(
    n: Namespace,
    expected: Checkpoint,
    kind: string,
    from: number,
    to: number,
  ): D1PreparedStatement {
    return this.db
      .prepare("INSERT INTO ingestion_commits VALUES(?,?,?,?,?,?,?)")
      .bind(n.chainId, n.pool, expected.revision, kind, from, to, now());
  }
  private draw(n: Namespace, row: Record<string, unknown>): Draw {
    return {
      drawId: String(row.draw_id),
      rootHash: String(row.root_hash),
      rootSum: String(row.root_sum),
      ticket: String(row.ticket_handle),
      upperBound: String(row.upper_bound_handle),
      closeBlockNumber: Number(row.close_block_number),
      closeLogIndex: Number(row.close_log_index),
      chainId: n.chainId,
      pool: n.pool,
      blockHash: String(row.block_hash),
    };
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
