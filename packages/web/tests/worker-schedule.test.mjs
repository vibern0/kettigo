import assert from "node:assert/strict";
import test from "node:test";

import worker from "../worker.ts";

test("ignores stale cron events outside the configured five-minute slots", async (t) => {
  let dispatches = 0;
  t.mock.method(globalThis, "fetch", async () => {
    dispatches += 1;
    return { ok: true, status: 204 };
  });

  await worker.scheduled(
    {
      cron: "* * * * *",
      scheduledTime: Date.UTC(2026, 9, 13, 19, 21),
    },
    { GITHUB_WORKFLOW_AUTH: "test-token" },
  );

  assert.equal(dispatches, 0);
});

test("dispatches GitHub Actions on a configured five-minute slot", async (t) => {
  let dispatches = 0;
  t.mock.method(globalThis, "fetch", async () => {
    dispatches += 1;
    return { ok: true, status: 204 };
  });

  await worker.scheduled(
    {
      cron: "*/5 * * * *",
      scheduledTime: Date.UTC(2026, 9, 13, 19, 25),
    },
    { GITHUB_WORKFLOW_AUTH: "test-token" },
  );

  assert.equal(dispatches, 1);
});
