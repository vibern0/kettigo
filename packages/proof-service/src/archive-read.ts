import {
  branchHash,
  checksum,
  decimal,
  hash32,
  leafHash,
  type Namespace,
  type Node,
} from "./domain.ts";
import type { ArchiveDatabase, Draw, Proof } from "./archive.ts";

const before = "(block_number<? OR (block_number=? AND log_index<?))";
const drawQuery =
  "SELECT d.*,b.block_hash FROM draws d JOIN canonical_blocks b ON b.chain_id=d.chain_id AND b.pool=d.pool AND b.block_number=d.close_block_number WHERE d.chain_id=? AND d.pool=?";

export function draw(n: Namespace, row: Record<string, unknown>): Draw {
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

export async function listDraws(
  db: ArchiveDatabase,
  n: Namespace,
  cursor?: string,
  limit = 20,
): Promise<Draw[]> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("invalid limit");
  const c = cursor === undefined ? undefined : decimal(cursor, "cursor");
  const predicate =
    c === undefined
      ? ""
      : " AND (length(d.draw_id)<length(?) OR (length(d.draw_id)=length(?) AND d.draw_id<?))";
  const query = `${drawQuery}${predicate} ORDER BY length(d.draw_id) DESC,d.draw_id DESC LIMIT ?`;
  const result =
    c === undefined
      ? await db.prepare(query).bind(n.chainId, n.pool, limit).all<Record<string, unknown>>()
      : await db
          .prepare(query)
          .bind(n.chainId, n.pool, c, c, c, limit)
          .all<Record<string, unknown>>();
  return result.results.map((row) => draw(n, row));
}

export async function drawById(
  db: ArchiveDatabase,
  n: Namespace,
  drawId: string,
): Promise<Draw | null> {
  const row = await db
    .prepare(`${drawQuery} AND d.draw_id=?`)
    .bind(n.chainId, n.pool, decimal(drawId, "draw id"))
    .first<Record<string, unknown>>();
  return row ? draw(n, row) : null;
}

function nodeQuery(
  db: ArchiveDatabase,
  n: Namespace,
  level: number,
  index: bigint,
  drawSnapshot: Draw,
): D1PreparedStatement {
  return db
    .prepare(
      `SELECT hash,sum_handle FROM node_versions WHERE chain_id=? AND pool=? AND level=? AND node_index=? AND ${before} ORDER BY block_number DESC,log_index DESC LIMIT 1`,
    )
    .bind(
      n.chainId,
      n.pool,
      level,
      index.toString(),
      drawSnapshot.closeBlockNumber,
      drawSnapshot.closeBlockNumber,
      drawSnapshot.closeLogIndex,
    );
}

type HistoricalSlot = Record<string, unknown>;
type PathLevel = { node: Node; sibling?: Node };

function resultNode(
  result: D1Result<unknown> | undefined,
  n: Namespace,
  level: number,
  required: boolean,
): Node {
  const row = result?.results[0] as Record<string, unknown> | undefined;
  if (row) return { hash: String(row.hash), sum: String(row.sum_handle) };
  if (required) throw new Error("node history unavailable");
  return { hash: n.emptyHashes.at(level)!, sum: n.zero };
}

async function nodePath(
  db: ArchiveDatabase,
  n: Namespace,
  slot: HistoricalSlot,
  drawSnapshot: Draw,
) {
  let index = BigInt(String(slot.slot_index));
  const queries: D1PreparedStatement[] = [];
  for (let level = 0; level <= n.depth; level += 1) {
    queries.push(nodeQuery(db, n, level, index, drawSnapshot));
    if (level < n.depth) queries.push(nodeQuery(db, n, level, index ^ 1n, drawSnapshot));
    index >>= 1n;
  }
  const results = await db.batch(queries);
  let position = 0;
  const levels: PathLevel[] = [];
  for (let level = 0; level <= n.depth; level += 1) {
    const current = results[position++];
    const sibling = level < n.depth ? resultNode(results[position++], n, level, false) : undefined;
    levels.push({
      node: resultNode(current, n, level, true),
      sibling,
    });
  }
  return levels;
}

function authenticatePath(
  path: readonly PathLevel[],
  n: Namespace,
  slot: HistoricalSlot,
  owner: ReturnType<typeof checksum>,
  drawSnapshot: Draw,
): Pick<Proof, "balance" | "siblingHashes" | "siblingSums" | "parentSums"> {
  let index = BigInt(String(slot.slot_index));
  let current = path[0]!.node;
  if (current.hash !== leafHash(owner, String(slot.generation), current.sum))
    throw new Error("leaf mismatch");
  const balance = current.sum;
  const siblingHashes: string[] = [];
  const siblingSums: string[] = [];
  const parentSums: string[] = [];
  for (let level = 0; level < n.depth; level += 1) {
    const sibling = path[level]!.sibling!;
    const parent = path[level + 1]!.node;
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
  if (current.hash !== drawSnapshot.rootHash || current.sum !== drawSnapshot.rootSum)
    throw new Error("root mismatch");
  return { balance, siblingHashes, siblingSums, parentSums };
}

function slotAt(
  db: ArchiveDatabase,
  n: Namespace,
  account: string,
  drawSnapshot: Draw,
): Promise<HistoricalSlot | null> {
  return db
    .prepare(
      `SELECT * FROM slot_versions WHERE chain_id=? AND pool=? AND account=? AND ${before} ORDER BY block_number DESC,log_index DESC LIMIT 1`,
    )
    .bind(
      n.chainId,
      n.pool,
      account,
      drawSnapshot.closeBlockNumber,
      drawSnapshot.closeBlockNumber,
      drawSnapshot.closeLogIndex,
    )
    .first<HistoricalSlot>();
}

function slotOccupantAt(
  db: ArchiveDatabase,
  n: Namespace,
  slot: HistoricalSlot,
  drawSnapshot: Draw,
): Promise<HistoricalSlot | null> {
  return db
    .prepare(
      `SELECT * FROM slot_versions WHERE chain_id=? AND pool=? AND slot_index=? AND ${before} ORDER BY block_number DESC,log_index DESC LIMIT 1`,
    )
    .bind(
      n.chainId,
      n.pool,
      String(slot.slot_index),
      drawSnapshot.closeBlockNumber,
      drawSnapshot.closeBlockNumber,
      drawSnapshot.closeLogIndex,
    )
    .first<HistoricalSlot>();
}

export async function proof(
  db: ArchiveDatabase,
  n: Namespace,
  drawId: string,
  account: string,
): Promise<Proof | null> {
  const row = await db
    .prepare(`${drawQuery} AND d.draw_id=?`)
    .bind(n.chainId, n.pool, decimal(drawId))
    .first<Record<string, unknown>>();
  if (!row) return null;
  const drawSnapshot = draw(n, row);
  const owner = checksum(account);
  const slot = await slotAt(db, n, owner, drawSnapshot);
  if (!slot || Number(slot.assigned) !== 1) return null;
  if (BigInt(String(slot.slot_index)) >= BigInt(drawSnapshot.upperBound)) return null;
  const occupant = await slotOccupantAt(db, n, slot, drawSnapshot);
  if (
    !occupant ||
    Number(occupant.assigned) !== 1 ||
    occupant.account !== owner ||
    occupant.generation !== slot.generation
  )
    throw new Error("ownership history unavailable");
  const path = await nodePath(db, n, slot, drawSnapshot);
  const proofPath = authenticatePath(path, n, slot, owner, drawSnapshot);
  return {
    ...drawSnapshot,
    account: owner,
    index: String(slot.slot_index),
    generation: String(slot.generation),
    ...proofPath,
  };
}
