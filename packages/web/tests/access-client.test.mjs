import assert from "node:assert/strict";
import test from "node:test";

import { checkAccess, joinWaitlist } from "../src/lib/access.ts";

function recordingFetch(response) {
  const requests = [];
  return {
    requests,
    fetch: async (url, init) => {
      requests.push({ url, init });
      return { async json() { return response; } };
    },
  };
}

test("access checks send email only and never send wallet identity", async () => {
  const recorder = recordingFetch({ ok: true, status: "approved" });
  assert.deepEqual(await checkAccess("person@example.com", recorder.fetch), { ok: true, status: "approved" });
  assert.equal(recorder.requests[0].url, "/api/access/status");
  assert.deepEqual(JSON.parse(recorder.requests[0].init.body), { email: "person@example.com" });
});

test("pending emails keep the waitlist request free of wallet data", async () => {
  const recorder = recordingFetch({ ok: true, status: "joined" });
  await joinWaitlist("person@example.com", recorder.fetch);
  assert.equal(recorder.requests[0].url, "/api/waitlist");
  assert.deepEqual(JSON.parse(recorder.requests[0].init.body), { email: "person@example.com" });
});
