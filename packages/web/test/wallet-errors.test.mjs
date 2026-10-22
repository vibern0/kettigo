import test from "node:test";
import assert from "node:assert/strict";

import { getWalletError } from "../src/lib/wallet-errors.ts";

test("maps passkey cancellation to a retryable state", () => {
  assert.deepEqual(getWalletError(new DOMException("cancelled", "NotAllowedError")), {
    status: "cancelled",
    message: "Verification was cancelled. You can try again.",
  });
});

test("maps unsupported WebAuthn separately", () => {
  assert.deepEqual(getWalletError(new Error("WebAuthn is unavailable.")), {
    status: "unsupported",
    message: "This browser or device cannot create your account.",
  });
});

test("maps invalid saved metadata without hiding the address change", () => {
  assert.deepEqual(getWalletError(new Error("Invalid passkey metadata.")), {
    status: "invalid-metadata",
    message: "Saved account details cannot be used. Creating another account will give you a different address.",
  });
});

test("maps bundler and paymaster failures without discarding the session", () => {
  assert.deepEqual(getWalletError(new Error("Pimlico paymaster unavailable")), {
    status: "service-unavailable",
    message: "Account service is unavailable right now. Try again.",
  });
});

test("keeps diagnostics out of the generic user message", () => {
  assert.deepEqual(getWalletError(new Error("unexpected internal detail")), {
    status: "service-unavailable",
    message: "Could not open your account. Try again.",
  });
});
