import assert from "node:assert/strict";
import test from "node:test";

import {
  hasCachedApprovedSession,
  readCachedApprovedEmail,
  rememberApprovedEmail,
} from "../src/lib/access-cache.ts";

function createStorage() {
  const values = new Map();
  return {
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
  };
}

test("an approved email caches an independent gate marker", () => {
  const storage = createStorage();
  rememberApprovedEmail(" Person@Example.COM ", storage);
  assert.equal(readCachedApprovedEmail(storage), "person@example.com");
  assert.equal(hasCachedApprovedSession(storage), true);
  const cached = JSON.parse(storage.getItem("kettigo.access.v1"));
  assert.deepEqual(cached, { approvedEmail: "person@example.com" });
  assert.equal("walletAddress" in cached, false);
  assert.equal("signature" in cached, false);
});

test("missing or corrupt approval data never bypasses the email gate", () => {
  const missing = createStorage();
  assert.equal(hasCachedApprovedSession(missing), false);
  const corrupt = createStorage();
  corrupt.setItem("kettigo.access.v1", "{");
  assert.equal(hasCachedApprovedSession(corrupt), false);
  assert.equal(readCachedApprovedEmail(corrupt), null);
});
