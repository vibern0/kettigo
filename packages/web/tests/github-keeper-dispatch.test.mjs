import assert from "node:assert/strict";
import test from "node:test";

import {
  buildKeeperWorkflowRequest,
  dispatchKeeperWorkflow,
} from "../worker/github-keeper-dispatch.ts";

test("builds the production keeper workflow request on main", async () => {
  const request = buildKeeperWorkflowRequest("test-token");

  assert.equal(request.url, "https://api.github.com/repos/vibern0/kettigo/actions/workflows/keepers.yml/dispatches");
  assert.equal(request.method, "POST");
  assert.equal(request.headers.get("Accept"), "application/vnd.github+json");
  assert.equal(request.headers.get("Authorization"), "Bearer test-token");
  assert.equal(request.headers.get("Content-Type"), "application/json");
  assert.equal(request.headers.get("User-Agent"), "kettigo-cloudflare-keeper-dispatcher");
  assert.equal(request.headers.get("X-GitHub-Api-Version"), "2026-03-10");
  assert.equal(await request.text(), '{"ref":"main"}');
});

test("returns GitHub's accepted dispatch status", async () => {
  const status = await dispatchKeeperWorkflow("test-token", async () => ({ ok: true, status: 204 }));

  assert.equal(status, 204);
});

test("fails the scheduled invocation when GitHub rejects the dispatch", async () => {
  await assert.rejects(
    dispatchKeeperWorkflow("test-token", async () => ({ ok: false, status: 401 })),
    /GitHub workflow dispatch failed with status 401/,
  );
});
