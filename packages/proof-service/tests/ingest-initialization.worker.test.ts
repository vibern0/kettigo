import { env as workerEnv } from "cloudflare:test";
import { expect, it } from "vitest";
import { D1Archive } from "../src/archive.ts";
import { ingestOneSlice } from "../src/ingest.ts";
import { initializeArchiveForTick } from "../src/worker.ts";
import { FixtureRpc, header, namespace } from "./ingest.worker.fixture.ts";

const env = workerEnv as unknown as { PROOF_DB: D1Database };

it("repairs a legacy interrupted scheduler initialization through its scheduler path", async () => {
  expect.hasAssertions();
  const n = namespace();
  const parent = header(0, "a");
  const archive = new D1Archive(env.PROOF_DB);
  await env.PROOF_DB.prepare("INSERT INTO namespaces VALUES(?,?,?,?,?,?)")
    .bind(n.chainId, n.pool, n.depth, n.zero, JSON.stringify(n.emptyHashes), n.deploymentBlock)
    .run();
  await env.PROOF_DB.prepare("INSERT INTO ingestion_state VALUES(?,?,?,?,?,?,?,?)")
    .bind(n.chainId, n.pool, n.deploymentBlock, 0, parent.hash, 0, null, new Date().toISOString())
    .run();

  await initializeArchiveForTick(archive, n, new FixtureRpc([parent], [], n));

  expect(await archive.canonicalBlock(n, 0)).toEqual(parent);
  expect(await archive.status(n)).toMatchObject({ nextBlock: 1, lastFinalizedHash: parent.hash });
});

it(
  "persists the real deployment-parent anchor for the first canonical header",
  { timeout: 5000 },
  async () => {
    expect.hasAssertions();
    const n = namespace();
    const archive = new D1Archive(env.PROOF_DB);
    const anchor = `0x${"9".repeat(64)}`;
    await archive.initialize(n, anchor);
    const first = header(1, "1", anchor);
    const state = await ingestOneSlice(archive, n, new FixtureRpc([first], [], n), 2);
    expect(state.lastFinalizedHash).toBe(first.hash);
    expect((await archive.canonicalBlock(n, 0))?.hash).toBe(anchor);
  },
);
