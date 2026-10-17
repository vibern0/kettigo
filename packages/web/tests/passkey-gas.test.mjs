import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { getAddress } from "viem";
import { createPasskeyVerifierGasProbe, PASSKEY_VERIFIER_PROBE_DATA, withPasskeyStage } from "../src/lib/passkey-gas.ts";

const VERIFIER = getAddress("0xc2b78104907F722DABAc4C69f826a522B2754De4");
const VALID = `0x${"0".repeat(63)}1`;

test("the public verifier probe contains a valid P256 signature", () => {
  const bytes = Buffer.from(PASSKEY_VERIFIER_PROBE_DATA.slice(2), "hex");
  assert.equal(bytes.length, 160);
  const key = crypto.createPublicKey({ format: "jwk", key: {
    kty: "EC", crv: "P-256",
    x: bytes.subarray(96, 128).toString("base64url"),
    y: bytes.subarray(128, 160).toString("base64url"),
  } });
  const payload = Buffer.from("Kettigo public P256 gas estimation probe");
  assert.deepEqual(bytes.subarray(0, 32), crypto.createHash("sha256").update(payload).digest());
  assert.equal(crypto.verify("sha256", payload, { key, dsaEncoding: "ieee-p1363" }, bytes.subarray(32, 96)), true);
});

test("measures the configured verifier, shares concurrent probes, and refreshes after five minutes", async () => {
  let now = 0;
  let calls = 0;
  let estimates = 0;
  const probe = createPasskeyVerifierGasProbe({
    async call(input) {
      calls++;
      assert.equal(input.to, VERIFIER);
      assert.equal(input.data, PASSKEY_VERIFIER_PROBE_DATA);
      return { data: VALID };
    },
    async estimateGas() { estimates++; return 356_759n; },
  }, () => now);
  assert.deepEqual(await Promise.all([probe(VERIFIER), probe(VERIFIER)]), [356_759n, 356_759n]);
  now = 299_999;
  await probe(VERIFIER);
  assert.equal(estimates, 1);
  now = 300_000;
  await probe(VERIFIER);
  assert.equal(calls, 2);
  assert.equal(estimates, 2);
});

test("does not accept or cache an invalid verifier response", async () => {
  let attempts = 0;
  const probe = createPasskeyVerifierGasProbe({
    async call() { attempts++; return { data: attempts === 1 ? "0x" : VALID }; },
    async estimateGas() { return 400_000n; },
  });
  await assert.rejects(probe(VERIFIER), /probe/i);
  assert.equal(await probe(VERIFIER), 400_000n);
});

test("a stalled probe times out and a later action can remeasure", async () => {
  let calls = 0;
  const probe = createPasskeyVerifierGasProbe({
    async call() { return ++calls === 1 ? new Promise(() => {}) : { data: VALID }; },
    async estimateGas() { return 400_000n; },
  }, Date.now, 5);
  await assert.rejects(probe(VERIFIER), /timed out/);
  assert.equal(await probe(VERIFIER), 400_000n);
});

test("adding diagnostics preserves native passkey cancellation errors", async () => {
  const cancelled = new DOMException("The request was cancelled.", "NotAllowedError");
  await assert.rejects(withPasskeyStage({}, "signing", async () => { throw cancelled; }), (error) => {
    assert.equal(error, cancelled);
    assert.equal(error instanceof DOMException, true);
    assert.equal(error.passkeyDiagnostics.phase, "signing");
    return true;
  });
});
