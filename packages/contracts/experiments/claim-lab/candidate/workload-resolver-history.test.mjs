import assert from "node:assert/strict";
import test from "node:test";

import { compileCandidateWorkload } from "./eoa-workload-definition.mjs";
import {
  workloadDefinitionFixture,
  workloadManifestFixture,
} from "./eoa-workload-test-fixture.mjs";
import { encodeCandidateEoaAction } from "./workload-calldata.mjs";
import { proofFixture } from "./history-test-fixture.mjs";
import { resolveCandidateAction } from "./workload-resolver.ts";
import { historicResolverInput } from "./workload-resolver-history-fixture.mjs";

const workload = () =>
  compileCandidateWorkload(workloadDefinitionFixture(), workloadManifestFixture());

test("resolver binds canonical draw receipts and one valid historic bundle into checkPrize encoding", async () => {
  const input = historicResolverInput();
  const references = await resolveCandidateAction(input);
  const encoded = encodeCandidateEoaAction({
    compiled: input.compiled,
    actionId: input.actionId,
    resolved: {
      actionId: input.actionId,
      workloadFingerprint: input.compiled.fingerprint,
      references,
    },
  });
  assert.match(encoded.data, /^0x/);
  assert.equal(references.length, 7);
});

test("resolver rejects historic proof with a wrong canonical close log index", async () => {
  const input = historicResolverInput({
    proof: proofFixture({
      pool: workload().definition.contracts.candidatePool,
      account: workload().actions.find((action) => action.id === "check-stage8-eoa-00").actor,
      closeLogIndex: 18,
    }),
    snapshotLogIndex: 17,
  });
  await assert.rejects(() => resolveCandidateAction(input), /close log/);
});

test("resolver rejects a cross-draw canonical snapshot", async () => {
  await assert.rejects(
    () => resolveCandidateAction(historicResolverInput({ snapshotDrawId: 20n })),
    /canonical event/,
  );
});

test("resolver rejects a historic proof for another beneficiary", async () => {
  const compiled = workload();
  await assert.rejects(
    () =>
      resolveCandidateAction(
        historicResolverInput({
          proof: proofFixture({
            pool: compiled.definition.contracts.candidatePool,
            account: compiled.definition.actors.eoaParticipants[1],
          }),
        }),
      ),
    /historic proof/,
  );
});

test("resolver rejects another valid draw receipt under the expected historic producer key before fetch", async () => {
  const input = historicResolverInput({ producerActionId: "close-draw-A" });
  let fetches = 0;
  input.historic.fetch = async () => ((fetches += 1), assert.fail("unexpected historic fetch"));
  await assert.rejects(() => resolveCandidateAction(input), /producer evidence/);
  assert.equal(fetches, 0);
});

test("resolver ignores surplus historic scope fields and keeps the graph-derived proof request", async () => {
  const input = historicResolverInput();
  const originalFetch = input.historic.fetch;
  let request;
  input.historic = {
    ...input.historic,
    pool: "0x00000000000000000000000000000000000000f1",
    account: "0x00000000000000000000000000000000000000f2",
    drawId: "20",
    closedDraw: {
      drawId: "20",
      transactionHash: "0x" + "01".repeat(32),
      blockNumber: "2",
      blockHash: "0x" + "02".repeat(32),
    },
    snapshotClosed: {
      drawId: "20",
      transactionHash: "0x" + "01".repeat(32),
      blockNumber: "2",
      blockHash: "0x" + "02".repeat(32),
      logIndex: 3,
    },
    fetch: async (url, options) => {
      request = String(url);
      return originalFetch(url, options);
    },
  };
  const references = await resolveCandidateAction(input);
  assert.equal(references.length, 7);
  const expected = `${input.compiled.definition.contracts.candidatePool}/draws/19/proof/${input.compiled.actions.find((action) => action.id === input.actionId).actor}`;
  assert.ok(request.toLowerCase().includes(expected.toLowerCase()));
});
