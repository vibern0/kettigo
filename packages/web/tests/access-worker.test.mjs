import assert from "node:assert/strict";
import test from "node:test";

import { readAccessStatus, registerWaitlistInterest } from "../worker/access.ts";

class MemoryStatement {
  constructor(store, sql) { this.store = store; this.sql = sql; this.values = []; }
  bind(...values) { this.values = values; return this; }
  async first() {
    if (this.sql.includes("SELECT")) {
      const [email] = this.values;
      return this.store.get(email) ?? null;
    }
    if (this.sql.includes("INSERT")) {
      const [, email] = this.values;
      if (!this.store.has(email)) {
        this.store.set(email, {
          email_normalized: email,
          approved_at: null,
          wallet_address: null,
          joined_signature: null,
          joined_message: null,
        });
        return { changed: true };
      }
      return { changed: false };
    }
    throw new Error(`Access lookup must not mutate wallet fields: ${this.sql}`);
  }
  async run() { return this.first(); }
}

class MemoryD1 {
  constructor(rows = []) { this.rows = new Map(rows.map((row) => [row.email_normalized, { ...row }])); }
  prepare(sql) { return new MemoryStatement(this.rows, sql); }
}

test("joining the waitlist creates a pending row without wallet identity", async () => {
  const db = new MemoryD1();
  assert.deepEqual(await registerWaitlistInterest(db, " Person@Example.COM ", () => "id-1", () => "now"), { ok: true, status: "joined" });
  assert.deepEqual(db.rows.get("person@example.com"), {
    email_normalized: "person@example.com",
    approved_at: null,
    wallet_address: null,
    joined_signature: null,
    joined_message: null,
  });
});

test("multiple clients can read one approved email without mutating legacy wallet columns", async () => {
  const original = {
    email_normalized: "approved@example.com",
    approved_at: "2026-10-01T10:00:00.000Z",
    wallet_address: null,
    joined_signature: null,
    joined_message: null,
  };
  const db = new MemoryD1([original]);
  assert.deepEqual(await readAccessStatus(db, "approved@example.com"), { ok: true, status: "approved" });
  assert.deepEqual(await readAccessStatus(db, " APPROVED@example.com "), { ok: true, status: "approved" });
  assert.deepEqual(db.rows.get("approved@example.com"), original);
});

test("pending, missing, and invalid emails remain unavailable", async () => {
  const db = new MemoryD1([{
    email_normalized: "pending@example.com",
    approved_at: null,
    wallet_address: null,
    joined_signature: null,
    joined_message: null,
  }]);
  assert.deepEqual(await readAccessStatus(db, "pending@example.com"), { ok: false, status: "pending" });
  assert.deepEqual(await readAccessStatus(db, "missing@example.com"), { ok: false, status: "pending" });
  assert.deepEqual(await readAccessStatus(db, "bad"), { ok: false, status: "invalid_request" });
});
