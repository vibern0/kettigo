import { beforeEach, expect, test, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  handles: [`0x${"11".repeat(32)}`, `0x${"22".repeat(32)}`],
  existingRead: vi.fn(),
  legacyRead: vi.fn(),
}));

vi.mock("viem", async (original) => ({
  ...(await original<typeof import("viem")>()),
  createPublicClient: () => ({
    readContract: vi.fn(async ({ functionName }: { functionName: string }) =>
      functionName === "confidentialBalanceOf" ? fixture.handles[0] : fixture.handles[1],
    ),
  }),
}));
vi.mock("@/lib/contracts", () => ({
  CONTRACTS: {
    confidentialUsdc: "0x00000000000000000000000000000000000000AA",
    confidentialPrizePool: "0x00000000000000000000000000000000000000bb",
  },
  RPC_URL: "",
  confidentialPrizePoolAbi: [],
  confidentialUsdcAbi: [],
}));
vi.mock("@/lib/zama", async () => {
  const { getAddress } = await vi.importActual<typeof import("viem")>("viem");
  return {
    asChecksumAddress: getAddress,
    clearValueToBigInt: BigInt,
    decryptWithExistingSmartReadSession: fixture.existingRead,
    decryptWithSmartReadSession: fixture.legacyRead,
    isZeroEncryptedHandle: (handle: string) => handle === `0x${"00".repeat(32)}`,
  };
});

import { decryptConfidentialBalances } from "@/lib/confidential-balances";
import { ZamaReadSessionAccessRequiredError } from "@/lib/zama-session-manager";
import type { PasskeySmartSession } from "@/lib/smart-session";

const session = {
  address: "0x00000000000000000000000000000000000000cc" as const,
  prepareTransaction: vi.fn(),
  sendTransaction: vi.fn(),
  signTypedData: vi.fn(),
} satisfies PasskeySmartSession;

beforeEach(() => {
  fixture.existingRead.mockReset();
  fixture.legacyRead.mockReset();
  session.prepareTransaction.mockReset();
  session.sendTransaction.mockReset();
  session.signTypedData.mockReset();
});

test("decryptConfidentialBalances propagates missing existing access without a legacy read or wallet action", async () => {
  fixture.handles = [`0x${"11".repeat(32)}`, `0x${"22".repeat(32)}`];
  fixture.existingRead.mockRejectedValueOnce(new ZamaReadSessionAccessRequiredError());

  await expect(decryptConfidentialBalances(session)).rejects.toBeInstanceOf(
    ZamaReadSessionAccessRequiredError,
  );
  expect(fixture.existingRead).toHaveBeenCalledOnce();
  expect(fixture.legacyRead).not.toHaveBeenCalled();
  expect(session.prepareTransaction).not.toHaveBeenCalled();
  expect(session.sendTransaction).not.toHaveBeenCalled();
  expect(session.signTypedData).not.toHaveBeenCalled();
});

test("decryptConfidentialBalances returns zero handles without starting a read session", async () => {
  fixture.handles = [`0x${"00".repeat(32)}`, `0x${"00".repeat(32)}`];

  await expect(decryptConfidentialBalances(session)).resolves.toEqual({
    confidentialBalance: 0n,
    principal: 0n,
  });
  expect(fixture.existingRead).not.toHaveBeenCalled();
  expect(fixture.legacyRead).not.toHaveBeenCalled();
});
