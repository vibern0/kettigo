import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { D1Archive } from "../src/archive.ts";
import type { Namespace } from "../src/domain.ts";
import type { RpcSource } from "../src/ingest.ts";
import { initializeArchiveForTick } from "../src/worker.ts";
import { depth32Fixture, zero } from "../tests/fixtures.ts";
import {
  SqliteD1,
  exportArchive,
  migrate,
  restoreCanonical,
  restoreSqlSnapshot,
  writeSqlSnapshot,
} from "./replay-retained.mts";

function repairedFixtureRpc(
  namespace: Namespace,
  block: ReturnType<typeof depth32Fixture>["block"],
): RpcSource {
  const parent = { number: 0, hash: zero, parentHash: zero };
  return {
    chainId: async () => namespace.chainId,
    finalizedHead: async () => ({ number: block.number, hash: block.hash }),
    latestHead: async () => block,
    block: async (number) => (number === 0 ? parent : block),
    logs: async () => [],
    receiptLogs: async () => [],
    drawSnapshot: async () => {
      throw new Error("unused");
    },
    membershipRoot: async () => ({ hash: namespace.emptyHashes[namespace.depth], sum: zero }),
  };
}

export async function createRepairedArchive(directory: string) {
  const { namespace, block, logs } = depth32Fixture();
  const source = join(directory, "repaired.sqlite");
  const db = migrate(source);
  db.prepare("INSERT INTO namespaces VALUES(?,?,?,?,?,?)").run(
    namespace.chainId,
    namespace.pool,
    namespace.depth,
    namespace.zero,
    JSON.stringify(namespace.emptyHashes),
    namespace.deploymentBlock,
  );
  db.prepare("INSERT INTO ingestion_state VALUES(?,?,?,?,?,?,?,?)").run(
    namespace.chainId,
    namespace.pool,
    namespace.deploymentBlock,
    0,
    zero,
    0,
    null,
    new Date().toISOString(),
  );
  const archive = new D1Archive(new SqliteD1(db));
  await initializeArchiveForTick(archive, namespace, repairedFixtureRpc(namespace, block));
  await archive.ingest(namespace, await archive.status(namespace), logs, [block]);
  return { archive, db, namespace, source };
}

export async function restoreRepairedArchive(
  directory: string,
  source: string,
  db: DatabaseSync,
  namespace: Namespace,
) {
  const retained = exportArchive(db, namespace);
  const canonical = join(directory, "canonical.json");
  const manifest = join(directory, "canonical.manifest.json");
  const sql = join(directory, "repaired.sql");
  const sqlManifest = join(directory, "repaired.sql.manifest.json");
  writeFileSync(canonical, JSON.stringify(retained));
  writeFileSync(manifest, JSON.stringify(retained.manifest));
  writeSqlSnapshot(source, sql, sqlManifest, namespace);
  db.close();
  const canonicalTarget = join(directory, "canonical.sqlite");
  const sqlTarget = join(directory, "sql.sqlite");
  await restoreCanonical(canonical, manifest, canonicalTarget, namespace);
  await restoreSqlSnapshot(sql, sqlManifest, sqlTarget, namespace);
  return {
    checkpoint: retained.manifest.checkpoint,
    archives: [canonicalTarget, sqlTarget].map(
      (target) => new D1Archive(new SqliteD1(new DatabaseSync(target, { readOnly: true }))),
    ),
  };
}
