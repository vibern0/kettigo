import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";

const fixture = vi.hoisted(() => {
  const address = "0x00000000000000000000000000000000000000AA" as const;
  return {
    address,
    decrypt: vi.fn(),
    restore: vi.fn(),
    prepare: vi.fn(),
    send: vi.fn(),
    sign: vi.fn(),
  };
});

vi.mock("@/lib/confidential-balances", () => ({
  decryptConfidentialBalances: fixture.decrypt,
}));
vi.mock("@/lib/passkey-metadata", () => ({
  readPasskeyMetadata: () => ({ status: "valid", metadata: {} }),
}));
vi.mock("@/lib/passkey-safe", () => ({
  createPasskeyAccount: vi.fn(),
  restorePasskeyAccount: fixture.restore,
}));
vi.mock("@/lib/passkey-webauthn", () => ({ isPasskeySupported: () => true }));
vi.mock("@/lib/contracts", () => ({
  PIMLICO_API_KEY: "available",
  CONTRACTS: { confidentialPrizePool: "0x00000000000000000000000000000000000000bb" },
}));
vi.mock("@/lib/zama", () => ({ clearSmartZamaSession: vi.fn() }));

import { WalletProvider, useWallet } from "@/lib/wallet-context";
import { ZamaReadSessionAccessRequiredError } from "@/lib/zama-session-manager";

function WalletState() {
  const wallet = useWallet();
  return <output>{wallet.confidentialBalancesReadState}</output>;
}

beforeEach(() => {
  fixture.decrypt.mockReset();
  fixture.prepare.mockReset();
  fixture.send.mockReset();
  fixture.sign.mockReset();
  fixture.restore.mockResolvedValue({
    address: fixture.address,
    prepareTransaction: fixture.prepare,
    sendTransaction: fixture.send,
    signTypedData: fixture.sign,
  });
});

test("WalletProvider marks automatic balance loading as access-required without preparing or sending", async () => {
  fixture.decrypt.mockRejectedValue(new ZamaReadSessionAccessRequiredError());

  render(
    <WalletProvider>
      <WalletState />
    </WalletProvider>,
  );

  await waitFor(() => expect(screen.getByText("access-required")).toBeTruthy());
  expect(fixture.decrypt).toHaveBeenCalledTimes(1);
  expect(fixture.prepare).not.toHaveBeenCalled();
  expect(fixture.send).not.toHaveBeenCalled();
  expect(fixture.sign).not.toHaveBeenCalled();
});

test("WalletProvider keeps ordinary balance read failures distinct from access-required", async () => {
  fixture.decrypt.mockRejectedValue(new Error("SDK 500"));

  render(
    <WalletProvider>
      <WalletState />
    </WalletProvider>,
  );

  await waitFor(() => expect(screen.getByText("error")).toBeTruthy());
  expect(fixture.prepare).not.toHaveBeenCalled();
  expect(fixture.send).not.toHaveBeenCalled();
  expect(fixture.sign).not.toHaveBeenCalled();
});

test("WalletProvider discards a late balance result after sign-out", async () => {
  let resolveBalances:
    ((value: { confidentialBalance: bigint; principal: bigint }) => void) | undefined;
  fixture.decrypt.mockReturnValue(
    new Promise((resolve) => {
      resolveBalances = resolve;
    }),
  );

  function Controls() {
    const wallet = useWallet();
    return (
      <>
        <WalletState />
        <button onClick={() => void wallet.disconnect()}>sign out</button>
      </>
    );
  }

  render(
    <WalletProvider>
      <Controls />
    </WalletProvider>,
  );
  await waitFor(() => expect(fixture.decrypt).toHaveBeenCalledTimes(1));
  await act(async () => screen.getByRole("button", { name: "sign out" }).click());
  await act(async () => resolveBalances?.({ confidentialBalance: 9n, principal: 7n }));

  expect(screen.getByText("idle")).toBeTruthy();
});
