import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

test("dispatches the configured production keeper ref once on a five-minute slot", async (t) => {
  const { vars } = JSON.parse(readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"));
  assert.ok(vars.KEEPER_WORKFLOW_REF);
  const dispatches = [];
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    dispatches.push(JSON.parse(init.body));
    return { ok: true, status: 204 };
  });

  await worker.scheduled(
    {
      cron: "*/5 * * * *",
      scheduledTime: Date.UTC(2026, 9, 13, 19, 25),
    },
    { GITHUB_WORKFLOW_AUTH: "test-token", KEEPER_WORKFLOW_REF: vars.KEEPER_WORKFLOW_REF },
  );

  assert.deepEqual(dispatches, [{ ref: vars.KEEPER_WORKFLOW_REF }]);
});
