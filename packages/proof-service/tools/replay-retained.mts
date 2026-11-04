import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { D1Archive, type ArchiveDatabase } from "../src/archive.ts";
import { validateNamespace } from "../src/domain.ts";

type Bound = { sql: string; values: unknown[] };
export class SqliteD1 implements ArchiveDatabase {
  constructor(readonly sqlite: DatabaseSync) {}
  prepare(sql: string) {
    const bound: Bound = { sql, values: [] };
    const statement = {
      bind: (...values: unknown[]) => {
        bound.values = values;
        return statement;
      },
      run: async () => this.sqlite.prepare(bound.sql).run(...bound.values),
      first: async <T,>() => this.sqlite.prepare(bound.sql).get(...bound.values) as T | null,
      all: async <T,>() => ({
        results: this.sqlite.prepare(bound.sql).all(...bound.values) as T[],
      }),
    };
    return statement as unknown as D1PreparedStatement;
  }
  async batch(statements: D1PreparedStatement[]) {
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.sqlite.exec("COMMIT");
      return results as D1Result[];
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }
}

export async function restore(
  exported: any,
  targetPath: string,
  expectedChainId: string,
  expectedPool: string,
) {
  const body = JSON.stringify(exported.payload);
  if (createHash("sha256").update(body).digest("hex") !== exported.manifest?.sha256)
    throw new Error("retained export digest mismatch");
  const n = validateNamespace(exported.payload?.namespace);
  if (n.chainId !== expectedChainId || n.pool !== expectedPool)
    throw new Error("retained export namespace mismatch");
  const headers = exported.payload.headers,
    logs = exported.payload.logs;
  if (
    !Array.isArray(headers) ||
    !Array.isArray(logs) ||
    headers.length !== exported.manifest.headers ||
    logs.length !== exported.manifest.logs
  )
    throw new Error("retained export row count mismatch");
  for (let i = 0; i < headers.length; i += 1)
    if (
      headers[i].number !== n.deploymentBlock - 1 + i ||
      (i && headers[i].parentHash !== headers[i - 1].hash)
    )
      throw new Error("retained header continuity mismatch");
  const sqlite = new DatabaseSync(targetPath);
  try {
    for (const migration of ["0001_proof_archive.sql", "0002_checkpoint_state.sql"])
      sqlite.exec(readFileSync(new URL(`../migrations/${migration}`, import.meta.url), "utf8"));
    const archive = new D1Archive(new SqliteD1(sqlite));
    await archive.initialize(n, headers[0]?.hash);
    if (headers.length > 1)
      await archive.ingest(n, await archive.status(n), logs, headers.slice(1));
    const integrity = sqlite.prepare("PRAGMA integrity_check").get() as {
      integrity_check?: string;
    };
    if (integrity.integrity_check !== "ok") throw new Error("SQLite integrity check failed");
  } finally {
    sqlite.close();
  }
}
if (import.meta.main) {
  const [exportPath, targetPath, expectedChainId, expectedPool] = process.argv.slice(2);
  if (!exportPath || !targetPath || !expectedChainId || !expectedPool)
    throw new Error("usage: replay-retained.mts export.json restore.sqlite chainId pool");
  await restore(
    JSON.parse(readFileSync(exportPath, "utf8")),
    targetPath,
    expectedChainId,
    expectedPool,
  );
}
