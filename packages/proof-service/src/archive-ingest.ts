import { checksum, decimal, hash32, uint, type ArchiveLog, type Namespace } from "./domain.ts";
import type { ArchiveDatabase, BlockHeader, Checkpoint } from "./archive.ts";

const now = () => new Date().toISOString();

export function commitStatement(
  db: ArchiveDatabase,
  n: Namespace,
  expected: Checkpoint,
  kind: string,
  from: number,
  to: number,
): D1PreparedStatement {
  return db
    .prepare("INSERT INTO ingestion_commits VALUES(?,?,?,?,?,?,?)")
    .bind(n.chainId, n.pool, expected.revision, kind, from, to, now());
}

export function slotIndex(n: Namespace, value: string): string {
  const index = decimal(value, "slot index");
  if (BigInt(index) >= 1n << BigInt(n.depth)) throw new Error("invalid slot index");
  return index;
}

function validateHeaders(expected: Checkpoint, headers: readonly BlockHeader[]): BlockHeader[] {
  const blocks = [...headers].sort((a, b) => a.number - b.number);
  if (!blocks.length || blocks[0].number !== expected.nextBlock)
    throw new Error("invalid header range");
  let previous: BlockHeader | undefined;
  for (const block of blocks) {
    if (
      !Number.isSafeInteger(block.number) ||
      block.number < 0 ||
      (previous && block.number !== previous.number + 1)
    )
      throw new Error("invalid header range");
    hash32(block.hash);
    hash32(block.parentHash);
    if (
      hash32(block.parentHash) !== (previous ? hash32(previous.hash) : expected.lastFinalizedHash)
    )
      throw new Error("non-canonical header range");
    previous = block;
  }
  return blocks;
}

function uniqueSortedLogs(logs: readonly ArchiveLog[]): ArchiveLog[] {
  const uniqueLogs = new Map<string, ArchiveLog>();
  for (const log of logs) {
    const key = `${log.blockNumber}:${log.logIndex}`;
    const prior = uniqueLogs.get(key);
    if (prior && JSON.stringify(prior) !== JSON.stringify(log))
      throw new Error("conflicting log payload");
    uniqueLogs.set(key, log);
  }
  return [...uniqueLogs.values()].sort(
    (a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex,
  );
}

function appendEventStatements(
  db: ArchiveDatabase,
  n: Namespace,
  blocks: readonly BlockHeader[],
  logs: readonly ArchiveLog[],
  statements: D1PreparedStatement[],
): void {
  const first = blocks[0]!;
  const final = blocks.at(-1)!;
  for (const log of uniqueSortedLogs(logs)) {
    if (log.blockNumber < first.number || log.blockNumber > final.number)
      throw new Error("log outside header range");
    const header = blocks.find((block) => block.number === log.blockNumber);
    if (!header || hash32(log.blockHash, "log block hash") !== hash32(header.hash))
      throw new Error("log block hash mismatch");
    statements.push(
      db
        .prepare("INSERT INTO event_logs VALUES(?,?,?,?,?)")
        .bind(
          n.chainId,
          n.pool,
          log.blockNumber,
          log.logIndex,
          JSON.stringify({ name: log.name, args: log.args }),
        ),
    );
    if (log.name === "NodeUpdated") appendNodeStatement(db, n, log, statements);
    else if (log.name === "SlotAssigned" || log.name === "SlotReleased")
      appendSlotStatement(db, n, log, statements);
    else appendDrawStatement(db, n, log, statements);
  }
}

function appendNodeStatement(
  db: ArchiveDatabase,
  n: Namespace,
  log: ArchiveLog,
  statements: D1PreparedStatement[],
): void {
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
    db
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
}

function appendSlotStatement(
  db: ArchiveDatabase,
  n: Namespace,
  log: ArchiveLog,
  statements: D1PreparedStatement[],
): void {
  statements.push(
    db
      .prepare("INSERT INTO slot_versions VALUES(?,?,?,?,?,?,?,?)")
      .bind(
        n.chainId,
        n.pool,
        checksum(log.args.account),
        slotIndex(n, log.args.index),
        uint(log.args.generation, 64, "generation"),
        log.name === "SlotAssigned" ? 1 : 0,
        log.blockNumber,
        log.logIndex,
      ),
  );
}

function appendDrawStatement(
  db: ArchiveDatabase,
  n: Namespace,
  log: ArchiveLog,
  statements: D1PreparedStatement[],
): void {
  const upperBound = uint(log.args.upperBound, 64, "draw upper bound");
  if (BigInt(upperBound) === 0n || BigInt(upperBound) > 1n << BigInt(n.depth))
    throw new Error("invalid draw upper bound");
  statements.push(
    db
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

export async function ingest(
  db: ArchiveDatabase,
  n: Namespace,
  expected: Checkpoint,
  logs: readonly ArchiveLog[],
  headers: readonly BlockHeader[],
): Promise<void> {
  const blocks = validateHeaders(expected, headers);
  const final = blocks.at(-1)!;
  const statements: D1PreparedStatement[] = [
    commitStatement(db, n, expected, "ingest", expected.nextBlock, final.number),
  ];
  for (const block of blocks)
    statements.push(
      db
        .prepare("INSERT INTO canonical_blocks VALUES(?,?,?,?,?)")
        .bind(n.chainId, n.pool, block.number, hash32(block.hash), hash32(block.parentHash)),
    );
  appendEventStatements(db, n, blocks, logs, statements);
  statements.push(
    db
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
  await db.batch(statements);
}
