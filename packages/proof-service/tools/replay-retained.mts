/** Node 24-only archive recovery command and stable public tool entry point. */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { D1Archive } from "../src/archive.ts";
import { checksum, validateNamespace, type Namespace } from "../src/domain.ts";
import { exportArchive } from "./retained-export.mts";
import { validateRetained } from "./retained-validate.mts";
import {
  createTemp,
  json,
  migrate,
  publish,
  SqliteD1,
  type Manifest,
  type Retained,
} from "./retained-support.mts";
import {
  restoreSqlSnapshot,
  verifyRestoredArchive,
  writeSqlSnapshot,
} from "./retained-snapshot.mts";

export { exportArchive, migrate, restoreSqlSnapshot, SqliteD1, writeSqlSnapshot };

export async function restoreCanonical(
  exportPath: string,
  trustedManifestPath: string,
  target: string,
  supplied: Namespace,
) {
  if (existsSync(target)) throw new Error("restore target already exists");
  const exported = JSON.parse(readFileSync(exportPath, "utf8")) as Retained;
  const trusted = JSON.parse(readFileSync(trustedManifestPath, "utf8")) as Manifest;
  const namespace = validateNamespace(supplied);
  validateRetained(exported, trusted, namespace);
  const temporary = createTemp(target);
  let db: DatabaseSync | undefined;
  try {
    db = migrate(temporary);
    const archive = new D1Archive(new SqliteD1(db));
    await archive.initialize(namespace, exported.payload.deploymentParentHash);
    await archive.ingest(
      namespace,
      await archive.status(namespace),
      exported.payload.logs,
      exported.payload.headers,
    );
    const expected = exported.payload.checkpoint;
    let rebuilt = await archive.status(namespace);
    if (
      rebuilt.nextBlock !== Number(expected.nextBlock) ||
      rebuilt.lastFinalizedBlock !== Number(expected.lastFinalizedBlock) ||
      rebuilt.lastFinalizedHash !== String(expected.lastFinalizedHash)
    )
      throw new Error("replayed checkpoint mismatch");
    if (expected.disabledReason)
      rebuilt = await archive.disable(namespace, rebuilt, String(expected.disabledReason));
    if ((rebuilt.disabledReason ?? null) !== expected.disabledReason)
      throw new Error("replayed disabled state mismatch");
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
        version: 2,
        exportedAt: new Date().toISOString(),
        sha256: createHash("sha256").update(readFileSync(source)).digest("hex"),
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
      const namespace = validateNamespace({
        chainId: String(row.chain_id),
        pool: checksum(String(row.pool)),
        depth: Number(row.depth),
        zero: String(row.zero_handle),
        emptyHashes: JSON.parse(String(row.empty_hashes_json)),
        deploymentBlock: Number(row.deployment_block),
      });
      const retained = exportArchive(db, namespace);
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
  } else {
    throw new Error("usage: replay-retained.mts <seal-sql|export|restore-canonical|restore-sql> …");
  }
}
