import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { runDrawWorker } from "../src/draw-worker.mjs";
import { runAllKeepers } from "../src/run-all-keepers.mjs";
import { runMorphoWorker } from "../src/morpho-worker.mjs";
import { runWithdrawalWorker } from "../src/withdrawal-worker.mjs";

function recordingSender() {
  const requests = [];
  return {
    requests,
    sender: {
      async send(request) {
        requests.push(request);
        return { hash: `0x${request.idempotencyKey}` };
      },
    },
  };
}

test("draw worker submits close action through the shared sender", async () => {
  const { requests, sender } = recordingSender();

  await runDrawWorker({
    snapshot: { nextDrawAt: 1_000n },
    planner: () => "close",
    sender,
    signer: "keeper",
    poolAddress: "0xpool",
  });

  assert.deepEqual(requests, [
    {
      signer: "keeper",
      idempotencyKey: "draw:0xpool:1000",
      to: "0xpool",
      action: "close",
      data: "closeDraw()",
    },
  ]);
});

test("morpho and withdrawal workers stay quiet when their planners return no action", async () => {
  const { requests, sender } = recordingSender();

  await runMorphoWorker({ snapshot: { now: 1n }, planner: () => undefined, sender, signer: "keeper", poolAddress: "0xpool" });
  await runWithdrawalWorker({
    snapshot: {},
    planner: () => undefined,
    sender,
    signer: "keeper",
    poolAddress: "0xpool",
    batchId: 1n,
  });

  assert.deepEqual(requests, []);
});

test("withdrawal worker derives stable batch-scoped idempotency keys", async () => {
  const { requests, sender } = recordingSender();

  await runWithdrawalWorker({
    snapshot: {},
    planner: () => "settle",
    sender,
    signer: "keeper",
    poolAddress: "0xpool",
    batchId: 7n,
    data: "settleWithdrawalBatch(7)",
  });

  assert.deepEqual(requests[0], {
    signer: "keeper",
    idempotencyKey: "withdrawal:0xpool:7:settle",
    to: "0xpool",
    action: "settle",
    data: "settleWithdrawalBatch(7)",
  });
});

test("the one-shot runner exposes the draw keeper", () => {
  const result = spawnSync(process.execPath, [
    "--no-warnings",
    "--experimental-strip-types",
    "--import",
    new URL("../src/register-ts-loader.mjs", import.meta.url).pathname,
    new URL("../src/run-web-keeper.mjs", import.meta.url).pathname,
    "draw",
    "--check",
  ], {
    encoding: "utf8",
    env: {
      ...process.env,
      SEPOLIA_RPC_URL: "https://rpc.example",
      NEXT_PUBLIC_CONFIDENTIAL_PRIZE_POOL_ADDRESS: "0x1111111111111111111111111111111111111111",
      KEEPER_PRIVATE_KEY: `0x${"11".repeat(32)}`,
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /draw keeper loaded/);
});

test("one scheduled pass attempts every lane when an earlier lane fails", async () => {
  const attempts = [];

  const result = await runAllKeepers(async (name) => {
    attempts.push(name);
    if (name === "morpho") throw new Error("morpho unavailable");
  });

  assert.deepEqual(attempts, ["morpho", "withdrawal", "draw"]);
  assert.deepEqual(result, [
    { name: "morpho", ok: false, error: "morpho unavailable" },
    { name: "withdrawal", ok: true },
    { name: "draw", ok: true },
  ]);
});
