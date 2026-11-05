/** Node-only SQL snapshot sealing and restoration. */
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { D1Archive } from "../src/archive.ts";
import { validateNamespace, type Namespace } from "../src/domain.ts";
import { exportArchive } from "./retained-export.mts";
import {
  createTemp,
  digest,
  json,
  migrations,
  migrate,
  namespaceFromRow,
  publish,
  sameNamespace,
  sql,
  stable,
  tables,
  validateStoredCheckpoint,
  VERSION,
  SqliteD1,
} from "./retained-support.mts";

async function verifyCanonicalDerivedRows(db: DatabaseSync, namespace: Namespace) {
  const retained = exportArchive(db, namespace);
  const rebuilt = migrate(":memory:");
  try {
    const archive = new D1Archive(new SqliteD1(rebuilt));
    await archive.initialize(namespace, retained.payload.deploymentParentHash);
    await archive.ingest(
      namespace,
      await archive.status(namespace),
      retained.payload.logs,
      retained.payload.headers,
    );
    for (const table of ["node_versions", "slot_versions", "draws"]) {
      const rows = (database: DatabaseSync) =>
        (
          database
            .prepare(`SELECT * FROM ${table} WHERE chain_id=? AND pool=?`)
            .all(namespace.chainId, namespace.pool) as Record<string, unknown>[]
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
export async function verifyRestoredArchive(db: DatabaseSync, namespace: Namespace) {
  const archive = new D1Archive(new SqliteD1(db));
  await archive.assertNamespace(namespace);
  if (
    (db.prepare("PRAGMA integrity_check").get() as Record<string, unknown>).integrity_check !== "ok"
  )
    throw new Error("SQLite integrity check failed");
  await verifyCanonicalDerivedRows(db, namespace);
  const draws = db
    .prepare("SELECT draw_id FROM draws WHERE chain_id=? AND pool=?")
    .all(namespace.chainId, namespace.pool) as Record<string, unknown>[];
  const owners = db
    .prepare("SELECT DISTINCT account FROM slot_versions WHERE chain_id=? AND pool=?")
    .all(namespace.chainId, namespace.pool) as Record<string, unknown>[];
  for (const draw of draws)
    for (const owner of owners) {
      const proof = await archive.proof(namespace, String(draw.draw_id), String(owner.account));
      if (proof && proof.siblingHashes.length !== namespace.depth)
        throw new Error("invalid proof depth");
    }
}
export function writeSqlSnapshot(
  source: string,
  destination: string,
  manifestPath: string,
  supplied: Namespace,
) {
  const namespace = validateNamespace(supplied);
  const db = new DatabaseSync(source, { readOnly: true });
  db.exec("BEGIN");
  try {
    const stored = db
      .prepare("SELECT * FROM namespaces WHERE chain_id=? AND pool=?")
      .get(namespace.chainId, namespace.pool) as Record<string, unknown> | undefined;
    if (!stored || !sameNamespace(namespaceFromRow(stored), namespace))
      throw new Error("source namespace mismatch");
    validateStoredCheckpoint(db, namespace);
    const lines = [
      "PRAGMA foreign_keys=ON;",
      readFileSync(new URL("0001_proof_archive.sql", migrations), "utf8"),
      "DROP TRIGGER require_current_revision;",
    ];
    for (const table of tables)
      for (const row of db
        .prepare(`SELECT * FROM ${table} WHERE chain_id=? AND pool=?`)
        .all(namespace.chainId, namespace.pool) as Record<string, unknown>[]) {
        const keys = Object.keys(row);
        lines.push(
          `INSERT INTO ${table}(${keys.join(",")}) VALUES(${keys.map((key) => sql(row[key])).join(",")});`,
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
        namespace,
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
  const namespace = validateNamespace(supplied);
  const body = readFileSync(sqlPath, "utf8");
  const trusted = JSON.parse(readFileSync(trustedPath, "utf8"));
  if (
    trusted.version !== VERSION ||
    trusted.sha256 !== digest(body) ||
    !sameNamespace(trusted.namespace, namespace)
  )
    throw new Error("trusted SQL snapshot mismatch");
  const temporary = createTemp(target);
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(temporary);
    db.exec(body);
    const row = db
      .prepare("SELECT * FROM namespaces WHERE chain_id=? AND pool=?")
      .get(namespace.chainId, namespace.pool) as Record<string, unknown> | undefined;
    if (!row || !sameNamespace(namespaceFromRow(row), namespace))
      throw new Error("invalid SQL snapshot");
    validateStoredCheckpoint(db, namespace);
    await verifyRestoredArchive(db, namespace);
    db.close();
    db = undefined;
    publish(temporary, target);
  } catch (error) {
    db?.close();
    rmSync(temporary, { force: true });
    throw error;
  }
}
