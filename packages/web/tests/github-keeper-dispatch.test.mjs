import assert from "node:assert/strict";
import test from "node:test";

import { dispatchKeeperWorkflow } from "../worker/github-keeper-dispatch.ts";

test("dispatches the production keeper workflow on main", async () => {
  const requests = [];

  const status = await dispatchKeeperWorkflow("test-token", async (input, init) => {
    requests.push({ input, init });
    return { ok: true, status: 204 };
  });

  assert.equal(status, 204);
  assert.deepEqual(requests, [
    {
      input: "https://api.github.com/repos/vibern0/kettigo/actions/workflows/keepers.yml/dispatches",
      init: {
        method: "POST",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: "Bearer test-token",
          "Content-Type": "application/json",
          "User-Agent": "kettigo-cloudflare-keeper-dispatcher",
          "X-GitHub-Api-Version": "2026-03-10",
        },
        body: '{"ref":"main"}',
      },
    },
  ]);
});

test("fails the scheduled invocation when GitHub rejects the dispatch", async () => {
  await assert.rejects(
    dispatchKeeperWorkflow("test-token", async () => ({ ok: false, status: 401 })),
    /GitHub workflow dispatch failed with status 401/,
  );
});
