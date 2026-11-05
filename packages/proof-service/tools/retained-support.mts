/** Shared Node-only primitives for retained archive export and restore. */
import { createHash } from "node:crypto";
import { closeSync, linkSync, openSync, readFileSync, unlinkSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { type ArchiveDatabase } from "../src/archive.ts";
import { checksum, hash32, validateNamespace, type Namespace } from "../src/domain.ts";

export const migrations = new URL("../migrations/", import.meta.url);
export const VERSION = 2;
export const digest = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
export const json = (value: unknown) => JSON.stringify(value);
export const stable = (value: unknown): string =>
  Array.isArray(value)
    ? `[${value.map(stable).join(",")}]`
    : value && typeof value === "object"
      ? `{${Object.keys(value as Record<string, unknown>)
          .sort()
          .map((key) => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`)
          .join(",")}}`
      : JSON.stringify(value);
export const tables = [
  "namespaces",
  "canonical_blocks",
  "event_logs",
  "node_versions",
  "slot_versions",
  "draws",
  "ingestion_state",
  "ingestion_commits",
];

export type Manifest = {
  version: number;
  exportedAt?: string;
  sha256: string;
  namespace: Namespace;
  headers: number;
  logs: number;
  firstBlock: number;
  lastBlock: number;
  checkpoint: Record<string, unknown>;
};
export type Retained = {
  manifest: Manifest;
  payload: {
    namespace: Namespace;
    deploymentParentHash: string;
    headers: import("../src/archive.ts").BlockHeader[];
    logs: import("../src/domain.ts").ArchiveLog[];
    checkpoint: Record<string, unknown>;
  };
};

export class SqliteD1 implements ArchiveDatabase {
  constructor(readonly sqlite: DatabaseSync) {}
  prepare(sql: string) {
    const state: { values: SQLInputValue[] } = { values: [] };
    const statement = {
      __sql: sql,
      bind: (...values: unknown[]) => {
        state.values = values as SQLInputValue[];
        return statement;
      },
      run: async () => this.sqlite.prepare(sql).run(...state.values),
      first: async <T,>() =>
        (this.sqlite.prepare(sql).get(...state.values) as T | undefined) ?? null,
      all: async <T,>() => ({ results: this.sqlite.prepare(sql).all(...state.values) as T[] }),
    };
    return statement as unknown as D1PreparedStatement;
  }
  async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const results: D1Result<T>[] = [];
      for (const statement of statements) {
        const sql = (statement as unknown as { __sql?: string }).__sql?.trimStart().toUpperCase();
        results.push(
          (sql?.startsWith("SELECT")
            ? await statement.all<T>()
            : await statement.run()) as D1Result<T>,
        );
      }
      this.sqlite.exec("COMMIT");
      return results;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }
}

export const sameNamespace = (left: Namespace, right: Namespace) =>
  stable(validateNamespace(left)) === stable(validateNamespace(right));
export function namespaceFromRow(row: Record<string, unknown>): Namespace {
  return validateNamespace({
    chainId: String(row.chain_id),
    pool: checksum(String(row.pool)),
    depth: Number(row.depth),
    zero: String(row.zero_handle),
    emptyHashes: JSON.parse(String(row.empty_hashes_json)),
    deploymentBlock: Number(row.deployment_block),
  });
}
export function checkpointInfo(row: Record<string, unknown>) {
  const value = {
    nextBlock: Number(row.nextBlock ?? row.next_block),
    lastFinalizedBlock: Number(row.lastFinalizedBlock ?? row.last_finalized_block),
    lastFinalizedHash: hash32(row.lastFinalizedHash ?? row.last_finalized_hash),
    disabledReason:
      (row.disabledReason ?? row.disabled_reason) == null
        ? null
        : String(row.disabledReason ?? row.disabled_reason),
  };
  if (!Number.isSafeInteger(value.nextBlock) || !Number.isSafeInteger(value.lastFinalizedBlock))
    throw new Error("invalid checkpoint");
  return value;
}
export function validateStoredCheckpoint(db: DatabaseSync, namespace: Namespace) {
  const state = db
    .prepare("SELECT * FROM ingestion_state WHERE chain_id=? AND pool=?")
    .get(namespace.chainId, namespace.pool) as Record<string, unknown> | undefined;
  const blocks = db
    .prepare(
      "SELECT block_number,block_hash,parent_hash FROM canonical_blocks WHERE chain_id=? AND pool=? ORDER BY block_number",
    )
    .all(namespace.chainId, namespace.pool) as Record<string, unknown>[];
  if (!state || blocks.length < 2) throw new Error("incomplete archive");
  const checkpoint = checkpointInfo(state);
  for (let index = 1; index < blocks.length; index += 1) {
    if (
      Number(blocks[index].block_number) !== Number(blocks[index - 1].block_number) + 1 ||
      hash32(blocks[index].parent_hash) !== hash32(blocks[index - 1].block_hash)
    )
      throw new Error("source canonical continuity mismatch");
  }
  const final = blocks.at(-1)!;
  if (
    checkpoint.nextBlock !== Number(final.block_number) + 1 ||
    checkpoint.lastFinalizedBlock !== Number(final.block_number) ||
    checkpoint.lastFinalizedHash !== hash32(final.block_hash)
  )
    throw new Error("source checkpoint range mismatch");
  return checkpoint;
}
export function migrate(path: string) {
  const db = new DatabaseSync(path);
  for (const name of ["0001_proof_archive.sql", "0002_checkpoint_state.sql"])
    db.exec(readFileSync(new URL(name, migrations), "utf8"));
  return db;
}
const temporaryPath = (target: string) =>
  `${target}.restore-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`;
export function createTemp(target: string) {
  const path = temporaryPath(target);
  closeSync(openSync(path, "wx"));
  return path;
}
export function publish(from: string, to: string) {
  // link(2) is atomic and fails if a racing writer created the target.
  linkSync(from, to);
  unlinkSync(from);
}
export const sql = (value: unknown) =>
  value === null
    ? "NULL"
    : typeof value === "number"
      ? String(value)
      : `'${String(value).replaceAll("'", "''")}'`;
