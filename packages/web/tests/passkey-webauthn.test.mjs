import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyPasskeyError,
  createKettigoCredential,
  getKettigoCredential,
  isPasskeySupported,
} from "../src/lib/passkey-webauthn.ts";

function fakeCredential(rawId = Uint8Array.from([0xaa, 0xbb]).buffer) {
  return { id: "credential", rawId, type: "public-key" };
}

test("creates a discoverable ES256 credential without using an email identity", async () => {
  let options;
  const credential = fakeCredential();
  const result = await createKettigoCredential({
    rpId: "app.kettigo.xyz",
    rpName: "Kettigo",
    credentials: {
      async create(received) {
        options = received;
        return credential;
      },
    },
    randomBytes(length) {
      return new Uint8Array(length).fill(7);
    },
  });

  assert.equal(result, credential);
  assert.equal(options.publicKey.rp.id, "app.kettigo.xyz");
  assert.equal(options.publicKey.rp.name, "Kettigo");
  assert.deepEqual(options.publicKey.pubKeyCredParams, [{ type: "public-key", alg: -7 }]);
  assert.equal(options.publicKey.authenticatorSelection.residentKey, "required");
  assert.equal(options.publicKey.authenticatorSelection.userVerification, "required");
  assert.equal(options.publicKey.user.name, "Kettigo account");
  assert.equal(options.publicKey.user.displayName, "Kettigo account");
  assert.deepEqual(Array.from(options.publicKey.user.id), new Array(32).fill(7));
  assert.equal(JSON.stringify(options).includes("@"), false);
});

test("restores only the persisted credential and requires user verification", async () => {
  let options;
  const credential = fakeCredential();
  const result = await getKettigoCredential("aabb", {
    rpId: "app.kettigo.xyz",
    credentials: {
      async get(received) {
        options = received;
        return credential;
      },
    },
  });

  assert.equal(result, credential);
  assert.equal(options.publicKey.rpId, "app.kettigo.xyz");
  assert.equal(options.publicKey.userVerification, "required");
  assert.deepEqual(Array.from(options.publicKey.allowCredentials[0].id), [0xaa, 0xbb]);
});

test("classifies unsupported browsers and user cancellation separately", () => {
  assert.equal(isPasskeySupported({ credentials: {} }, undefined), false);
  assert.equal(isPasskeySupported({ credentials: { create() {}, get() {} } }, class {}), true);
  assert.equal(classifyPasskeyError(new DOMException("cancelled", "NotAllowedError")), "cancelled");
  assert.equal(classifyPasskeyError(new Error("WebAuthn is unavailable")), "unsupported");
  assert.equal(classifyPasskeyError(new Error("network")), "unknown");
});
