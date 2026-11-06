import assert from "node:assert/strict";
import test from "node:test";

import { resolveHistoricPrizeProof } from "./historic-prize-proof.ts";
import { h32, proofFixture } from "./history-test-fixture.mjs";

const pool = "0x52908400098527886E0F7030069857D2E4169EE7";
const account = "0x8617E340B3D01FA5F11F306F4090FD50E238070D";
const otherAccount = "0xde709f2102306220921060314715629080e2fb77";

function fixture(
  proof = proofFixture({ pool, account }),
  canonicalSnapshot = proofFixture({ pool, account }),
) {
  const calls = [];
  return {
    calls,
    input: {
      pool: pool.toLowerCase(),
      account: account.toLowerCase(),
      drawId: "19",
      closedDraw: Object.freeze({
        drawId: "19",
        transactionHash: h32("d"),
        blockNumber: "1234",
        blockHash: h32("c"),
      }),
      snapshotClosed: Object.freeze({
        drawId: "19",
        transactionHash: h32("d"),
        blockNumber: "1234",
        blockHash: h32("c"),
        logIndex: 17,
      }),
      baseUrl: "https://archive.example/",
      fetch: async (url) => {
        calls.push(url.toString());
        return new globalThis.Response(JSON.stringify({ proof }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
      readSnapshot: async (drawId) => {
        assert.equal(drawId, 19n);
        return {
          rootHash: canonicalSnapshot.rootHash,
          rootSum: canonicalSnapshot.rootSum,
          ticket: canonicalSnapshot.ticket,
          upperBound: BigInt(canonicalSnapshot.upperBound),
          closeBlockNumber: 1234n,
        };
      },
      readBlockHash: async (blockNumber) => {
        assert.equal(blockNumber, 1234n);
        return h32("c");
      },
    },
  };
}

test("historic proof adapter returns one immutable canonical bundle from the shared proof client", async () => {
  const { input, calls } = fixture();
  const bundle = await resolveHistoricPrizeProof(input);

  assert.equal(calls.length, 1);
  assert.match(
    calls[0],
    /v1\/11155111\/0x52908400098527886E0F7030069857D2E4169EE7\/draws\/19\/proof\/0x8617E340B3D01FA5F11F306F4090FD50E238070D$/,
  );
  assert.deepEqual(Object.keys(bundle).sort(), [
    "balanceHandle",
    "bundleId",
    "drawId",
    "generation",
    "index",
    "parentSums",
    "siblingHashes",
    "siblingSums",
  ]);
  assert.equal(bundle.drawId, "19");
  assert.equal(bundle.index, "0");
  assert.equal(bundle.generation, "7");
  assert.equal(bundle.balanceHandle, h32("a"));
  assert.equal(bundle.siblingHashes.length, 32);
  assert.match(bundle.bundleId, /^0x[0-9a-f]{64}$/);
  assert.ok(Object.isFrozen(bundle));
  assert.ok(Object.isFrozen(bundle.siblingHashes));
  assert.ok(Object.isFrozen(bundle.siblingSums));
  assert.ok(Object.isFrozen(bundle.parentSums));
});

test("historic proof adapter rejects proof scope, path, snapshot, header, and close-log mismatches", async () => {
  const cases = [
    ["scope", proofFixture({ pool, account: otherAccount })],
    ["path", proofFixture({ pool, account, rootHash: h32("e") })],
    ["snapshot", proofFixture({ pool, account, ticket: h32("e") })],
    ["header", proofFixture({ pool, account, blockHash: h32("e") })],
    ["close log", proofFixture({ pool, account, closeLogIndex: 18 })],
  ];
  for (const [name, proof] of cases) {
    const { input } = fixture(proof);
    const expected = name === "close log" ? /close log/ : /historic proof/;
    await assert.rejects(() => resolveHistoricPrizeProof(input), expected);
  }
});

test("historic proof adapter rejects mismatched canonical closed-draw and snapshot receipt identities", async () => {
  const { input } = fixture();
  input.snapshotClosed = { ...input.snapshotClosed, transactionHash: h32("e") };
  await assert.rejects(() => resolveHistoricPrizeProof(input), /historic proof/);
});

test("historic proof adapter rejects non-proof archive outcomes and malformed canonical locations", async () => {
  const unavailable = fixture();
  unavailable.input.fetch = async () =>
    new globalThis.Response(JSON.stringify({ outcome: "NOT_ELIGIBLE" }), { status: 404 });
  await assert.rejects(() => resolveHistoricPrizeProof(unavailable.input), /historic proof/);

  const malformed = fixture();
  malformed.input.closedDraw = { ...malformed.input.closedDraw, blockNumber: "001234" };
  await assert.rejects(() => resolveHistoricPrizeProof(malformed.input), /historic proof/);
});

test("historic proof adapter never falls back to global fetch when injected transport is absent or invalid", async () => {
  const originalFetch = globalThis.fetch;
  let globalCalls = 0;
  globalThis.fetch = async () => {
    globalCalls += 1;
    throw new Error("global fetch must never run");
  };
  try {
    for (const transport of [undefined, {}]) {
      const { input } = fixture();
      input.fetch = transport;
      await assert.rejects(() => resolveHistoricPrizeProof(input), /historic proof/);
    }
    assert.equal(globalCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
