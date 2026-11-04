import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { D1Archive } from "../src/archive.ts";
import { branchHash, leafHash } from "../src/domain.ts";
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
  const logs = [
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
      args: { account, index: "1", generation: "2" },
    },
  ];
  let left = { hash: leafHash(otherAccount, "2", zero), sum: zero };
  let right = { hash: leafHash(account, "2", zero), sum: zero };
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
  run("restore-sql", sql, sqlManifest, imported, namespace);
  const canonical = join(dir, "canonical.json"),
    manifest = join(dir, "canonical.manifest.json"),
    replayed = join(dir, "replayed.sqlite");
  run("export", imported, canonical, manifest, fixture.namespace.chainId, fixture.namespace.pool);
  run("restore-canonical", canonical, manifest, replayed, namespace);
  const restored = new D1Archive(new SqliteD1(new DatabaseSync(replayed)));
  const proof = await restored.proof(fixture.namespace, "2", account);
  assert.ok(proof);
  assert.equal(proof.generation, "2");
  assert.equal(proof.siblingHashes.length, 32);
});
