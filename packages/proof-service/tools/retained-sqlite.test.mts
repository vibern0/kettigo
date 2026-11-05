import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs, { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { constants, DatabaseSync } from "node:sqlite";
import { D1Archive } from "../src/archive.ts";
import { branchHash, leafHash, type ArchiveLog } from "../src/domain.ts";
import { account, depth32Fixture, otherAccount, zero } from "../tests/fixtures.ts";
import {
  SqliteD1,
  exportArchive,
  restoreCanonical,
  restoreSqlSnapshot,
  writeSqlSnapshot,
} from "./replay-retained.mts";

const migrations = new URL("../migrations/", import.meta.url);
const hex = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

function resign(retained: ReturnType<typeof exportArchive>) {
  retained.manifest.sha256 = sha256(JSON.stringify(retained.payload));
  return retained.manifest;
}

function sealSql(body: string, namespace: ReturnType<typeof depth32Fixture>["namespace"]) {
  return { version: 2, sha256: sha256(body), namespace };
}

async function sourceArchive(path: string) {
  const fixture = depth32Fixture();
  const db = new DatabaseSync(path);
  for (const name of ["0001_proof_archive.sql", "0002_checkpoint_state.sql"])
    db.exec(readFileSync(new URL(name, migrations), "utf8"));
  const archive = new D1Archive(new SqliteD1(db));
  await archive.initialize(fixture.namespace, zero);
  await archive.ingest(fixture.namespace, await archive.status(fixture.namespace), fixture.logs, [
    fixture.block,
  ]);
  // Full exit/reuse/rejoin with real node transitions and a second draw.
  const second = { number: 2, hash: hex(2), parentHash: fixture.block.hash };
  const logs: ArchiveLog[] = [
    {
      blockNumber: 2,
      blockHash: second.hash,
      logIndex: 0,
      name: "SlotReleased" as const,
      args: { account, index: "0", generation: "1" },
    },
    {
      blockNumber: 2,
      blockHash: second.hash,
      logIndex: 1,
      name: "SlotAssigned" as const,
      args: { account: otherAccount, index: "0", generation: "2" },
    },
    {
      blockNumber: 2,
      blockHash: second.hash,
      logIndex: 2,
      name: "SlotAssigned" as const,
      args: { account, index: "1", generation: "1" },
    },
  ];
  let left = { hash: leafHash(otherAccount, "2", zero), sum: zero };
  let right = { hash: leafHash(account, "1", zero), sum: zero };
  logs.push({
    blockNumber: 2,
    blockHash: second.hash,
    logIndex: 3,
    name: "NodeUpdated",
    args: { level: "0", index: "0", hash: left.hash, sum: zero },
  });
  logs.push({
    blockNumber: 2,
    blockHash: second.hash,
    logIndex: 4,
    name: "NodeUpdated",
    args: { level: "0", index: "1", hash: right.hash, sum: zero },
  });
  let parent = { hash: branchHash(left, right), sum: zero };
  logs.push({
    blockNumber: 2,
    blockHash: second.hash,
    logIndex: 5,
    name: "NodeUpdated",
    args: { level: "1", index: "0", hash: parent.hash, sum: zero },
  });
  for (let level = 1; level < 32; level += 1) {
    parent = {
      hash: branchHash(parent, { hash: fixture.namespace.emptyHashes[level], sum: zero }),
      sum: zero,
    };
    logs.push({
      blockNumber: 2,
      blockHash: second.hash,
      logIndex: level + 5,
      name: "NodeUpdated",
      args: { level: String(level + 1), index: "0", hash: parent.hash, sum: zero },
    });
  }
  logs.push({
    blockNumber: 2,
    blockHash: second.hash,
    logIndex: 37,
    name: "DrawSnapshotClosed",
    args: {
      drawId: "2",
      rootHash: parent.hash,
      rootSum: zero,
      ticket: zero,
      upperBound: "2",
      closeBlockNumber: "2",
    },
  });
  await archive.ingest(fixture.namespace, await archive.status(fixture.namespace), logs, [second]);
  return { db, archive, fixture };
}

test("canonical and trusted SQL restores retain the exact depth-32 historical proof", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kettigo-proof-"));
  const sourcePath = join(dir, "source.sqlite");
  const { db, archive, fixture } = await sourceArchive(sourcePath);
  const originals = [
    await archive.proof(fixture.namespace, "1", account),
    await archive.proof(fixture.namespace, "2", account),
    await archive.proof(fixture.namespace, "2", otherAccount),
  ];
  for (const proof of originals) {
    assert.ok(proof);
    assert.equal(proof.siblingHashes.length, 32);
  }
  const exported = exportArchive(db, fixture.namespace);
  const canonical = join(dir, "canonical.json"),
    trusted = join(dir, "canonical.manifest.json");
  writeFileSync(canonical, JSON.stringify(exported));
  writeFileSync(trusted, JSON.stringify(exported.manifest));
  const sql = join(dir, "source.sql"),
    sqlManifest = join(dir, "source.sql.manifest.json");
  writeSqlSnapshot(sourcePath, sql, sqlManifest, fixture.namespace);
  db.close();

  const canonicalTarget = join(dir, "canonical.sqlite");
  await restoreCanonical(canonical, trusted, canonicalTarget, fixture.namespace);
  const canonicalDb = new DatabaseSync(canonicalTarget);
  const canonicalArchive = new D1Archive(new SqliteD1(canonicalDb));
  assert.deepEqual(await canonicalArchive.proof(fixture.namespace, "1", account), originals[0]);
  assert.deepEqual(await canonicalArchive.proof(fixture.namespace, "2", account), originals[1]);
  assert.deepEqual(
    await canonicalArchive.proof(fixture.namespace, "2", otherAccount),
    originals[2],
  );
  canonicalDb.close();

  const sqlTarget = join(dir, "sql.sqlite");
  await restoreSqlSnapshot(sql, sqlManifest, sqlTarget, fixture.namespace);
  const sqlDb = new DatabaseSync(sqlTarget);
  const sqlArchive = new D1Archive(new SqliteD1(sqlDb));
  assert.deepEqual(await sqlArchive.proof(fixture.namespace, "1", account), originals[0]);
  assert.deepEqual(await sqlArchive.proof(fixture.namespace, "2", account), originals[1]);
  assert.deepEqual(await sqlArchive.proof(fixture.namespace, "2", otherAccount), originals[2]);
  sqlDb.close();
});

test("restore rejects tampering before publishing a target and preserves source", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kettigo-proof-"));
  const source = join(dir, "source.sqlite");
  const { db, fixture } = await sourceArchive(source);
  const before = createHash("sha256").update(readFileSync(source)).digest("hex");
  const exported = exportArchive(db, fixture.namespace);
  db.close();
  const canonical = join(dir, "canonical.json"),
    trusted = join(dir, "manifest.json"),
    target = join(dir, "bad.sqlite");
  exported.payload.logs[1].args.hash = hex(99); // digest recomputed: domain validation must still reject it.
  exported.manifest.sha256 = createHash("sha256")
    .update(JSON.stringify(exported.payload))
    .digest("hex");
  writeFileSync(canonical, JSON.stringify(exported));
  writeFileSync(trusted, JSON.stringify(exported.manifest));
  await assert.rejects(
    () => restoreCanonical(canonical, trusted, target, fixture.namespace),
    /leaf mismatch|parent mismatch|root mismatch/,
  );
  assert.equal(existsSync(target), false);
  assert.equal(createHash("sha256").update(readFileSync(source)).digest("hex"), before);
});

test("restore never replaces an existing target", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kettigo-proof-target-"));
  const source = join(dir, "source.sqlite");
  const { db, fixture } = await sourceArchive(source);
  const retained = exportArchive(db, fixture.namespace);
  db.close();
  const exportPath = join(dir, "canonical.json"),
    manifest = join(dir, "manifest.json"),
    target = join(dir, "target.sqlite");
  writeFileSync(exportPath, JSON.stringify(retained));
  writeFileSync(manifest, JSON.stringify(retained.manifest));
  writeFileSync(target, "do-not-replace");
  await assert.rejects(
    () => restoreCanonical(exportPath, manifest, target, fixture.namespace),
    /already exists/,
  );
  assert.equal(readFileSync(target, "utf8"), "do-not-replace");
});

test("CLI imports a sealed SQL snapshot, maps D1 namespace columns, and replays canonical history", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kettigo-proof-cli-"));
  const source = join(dir, "source.sqlite");
  const { db, fixture } = await sourceArchive(source);
  db.close();
  const namespace = join(dir, "namespace.json");
  writeFileSync(namespace, JSON.stringify(fixture.namespace));
  const sql = join(dir, "retained.sql"),
    sqlManifest = join(dir, "trusted.sql.json"),
    imported = join(dir, "imported.sqlite");
  writeSqlSnapshot(source, sql, sqlManifest, fixture.namespace);
  const run = (...args: string[]) =>
    execFileSync(
      process.execPath,
      ["--experimental-transform-types", "tools/replay-retained.mts", ...args],
      { cwd: process.cwd(), stdio: "pipe" },
    );
  run("seal-sql", sql, sqlManifest, namespace);
  run("restore-sql", sql, sqlManifest, imported, namespace);
  const canonical = join(dir, "canonical.json"),
    manifest = join(dir, "canonical.manifest.json"),
    replayed = join(dir, "replayed.sqlite");
  run("export", imported, canonical, manifest, fixture.namespace.chainId, fixture.namespace.pool);
  run("restore-canonical", canonical, manifest, replayed, namespace);
  const restored = new D1Archive(new SqliteD1(new DatabaseSync(replayed)));
  const proof = await restored.proof(fixture.namespace, "2", account);
  assert.ok(proof);
  assert.equal(proof.generation, "1");
  assert.equal(proof.siblingHashes.length, 32);
});

test("canonical restore rejects separately authenticated digest, namespace, count, and header corruption", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "kettigo-proof-adverse-"));
  const source = join(dir, "source.sqlite");
  const { db, fixture } = await sourceArchive(source);
  const original = exportArchive(db, fixture.namespace);
  db.close();
  const run = async (
    label: string,
    mutate: (retained: typeof original) => void,
    reason: RegExp,
  ) => {
    await t.test(label, async () => {
      const retained = structuredClone(original);
      mutate(retained);
      const exportPath = join(dir, `${label}.json`);
      const manifestPath = join(dir, `${label}.manifest.json`);
      const target = join(dir, `${label}.sqlite`);
      writeFileSync(exportPath, JSON.stringify(retained));
      writeFileSync(manifestPath, JSON.stringify(retained.manifest));
      await assert.rejects(
        () => restoreCanonical(exportPath, manifestPath, target, fixture.namespace),
        reason,
      );
      assert.equal(existsSync(target), false);
    });
  };
  await run(
    "digest",
    (retained) => {
      retained.payload.logs[0].args.generation = "2";
    },
    /digest mismatch/,
  );
  await run(
    "foreign-full-namespace",
    (retained) => {
      const foreign = structuredClone(retained.payload.namespace);
      foreign.chainId = "1";
      foreign.pool = "0x3333333333333333333333333333333333333333";
      retained.payload.namespace = foreign;
      retained.manifest.namespace = foreign;
      resign(retained);
    },
    /namespace mismatch/,
  );
  await run(
    "metadata-count",
    (retained) => {
      retained.manifest.logs += 1;
      resign(retained);
    },
    /row count mismatch/,
  );
  await run(
    "missing-log",
    (retained) => {
      retained.payload.logs.pop();
      resign(retained);
    },
    /row count mismatch|root mismatch/,
  );
  await run(
    "header-gap",
    (retained) => {
      retained.payload.headers[1].number += 1;
      resign(retained);
    },
    /range mismatch|header continuity mismatch/,
  );
  await run(
    "header-parent",
    (retained) => {
      retained.payload.headers[1].parentHash = hex(99);
      resign(retained);
    },
    /header continuity mismatch/,
  );
});

test("canonical replay rejects domain-corrupt generation, node, draw root, and checkpoint despite a recomputed hash", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "kettigo-proof-domain-"));
  const source = join(dir, "source.sqlite");
  const { db, fixture } = await sourceArchive(source);
  const original = exportArchive(db, fixture.namespace);
  db.close();
  const run = async (
    label: string,
    mutate: (retained: typeof original) => void,
    reason: RegExp,
  ) => {
    await t.test(label, async () => {
      const retained = structuredClone(original);
      mutate(retained);
      const trusted = resign(retained);
      const exportPath = join(dir, `${label}.json`);
      const manifestPath = join(dir, `${label}.manifest.json`);
      const target = join(dir, `${label}.sqlite`);
      writeFileSync(exportPath, JSON.stringify(retained));
      writeFileSync(manifestPath, JSON.stringify(trusted));
      await assert.rejects(
        () => restoreCanonical(exportPath, manifestPath, target, fixture.namespace),
        reason,
      );
      assert.equal(existsSync(target), false);
    });
  };
  await run(
    "generation",
    (retained) => {
      retained.payload.logs.find((log) => log.name === "SlotAssigned")!.args.generation = "7";
    },
    /leaf mismatch/,
  );
  await run(
    "node",
    (retained) => {
      retained.payload.logs.find((log) => log.name === "NodeUpdated")!.args.hash = hex(77);
    },
    /leaf mismatch|parent mismatch/,
  );
  await run(
    "draw-root",
    (retained) => {
      retained.payload.logs.find((log) => log.name === "DrawSnapshotClosed")!.args.rootHash =
        hex(78);
    },
    /root mismatch/,
  );
  await run(
    "checkpoint",
    (retained) => {
      retained.payload.checkpoint.nextBlock = 99;
      retained.manifest.checkpoint = retained.payload.checkpoint;
    },
    /checkpoint mismatch|range mismatch/,
  );
});

test("native SQLite adapter returns SELECT batches and rolls back stale CAS and failed writes", async () => {
  const db = new DatabaseSync(":memory:");
  const adapter = new SqliteD1(db);
  db.exec("CREATE TABLE sample(value INTEGER UNIQUE)");
  await adapter.batch([adapter.prepare("INSERT INTO sample VALUES(?)").bind(1)]);
  const selected = await adapter.batch<Record<string, unknown>>([
    adapter.prepare("SELECT value FROM sample WHERE value=?").bind(1),
  ]);
  assert.deepEqual(
    selected[0].results.map((row) => ({ ...row })),
    [{ value: 1 }],
  );
  await assert.rejects(() =>
    adapter.batch([
      adapter.prepare("INSERT INTO sample VALUES(?)").bind(2),
      adapter.prepare("INSERT INTO sample VALUES(?)").bind(1),
    ]),
  );
  assert.deepEqual(
    db
      .prepare("SELECT value FROM sample ORDER BY value")
      .all()
      .map((row) => ({ ...row })),
    [{ value: 1 }],
  );
  for (const name of ["0001_proof_archive.sql", "0002_checkpoint_state.sql"])
    db.exec(readFileSync(new URL(name, migrations), "utf8"));
  const fixture = depth32Fixture();
  const archive = new D1Archive(adapter);
  await archive.initialize(fixture.namespace, zero);
  const current = await archive.status(fixture.namespace);
  for (const revision of [current.revision - 1, current.revision + 1]) {
    await assert.rejects(
      () => archive.disable(fixture.namespace, { ...current, revision }, "stale checkpoint"),
      /checkpoint conflict/,
    );
    assert.deepEqual(await archive.status(fixture.namespace), current);
  }
  db.close();
});

test("SQL restore rejects a sealed snapshot whose canonical events no longer have derived rows", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "kettigo-proof-sql-derived-"));
  const source = join(dir, "source.sqlite");
  const { db, fixture } = await sourceArchive(source);
  db.close();
  const sql = join(dir, "source.sql");
  const manifest = join(dir, "source.manifest.json");
  writeSqlSnapshot(source, sql, manifest, fixture.namespace);
  const body = readFileSync(sql, "utf8");
  const sourceHash = sha256(readFileSync(source));
  for (const [label, table] of [
    ["slot", "slot_versions"],
    ["draw", "draws"],
  ] as const)
    await t.test(label, async () => {
      const corrupted = body.replace(new RegExp(`INSERT INTO ${table}[^;]*;\\n`), "");
      assert.notEqual(corrupted, body);
      const corruptedSql = join(dir, `${label}.sql`);
      const corruptedManifest = join(dir, `${label}.manifest.json`);
      const target = join(dir, `${label}.sqlite`);
      writeFileSync(corruptedSql, corrupted);
      writeFileSync(corruptedManifest, JSON.stringify(sealSql(corrupted, fixture.namespace)));
      await assert.rejects(
        () => restoreSqlSnapshot(corruptedSql, corruptedManifest, target, fixture.namespace),
        /derived|proof|root|ownership/,
      );
      assert.equal(existsSync(target), false);
      assert.equal(sha256(readFileSync(source)), sourceHash);
    });
  await t.test("checkpoint", async () => {
    const corrupted = body.replace(
      /(INSERT INTO ingestion_state[^\n]*VALUES\('[^']*','[^']*',)3,2/,
      "$14,2",
    );
    assert.notEqual(corrupted, body);
    const corruptedSql = join(dir, "checkpoint.sql");
    const corruptedManifest = join(dir, "checkpoint.manifest.json");
    const target = join(dir, "checkpoint.sqlite");
    writeFileSync(corruptedSql, corrupted);
    writeFileSync(corruptedManifest, JSON.stringify(sealSql(corrupted, fixture.namespace)));
    await assert.rejects(
      () => restoreSqlSnapshot(corruptedSql, corruptedManifest, target, fixture.namespace),
      /checkpoint range mismatch/,
    );
    assert.equal(existsSync(target), false);
    assert.equal(sha256(readFileSync(source)), sourceHash);
  });
});

test("WAL SQL snapshot stays on the pre-commit checkpoint during a concurrent writer", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kettigo-proof-wal-"));
  const source = join(dir, "source.sqlite");
  const { db, fixture } = await sourceArchive(source);
  db.exec("PRAGMA journal_mode=WAL");
  db.close();
  const writer = new DatabaseSync(source);
  const originalPrepare = DatabaseSync.prototype.prepare;
  let committed = false;
  (
    DatabaseSync.prototype as unknown as { prepare: typeof DatabaseSync.prototype.prepare }
  ).prepare = function (sql: string) {
    const statement = originalPrepare.call(this, sql);
    if (this !== writer && sql.includes("FROM ingestion_state"))
      (
        this as unknown as {
          setAuthorizer(callback: (action: number, arg1: string | null) => number): void;
        }
      ).setAuthorizer((action: number, arg1: string | null) => {
        if (!committed && action === constants.SQLITE_READ && arg1 === "ingestion_state") {
          committed = true;
          writer.exec(
            `BEGIN IMMEDIATE;
               INSERT INTO canonical_blocks VALUES('${fixture.namespace.chainId}','${fixture.namespace.pool}',3,'${hex(3)}','${hex(2)}');
               UPDATE ingestion_state SET next_block=4,last_finalized_block=3,last_finalized_hash='${hex(3)}',revision=revision+1 WHERE chain_id='${fixture.namespace.chainId}' AND pool='${fixture.namespace.pool}';
               COMMIT;`,
          );
        }
        return constants.SQLITE_OK;
      });
    return statement;
  };
  const sql = join(dir, "snapshot.sql"),
    manifest = join(dir, "snapshot.manifest.json");
  try {
    writeSqlSnapshot(source, sql, manifest, fixture.namespace);
  } finally {
    (
      DatabaseSync.prototype as unknown as { prepare: typeof DatabaseSync.prototype.prepare }
    ).prepare = originalPrepare;
    writer.close();
  }
  assert.equal(committed, true);
  const sourceAfter = new DatabaseSync(source, { readOnly: true });
  assert.equal(
    (sourceAfter.prepare("SELECT next_block FROM ingestion_state").get() as { next_block: number })
      .next_block,
    4,
  );
  sourceAfter.close();
  const target = join(dir, "snapshot.sqlite");
  await restoreSqlSnapshot(sql, manifest, target, fixture.namespace);
  const restored = new D1Archive(new SqliteD1(new DatabaseSync(target)));
  assert.equal((await restored.status(fixture.namespace)).nextBlock, 3);
});

test("canonical restore does not replace a target created immediately before atomic publication", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kettigo-proof-publish-race-"));
  const source = join(dir, "source.sqlite");
  const { db, fixture } = await sourceArchive(source);
  const retained = exportArchive(db, fixture.namespace);
  db.close();
  const exportPath = join(dir, "canonical.json"),
    manifest = join(dir, "manifest.json");
  const target = join(dir, "target.sqlite");
  writeFileSync(exportPath, JSON.stringify(retained));
  writeFileSync(manifest, JSON.stringify(retained.manifest));
  const originalLink = fs.linkSync;
  let raced = false;
  (fs as unknown as { linkSync: typeof fs.linkSync }).linkSync = (from, to) => {
    if (!raced && to === target) {
      raced = true;
      writeFileSync(target, "racing writer sentinel");
    }
    return originalLink(from, to);
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(
      () => restoreCanonical(exportPath, manifest, target, fixture.namespace),
      /EEXIST/,
    );
  } finally {
    (fs as unknown as { linkSync: typeof fs.linkSync }).linkSync = originalLink;
    syncBuiltinESMExports();
  }
  assert.equal(raced, true);
  assert.equal(readFileSync(target, "utf8"), "racing writer sentinel");
});
