import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { runDrawKeeper } from "../netlify/functions/draw-keeper.ts";

const pool = "0x1111111111111111111111111111111111111111";
const account = { address: "0x2222222222222222222222222222222222222222" };

function fakePublicClient(values) {
  const readings = new Map(Object.entries(values));
  return {
    async getBlock() { return { timestamp: readings.get("now") }; },
    async readContract({ functionName }) { return readings.get(functionName); },
  };
}

test("draw keeper stays idle before the draw is eligible", async () => {
  const writes = [];
  const result = await runDrawKeeper({
    publicClient: fakePublicClient({
      now: 999n,
      nextDrawAt: 1_000n,
      participantCount: 2n,
      publicPrizeReserve: 1_000_000n,
      morphoAccruedYieldAssets: 0n,
    }),
    walletClient: { async writeContract(request) { writes.push(request); } },
    account,
    pool,
    minimumPrize: 1_000_000n,
  });

  assert.deepEqual(result, {
    ok: true,
    status: "idle",
    snapshot: {
      now: "999",
      nextDrawAt: "1000",
      participantCount: "2",
      publicPrizeReserve: "1000000",
      morphoAccruedYieldAssets: "0",
      minimumPrize: "1000000",
    },
  });
  assert.deepEqual(writes, []);
});

test("draw keeper submits one close transaction when the draw is eligible", async () => {
  const writes = [];
  const result = await runDrawKeeper({
    publicClient: fakePublicClient({
      now: 1_000n,
      nextDrawAt: 1_000n,
      participantCount: 2n,
      publicPrizeReserve: 750_000n,
      morphoAccruedYieldAssets: 250_000n,
    }),
    walletClient: {
      async writeContract(request) {
        writes.push(request);
        return "0xabc";
      },
    },
    account,
    pool,
    minimumPrize: 1_000_000n,
  });

  assert.equal(writes.length, 1);
  assert.equal(writes[0].functionName, "closeDraw");
  assert.deepEqual(writes[0].args, []);
  assert.deepEqual(result, {
    ok: true,
    status: "submitted",
    action: "close",
    hash: "0xabc",
    snapshot: {
      now: "1000",
      nextDrawAt: "1000",
      participantCount: "2",
      publicPrizeReserve: "750000",
      morphoAccruedYieldAssets: "250000",
      minimumPrize: "1000000",
    },
  });
});

test("production draw keeper closes an overdue round with a nonzero prize", async () => {
  const workflow = readFileSync(".github/workflows/keepers.yml", "utf8");
  const configuredMinimum = workflow.match(/DRAW_KEEPER_MINIMUM_PRIZE: "(\d+)"/)?.[1];
  assert.ok(configuredMinimum, "production keeper minimum is configured");

  const writes = [];
  const result = await runDrawKeeper({
    publicClient: fakePublicClient({
      now: 1_001n,
      nextDrawAt: 1_000n,
      participantCount: 3n,
      publicPrizeReserve: 0n,
      morphoAccruedYieldAssets: 223n,
    }),
    walletClient: {
      async writeContract(request) {
        writes.push(request);
        return "0xabc";
      },
    },
    account,
    pool,
    minimumPrize: BigInt(configuredMinimum),
  });

  assert.equal(result.status, "submitted");
  assert.equal(writes.length, 1);
});
