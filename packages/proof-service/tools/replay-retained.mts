/** Node 24-only archive recovery tool. This module is never bundled into the Worker. */
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  linkSync,
  openSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { D1Archive, type ArchiveDatabase, type BlockHeader } from "../src/archive.ts";
import {
  checksum,
  hash32,
  validateNamespace,
  type ArchiveLog,
  type Namespace,
} from "../src/domain.ts";

const migrations = new URL("../migrations/", import.meta.url);
const VERSION = 2;
const digest = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");
const json = (v: unknown) => JSON.stringify(v);
const stable = (v: unknown): string =>
  Array.isArray(v)
    ? `[${v.map(stable).join(",")}]`
    : v && typeof v === "object"
      ? `{${Object.keys(v as Record<string, unknown>)
          .sort()
          .map((key) => `${JSON.stringify(key)}:${stable((v as Record<string, unknown>)[key])}`)
          .join(",")}}`
      : JSON.stringify(v);
const tables = [
  "namespaces",
  "canonical_blocks",
  "event_logs",
  "node_versions",
  "slot_versions",
  "draws",
  "ingestion_state",
  "ingestion_commits",
];

export class SqliteD1 implements ArchiveDatabase {
  constructor(readonly sqlite: DatabaseSync) {}
  prepare(sql: string) {
    const state: { values: unknown[] } = { values: [] };
    const statement = {
      __sql: sql,
      bind: (...values: unknown[]) => {
        state.values = values;
        return statement;
      },
      run: async () => this.sqlite.prepare(sql).run(...state.values),
      first: async <T,>() =>
        (this.sqlite.prepare(sql).get(...state.values) as T | undefined) ?? null,
      all: async <T,>() => ({ results: this.sqlite.prepare(sql).all(...state.values) as T[] }),
    };
    return statement as unknown as D1PreparedStatement;
  }
  async batch(statements: D1PreparedStatement[]) {
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const results: D1Result[] = [];
      for (const statement of statements) {
        const sql = (statement as unknown as { __sql?: string }).__sql?.trimStart().toUpperCase();
        results.push(sql?.startsWith("SELECT") ? await statement.all() : await statement.run());
      }
      this.sqlite.exec("COMMIT");
      return results;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }
}

type Manifest = {
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
type Retained = {
  manifest: Manifest;
  payload: {
    namespace: Namespace;
    deploymentParentHash: string;
    headers: BlockHeader[];
    logs: ArchiveLog[];
    checkpoint: Record<string, unknown>;
  };
};
const sameNamespace = (a: Namespace, b: Namespace) =>
  stable(validateNamespace(a)) === stable(validateNamespace(b));

function namespaceFromRow(row: Record<string, unknown>): Namespace {
  return validateNamespace({
    chainId: String(row.chain_id),
    pool: checksum(String(row.pool)),
    depth: Number(row.depth),
    zero: String(row.zero_handle),
    emptyHashes: JSON.parse(String(row.empty_hashes_json)),
    deploymentBlock: Number(row.deployment_block),
  });
}
function checkpointInfo(row: Record<string, unknown>) {
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
function validateStoredCheckpoint(db: DatabaseSync, n: Namespace) {
  const state = db
    .prepare("SELECT * FROM ingestion_state WHERE chain_id=? AND pool=?")
    .get(n.chainId, n.pool) as Record<string, unknown> | undefined;
  const blocks = db
    .prepare(
      "SELECT block_number,block_hash,parent_hash FROM canonical_blocks WHERE chain_id=? AND pool=? ORDER BY block_number",
    )
    .all(n.chainId, n.pool) as Record<string, unknown>[];
  if (!state || blocks.length < 2) throw new Error("incomplete archive");
  const checkpoint = checkpointInfo(state);
  for (let i = 1; i < blocks.length; i++) {
    if (
      Number(blocks[i].block_number) !== Number(blocks[i - 1].block_number) + 1 ||
      hash32(blocks[i].parent_hash) !== hash32(blocks[i - 1].block_hash)
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

export function exportArchive(db: DatabaseSync, supplied: Namespace): Retained {
  const namespace = validateNamespace(supplied);
  db.exec("BEGIN");
  try {
    const storedNamespace = db
      .prepare("SELECT * FROM namespaces WHERE chain_id=? AND pool=?")
      .get(namespace.chainId, namespace.pool) as Record<string, unknown> | undefined;
    if (!storedNamespace || !sameNamespace(namespaceFromRow(storedNamespace), namespace))
      throw new Error("source namespace mismatch");
    const rows = db
      .prepare(
        "SELECT block_number,block_hash,parent_hash FROM canonical_blocks WHERE chain_id=? AND pool=? ORDER BY block_number",
      )
      .all(namespace.chainId, namespace.pool) as Record<string, unknown>[];
    if (rows.length < 2) throw new Error("incomplete archive");
    const checkpoint = validateStoredCheckpoint(db, namespace);
    const anchor = rows.find((r) => Number(r.block_number) === namespace.deploymentBlock - 1);
    const headers = rows
      .filter((r) => Number(r.block_number) >= namespace.deploymentBlock)
      .map((r) => ({
        number: Number(r.block_number),
        hash: String(r.block_hash),
        parentHash: String(r.parent_hash),
      }));
    if (!anchor) throw new Error("missing deployment parent anchor");
    const headersByBlock = new Map(headers.map((h) => [h.number, h]));
    const logs = (
      db
        .prepare(
          "SELECT block_number,log_index,payload_json FROM event_logs WHERE chain_id=? AND pool=? ORDER BY block_number,log_index",
        )
        .all(namespace.chainId, namespace.pool) as Record<string, unknown>[]
    ).map((r) => {
      const header = headersByBlock.get(Number(r.block_number));
      if (!header) throw new Error("event without canonical header");
      const payload = JSON.parse(String(r.payload_json)) as Pick<ArchiveLog, "name" | "args">;
      return {
        blockNumber: Number(r.block_number),
        blockHash: header.hash,
        logIndex: Number(r.log_index),
        ...payload,
      };
    });
    const payload = {
      namespace,
      deploymentParentHash: String(anchor.block_hash),
      headers,
      logs,
      checkpoint,
    };
    const manifest = {
      version: VERSION,
      exportedAt: new Date().toISOString(),
      sha256: digest(json(payload)),
      namespace,
      headers: headers.length,
      logs: logs.length,
      firstBlock: headers[0].number,
      lastBlock: headers.at(-1)!.number,
      checkpoint,
    };
    db.exec("COMMIT");
    return { manifest, payload };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function validate(exported: Retained, trusted: Manifest, supplied: Namespace) {
  const n = validateNamespace(supplied),
    { headers, logs } = exported.payload;
  if (
    exported.manifest.version !== VERSION ||
    trusted.version !== VERSION ||
    exported.manifest.sha256 !== digest(json(exported.payload)) ||
    trusted.sha256 !== exported.manifest.sha256
  )
    throw new Error("retained export digest mismatch");
  if (
    !sameNamespace(n, exported.payload.namespace) ||
    !sameNamespace(n, exported.manifest.namespace) ||
    !sameNamespace(n, trusted.namespace) ||
    stable(trusted) !== stable(exported.manifest)
  )
    throw new Error("trusted manifest or namespace mismatch");
  if (
    !headers.length ||
    headers.length !== exported.manifest.headers ||
    logs.length !== exported.manifest.logs
  )
    throw new Error("retained export row count mismatch");
  if (
    exported.manifest.firstBlock !== n.deploymentBlock ||
    exported.manifest.lastBlock !== headers.at(-1)!.number ||
    stable(exported.manifest.checkpoint) !== stable(exported.payload.checkpoint)
  )
    throw new Error("retained export range mismatch");
  let lastBlock = -1,
    lastLog = -1;
  for (let i = 0; i < headers.length; i++) {
    const h = headers[i];
    if (
      h.number !== n.deploymentBlock + i ||
      hash32(h.parentHash) !==
        (i ? hash32(headers[i - 1].hash) : hash32(exported.payload.deploymentParentHash))
    )
      throw new Error("retained header continuity mismatch");
  }
  for (const log of logs) {
    if (
      !Number.isSafeInteger(log.logIndex) ||
      log.logIndex < 0 ||
      log.blockNumber < lastBlock ||
      (log.blockNumber === lastBlock && log.logIndex <= lastLog) ||
      headers[log.blockNumber - n.deploymentBlock]?.hash !== log.blockHash
    )
      throw new Error("retained log identity mismatch");
    lastBlock = log.blockNumber;
    lastLog = log.logIndex;
  }
  const state = checkpointInfo(exported.payload.checkpoint);
  if (
    state.nextBlock !== headers.at(-1)!.number + 1 ||
    state.lastFinalizedBlock !== headers.at(-1)!.number ||
    state.lastFinalizedHash !== hash32(headers.at(-1)!.hash)
  )
    throw new Error("retained checkpoint mismatch");
}
function migrate(path: string) {
  const db = new DatabaseSync(path);
  for (const name of ["0001_proof_archive.sql", "0002_checkpoint_state.sql"])
    db.exec(readFileSync(new URL(name, migrations), "utf8"));
  return db;
}
const temp = (target: string) =>
  `${target}.restore-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`;
function createTemp(target: string) {
  const path = temp(target);
  const fd = openSync(path, "wx");
  closeSync(fd);
  return path;
}
function publish(from: string, to: string) {
  // link(2) is atomic and fails if a racing writer created the target.
  linkSync(from, to);
  unlinkSync(from);
}
async function verifyCanonicalDerivedRows(db: DatabaseSync, n: Namespace) {
  // Event logs are the retained canonical source. Rebuild their derived projection in an
  // isolated database so a sealed SQL snapshot cannot omit rows that proof() would skip.
  const retained = exportArchive(db, n);
  const rebuilt = migrate(":memory:");
  try {
    const archive = new D1Archive(new SqliteD1(rebuilt));
    await archive.initialize(n, retained.payload.deploymentParentHash);
    await archive.ingest(
      n,
      await archive.status(n),
      retained.payload.logs,
      retained.payload.headers,
    );
    for (const table of ["node_versions", "slot_versions", "draws"]) {
      const rows = (database: DatabaseSync) =>
        (
          database
            .prepare(`SELECT * FROM ${table} WHERE chain_id=? AND pool=?`)
            .all(n.chainId, n.pool) as Record<string, unknown>[]
        )
          .map(stable)
          .sort();
      if (stable(rows(db)) !== stable(rows(rebuilt)))
        throw new Error(`canonical derived ${table} mismatch`);
    }
  } finally {
    rebuilt.close();
  }
}
async function verify(db: DatabaseSync, n: Namespace) {
  const archive = new D1Archive(new SqliteD1(db));
  await archive.assertNamespace(n);
  if (
    (db.prepare("PRAGMA integrity_check").get() as Record<string, unknown>).integrity_check !== "ok"
  )
    throw new Error("SQLite integrity check failed");
  await verifyCanonicalDerivedRows(db, n);
  const draws = db
    .prepare("SELECT draw_id FROM draws WHERE chain_id=? AND pool=?")
    .all(n.chainId, n.pool) as Record<string, unknown>[];
  const owners = db
    .prepare("SELECT DISTINCT account FROM slot_versions WHERE chain_id=? AND pool=?")
    .all(n.chainId, n.pool) as Record<string, unknown>[];
  for (const draw of draws)
    for (const owner of owners) {
      const proof = await archive.proof(n, String(draw.draw_id), String(owner.account));
      if (proof && proof.siblingHashes.length !== n.depth) throw new Error("invalid proof depth");
    }
}
export async function restoreCanonical(
  exportPath: string,
  trustedManifestPath: string,
  target: string,
  supplied: Namespace,
) {
  if (existsSync(target)) throw new Error("restore target already exists");
  const exported = JSON.parse(readFileSync(exportPath, "utf8")) as Retained,
    trusted = JSON.parse(readFileSync(trustedManifestPath, "utf8")) as Manifest,
    n = validateNamespace(supplied);
  validate(exported, trusted, n);
  const tmp = createTemp(target);
  let db: DatabaseSync | undefined;
  try {
    db = migrate(tmp);
    const archive = new D1Archive(new SqliteD1(db));
    await archive.initialize(n, exported.payload.deploymentParentHash);
    await archive.ingest(
      n,
      await archive.status(n),
      exported.payload.logs,
      exported.payload.headers,
    );
    const expected = checkpointInfo(exported.payload.checkpoint);
    let rebuilt = await archive.status(n);
    if (
      rebuilt.nextBlock !== expected.nextBlock ||
      rebuilt.lastFinalizedBlock !== expected.lastFinalizedBlock ||
      rebuilt.lastFinalizedHash !== expected.lastFinalizedHash
    )
      throw new Error("replayed checkpoint mismatch");
    if (expected.disabledReason)
      rebuilt = await archive.disable(n, rebuilt, expected.disabledReason);
    if ((rebuilt.disabledReason ?? null) !== expected.disabledReason)
      throw new Error("replayed disabled state mismatch");
    await verify(db, n);
    db.close();
    db = undefined;
    publish(tmp, target);
  } catch (error) {
    db?.close();
    rmSync(tmp, { force: true });
    throw error;
  }
}
const sql = (v: unknown) =>
  v === null ? "NULL" : typeof v === "number" ? String(v) : `'${String(v).replaceAll("'", "''")}'`;
export function writeSqlSnapshot(
  source: string,
  destination: string,
  manifestPath: string,
  supplied: Namespace,
) {
  const n = validateNamespace(supplied),
    db = new DatabaseSync(source, { readOnly: true });
  db.exec("BEGIN");
  try {
    const stored = db
      .prepare("SELECT * FROM namespaces WHERE chain_id=? AND pool=?")
      .get(n.chainId, n.pool) as Record<string, unknown> | undefined;
    if (!stored || !sameNamespace(namespaceFromRow(stored), n))
      throw new Error("source namespace mismatch");
    validateStoredCheckpoint(db, n);
    const lines = [
      "PRAGMA foreign_keys=ON;",
      readFileSync(new URL("0001_proof_archive.sql", migrations), "utf8"),
      "DROP TRIGGER require_current_revision;",
    ];
    for (const table of tables)
      for (const row of db
        .prepare(`SELECT * FROM ${table} WHERE chain_id=? AND pool=?`)
        .all(n.chainId, n.pool) as Record<string, unknown>[]) {
        const keys = Object.keys(row);
        lines.push(
          `INSERT INTO ${table}(${keys.join(",")}) VALUES(${keys.map((k) => sql(row[k])).join(",")});`,
        );
      }
    lines.push(
      readFileSync(new URL("0002_checkpoint_state.sql", migrations), "utf8").replace(
        "DROP TRIGGER require_current_revision;",
        "DROP TRIGGER IF EXISTS require_current_revision;",
      ),
    );
    const body = `${lines.join("\n")}\n`;
    writeFileSync(destination, body);
    writeFileSync(
      manifestPath,
      json({
        version: VERSION,
        exportedAt: new Date().toISOString(),
        sha256: digest(body),
        namespace: n,
      }),
    );
  } finally {
    db.exec("ROLLBACK");
    db.close();
  }
}
export async function restoreSqlSnapshot(
  sqlPath: string,
  trustedPath: string,
  target: string,
  supplied: Namespace,
) {
  if (existsSync(target)) throw new Error("restore target already exists");
  const n = validateNamespace(supplied),
    body = readFileSync(sqlPath, "utf8"),
    trusted = JSON.parse(readFileSync(trustedPath, "utf8"));
  if (
    trusted.version !== VERSION ||
    trusted.sha256 !== digest(body) ||
    !sameNamespace(trusted.namespace, n)
  )
    throw new Error("trusted SQL snapshot mismatch");
  const tmp = createTemp(target);
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(tmp);
    db.exec(body);
    const row = db
      .prepare("SELECT * FROM namespaces WHERE chain_id=? AND pool=?")
      .get(n.chainId, n.pool) as Record<string, unknown> | undefined;
    if (
      !row ||
      Number(row.depth) !== n.depth ||
      String(row.zero_handle) !== n.zero ||
      String(row.empty_hashes_json) !== json(n.emptyHashes) ||
      Number(row.deployment_block) !== n.deploymentBlock
    )
      throw new Error("invalid SQL snapshot");
    validateStoredCheckpoint(db, n);
    await verify(db, n);
    db.close();
    db = undefined;
    publish(tmp, target);
  } catch (error) {
    db?.close();
    rmSync(tmp, { force: true });
    throw error;
  }
}

if (import.meta.main) {
  const [command, ...args] = process.argv.slice(2);
  if (command === "seal-sql") {
    const [source, manifest, namespacePath] = args;
    if (!source || !manifest || !namespacePath)
      throw new Error(
        "usage: replay-retained.mts seal-sql retained.sql trusted.sql.manifest.json namespace.json",
      );
    const namespace = validateNamespace(JSON.parse(readFileSync(namespacePath, "utf8")));
    writeFileSync(
      manifest,
      json({
        version: VERSION,
        exportedAt: new Date().toISOString(),
        sha256: digest(readFileSync(source)),
        namespace,
      }),
    );
  } else if (command === "export") {
    const [source, output, manifest, chainId, pool] = args;
    if (!source || !output || !manifest || !chainId || !pool)
      throw new Error(
        "usage: replay-retained.mts export source.sqlite canonical.json manifest.json chainId checksumPool",
      );
    const db = new DatabaseSync(source, { readOnly: true });
    try {
      const row = db
        .prepare("SELECT * FROM namespaces WHERE chain_id=? AND pool=?")
        .get(chainId, checksum(pool)) as Record<string, unknown> | undefined;
      if (!row) throw new Error("namespace not found");
      const retained = exportArchive(db, namespaceFromRow(row));
      writeFileSync(output, json(retained));
      writeFileSync(manifest, json(retained.manifest));
    } finally {
      db.close();
    }
  } else if (command === "restore-canonical") {
    const [source, manifest, target, namespacePath] = args;
    if (!source || !manifest || !target || !namespacePath)
      throw new Error(
        "usage: replay-retained.mts restore-canonical canonical.json trusted.manifest.json new.sqlite namespace.json",
      );
    await restoreCanonical(
      source,
      manifest,
      target,
      JSON.parse(readFileSync(namespacePath, "utf8")),
    );
  } else if (command === "restore-sql") {
    const [source, manifest, target, namespacePath] = args;
    if (!source || !manifest || !target || !namespacePath)
      throw new Error(
        "usage: replay-retained.mts restore-sql snapshot.sql trusted.manifest.json new.sqlite namespace.json",
      );
    await restoreSqlSnapshot(
      source,
      manifest,
      target,
      JSON.parse(readFileSync(namespacePath, "utf8")),
    );
  } else
    throw new Error("usage: replay-retained.mts <seal-sql|export|restore-canonical|restore-sql> …");
}
