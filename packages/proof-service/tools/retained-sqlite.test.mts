import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { D1Archive } from "../src/archive.ts";
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
  // Later reuse must not alter the historical owner/generation at draw 1.
  const second = { number: 2, hash: hex(2), parentHash: fixture.block.hash };
  await archive.ingest(
    fixture.namespace,
    await archive.status(fixture.namespace),
    [
      {
        blockNumber: 2,
        blockHash: second.hash,
        logIndex: 0,
        name: "SlotReleased",
        args: { account, index: "0", generation: "1" },
      },
      {
        blockNumber: 2,
        blockHash: second.hash,
        logIndex: 1,
        name: "SlotAssigned",
        args: { account: otherAccount, index: "0", generation: "2" },
      },
    ],
    [second],
  );
  return { db, archive, fixture };
}

test("canonical and trusted SQL restores retain the exact depth-32 historical proof", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kettigo-proof-"));
  const sourcePath = join(dir, "source.sqlite");
  const { db, archive, fixture } = await sourceArchive(sourcePath);
  const original = await archive.proof(fixture.namespace, "1", account);
  assert.ok(original);
  assert.equal(original.siblingHashes.length, 32);
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
  const canonicalProof = await new D1Archive(new SqliteD1(canonicalDb)).proof(
    fixture.namespace,
    "1",
    account,
  );
  assert.deepEqual(canonicalProof, original);
  canonicalDb.close();

  const sqlTarget = join(dir, "sql.sqlite");
  await restoreSqlSnapshot(sql, sqlManifest, sqlTarget, fixture.namespace);
  const sqlDb = new DatabaseSync(sqlTarget);
  const sqlProof = await new D1Archive(new SqliteD1(sqlDb)).proof(fixture.namespace, "1", account);
  assert.deepEqual(sqlProof, original);
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
