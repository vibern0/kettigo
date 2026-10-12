import assert from "node:assert/strict";
import test from "node:test";

import {
  PASSKEY_METADATA_KEY,
  readPasskeyMetadata,
  writePasskeyMetadata,
} from "../src/lib/passkey-metadata.ts";

function storageWith(initial) {
  const values = new Map(initial ? [[PASSKEY_METADATA_KEY, initial]] : []);
  return {
    getItem(key) {
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
    removeItem(key) {
      values.delete(key);
    },
    value() {
      return values.get(PASSKEY_METADATA_KEY) ?? null;
    },
  };
}

const VALID = {
  rawId: "aabbccdd",
  coordinates: {
    x: `0x${"11".repeat(32)}`,
    y: `0x${"22".repeat(32)}`,
  },
  verifierAddress: "0x00000000000000000000000000000000000000aa",
  safeAddress: "0x00000000000000000000000000000000000000bb",
};

test("persists only versioned public signer metadata with checksum addresses", () => {
  const storage = storageWith();

  const stored = writePasskeyMetadata({ ...VALID, ignored: "secret" }, storage);

  assert.deepEqual(stored, {
    ...VALID,
    verifierAddress: "0x00000000000000000000000000000000000000AA",
    safeAddress: "0x00000000000000000000000000000000000000bb",
  });
  assert.deepEqual(JSON.parse(storage.value()), { version: 1, ...stored });
  assert.deepEqual(readPasskeyMetadata(storage), { status: "valid", metadata: stored });
});

test("distinguishes missing metadata from invalid metadata", () => {
  assert.deepEqual(readPasskeyMetadata(storageWith()), { status: "missing" });

  for (const invalid of [
    "{",
    JSON.stringify({ version: 2, ...VALID }),
    JSON.stringify({ version: 1, ...VALID, rawId: "not hex" }),
    JSON.stringify({ version: 1, ...VALID, coordinates: { ...VALID.coordinates, x: "0x12" } }),
    JSON.stringify({ version: 1, ...VALID, verifierAddress: "0x1234" }),
    JSON.stringify({ version: 1, ...VALID, safeAddress: "0x1234" }),
  ]) {
    const storage = storageWith(invalid);
    assert.deepEqual(readPasskeyMetadata(storage), { status: "invalid" });
    assert.equal(storage.value(), invalid, "invalid data must not be deleted or rewritten");
  }
});

test("rejects invalid metadata instead of coercing it during writes", () => {
  const storage = storageWith();
  assert.throws(
    () => writePasskeyMetadata({ ...VALID, rawId: "xyz" }, storage),
    /passkey metadata/i,
  );
  assert.equal(storage.value(), null);
});
