import { expect, test } from "vitest";

import { decryptExistingSmartUint64 } from "@/lib/zama";
import type { PasskeySmartSession } from "@/lib/smart-session";

const ZERO_HANDLE = `0x${"00".repeat(32)}` as `0x${string}`;
const TOKEN = "0x00000000000000000000000000000000000000AA" as const;

test("existing-only uint64 reveal returns zero without constructing read access", async () => {
  const session = {
    address: "0x00000000000000000000000000000000000000Bb",
    async signTypedData() {
      throw new Error("must not sign");
    },
    async prepareTransaction() {
      throw new Error("must not prepare");
    },
    async sendTransaction() {
      throw new Error("must not send");
    },
  } satisfies PasskeySmartSession;

  await expect(decryptExistingSmartUint64(session, ZERO_HANDLE, TOKEN)).resolves.toBe(0n);
});

test("existing-only uint64 reveal observes an already-aborted scope before zero handling", async () => {
  const controller = new AbortController();
  controller.abort(new Error("account changed"));
  const session = {
    address: "0x00000000000000000000000000000000000000Bb",
    async signTypedData() {
      throw new Error("must not sign");
    },
    async prepareTransaction() {
      throw new Error("must not prepare");
    },
    async sendTransaction() {
      throw new Error("must not send");
    },
  } satisfies PasskeySmartSession;

  await expect(
    decryptExistingSmartUint64(session, ZERO_HANDLE, TOKEN, { signal: controller.signal }),
  ).rejects.toThrow("account changed");
});
