import { env as workerEnv } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { D1Archive } from "../src/archive.ts";
import { ingestOneSlice } from "../src/ingest.ts";
import { FallbackRpc } from "../src/rpc.ts";
import {
  FixtureRpc,
  header,
  namespace,
  retainedHeaders,
  seedRetainedProof,
} from "./ingest.worker.fixture.ts";

const env = workerEnv as unknown as { PROOF_DB: D1Database };

describe("retained finalized RPC ingestion", () => {
  it(
    "rejects an older matching provider head without deleting retained proof and draw history",
    { timeout: 5000 },
    async () => {
      expect.hasAssertions();
      const n = namespace();
      const archive = new D1Archive(env.PROOF_DB);
      const { account, h2, headers, logs } = await seedRetainedProof(archive, n);

      await expect(
        ingestOneSlice(archive, n, new FixtureRpc([headers[0]], logs, n), 2),
      ).rejects.toThrow("finalized head behind retained checkpoint");
      expect(await archive.status(n)).toMatchObject({
        nextBlock: 131,
        lastFinalizedBlock: 130,
        lastFinalizedHash: headers[129].hash,
        disabledReason: undefined,
      });
      expect((await archive.canonicalBlock(n, 130))?.hash).toBe(headers[129].hash);
      expect(await archive.proof(n, "1", account)).toMatchObject({
        drawId: "1",
        closeBlockNumber: 2,
      });
      expect(await archive.drawById(n, "1")).toMatchObject({ blockHash: h2.hash });
    },
  );

  it(
    "fails over from an older provider head and advances from the retained checkpoint",
    { timeout: 5000 },
    async () => {
      expect.hasAssertions();
      const n = namespace(),
        archive = new D1Archive(env.PROOF_DB),
        retained = retainedHeaders();
      const h131 = header(131, "3", retained[129].hash),
        h132 = header(132, "4", h131.hash);
      await archive.initialize(n);
      await archive.ingest(n, await archive.status(n), [], retained);

      const state = await new FallbackRpc(
        new FixtureRpc([retained[0]], [], n),
        new FixtureRpc([...retained, h131, h132], [], n),
        n,
      ).withSource((source) => ingestOneSlice(archive, n, source, 2));

      expect(state).toMatchObject({
        nextBlock: 133,
        lastFinalizedBlock: 132,
        lastFinalizedHash: h132.hash,
      });
      expect((await archive.canonicalBlock(n, 130))?.hash).toBe(retained[129].hash);
    },
  );

  it(
    "keeps retained state unchanged when both providers report older finalized heads",
    { timeout: 5000 },
    async () => {
      expect.hasAssertions();
      const n = namespace(),
        archive = new D1Archive(env.PROOF_DB),
        retained = retainedHeaders();
      await archive.initialize(n);
      await archive.ingest(n, await archive.status(n), [], retained);

      await expect(
        new FallbackRpc(
          new FixtureRpc([retained[0]], [], n),
          new FixtureRpc([retained[0]], [], n),
          n,
        ).withSource((source) => ingestOneSlice(archive, n, source, 2)),
      ).rejects.toThrow("rpc sources failed");
      expect(await archive.status(n)).toMatchObject({
        nextBlock: 131,
        lastFinalizedBlock: 130,
        lastFinalizedHash: retained[129].hash,
        disabledReason: undefined,
      });
      expect((await archive.canonicalBlock(n, 130))?.hash).toBe(retained[129].hash);
    },
  );
});
