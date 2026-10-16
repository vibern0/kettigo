import assert from "node:assert/strict";
import test from "node:test";
import { handleClientEvents } from "../worker/client-events.ts";

const dsn = "https://1wUDLFc7g8tpcchuQ2CXZTyJ@s2796372.us-west-2a.betterstackdata.com/2796373";
const body = `${JSON.stringify({ dsn })}\n{"type":"event"}\n{"message":"Deposit failed"}`;
function request(payload = body, origin = "https://app.kettigo.xyz") {
  return new Request("https://app.kettigo.xyz/api/client-events", { method: "POST", headers: { origin, cookie: "session=secret" }, body: payload });
}

test("forwards the envelope to the fixed Better Stack project without cookies", async () => {
  let forwarded;
  const result = await handleClientEvents(request(), async (url, options) => {
    forwarded = new Request(url, options);
    return new Response("{}", { status: 200 });
  });
  assert.equal(result.status, 200);
  assert.equal(new URL(forwarded.url).host, "s2796372.us-west-2a.betterstackdata.com");
  assert.equal(new URL(forwarded.url).pathname, "/api/2796373/envelope/");
  assert.equal(forwarded.headers.get("cookie"), null);
  assert.equal(await forwarded.text(), body);
});

test("rejects other origins, projects and oversized envelopes without forwarding", async () => {
  const forward = () => { throw new Error("must not forward"); };
  assert.equal((await handleClientEvents(request(body, "https://other.example"), forward)).status, 403);
  assert.equal((await handleClientEvents(request(body.replace("/2796373", "/123")), forward)).status, 400);
  assert.equal((await handleClientEvents(request("x".repeat(65_537)), forward)).status, 413);
});

test("preserves upstream failure so browser delivery is not falsely acknowledged", async () => {
  assert.equal((await handleClientEvents(request(), async () => new Response(null, { status: 429 }))).status, 429);
  assert.equal((await handleClientEvents(request(), async () => { throw new Error("offline"); })).status, 502);
});
