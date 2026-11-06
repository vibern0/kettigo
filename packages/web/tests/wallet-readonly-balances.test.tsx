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
    pool: "0x00000000000000000000000000000000000000bb",
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
  CONTRACTS: {
    get confidentialPrizePool() {
      return fixture.pool;
    },
  },
}));
vi.mock("@/lib/zama", () => ({ clearSmartZamaSession: vi.fn() }));

import { WalletProvider, useWallet } from "@/lib/wallet-context";
import { ZamaReadSessionAccessRequiredError } from "@/lib/zama-session-manager";

function WalletState() {
  const wallet = useWallet();
  return (
    <output>{`${wallet.confidentialBalancesReadState}:${wallet.confidentialBalance}:${wallet.principal}`}</output>
  );
}

beforeEach(() => {
  fixture.decrypt.mockReset();
  fixture.prepare.mockReset();
  fixture.send.mockReset();
  fixture.sign.mockReset();
  fixture.pool = "0x00000000000000000000000000000000000000bb";
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

  await waitFor(() => expect(screen.getByText("access-required:undefined:undefined")).toBeTruthy());
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

  await waitFor(() => expect(screen.getByText("error:undefined:undefined")).toBeTruthy());
  expect(fixture.prepare).not.toHaveBeenCalled();
  expect(fixture.send).not.toHaveBeenCalled();
  expect(fixture.sign).not.toHaveBeenCalled();
});

test("WalletProvider treats NotEntitled as a terminal automatic read failure without wallet activity", async () => {
  const error = new Error("read access denied");
  error.name = "NotEntitled";
  fixture.decrypt.mockRejectedValue(error);

  render(
    <WalletProvider>
      <WalletState />
    </WalletProvider>,
  );

  await waitFor(() => expect(screen.getByText("error:undefined:undefined")).toBeTruthy());
  expect(fixture.decrypt).toHaveBeenCalledTimes(1);
  expect(fixture.prepare).not.toHaveBeenCalled();
  expect(fixture.send).not.toHaveBeenCalled();
  expect(fixture.sign).not.toHaveBeenCalled();
});

test("WalletProvider preserves balances while a refresh loads and then fails", async () => {
  fixture.decrypt.mockResolvedValueOnce({ confidentialBalance: 9n, principal: 7n });
  let rejectRefresh: ((error: Error) => void) | undefined;
  fixture.decrypt.mockReturnValueOnce(
    new Promise((_, reject) => {
      rejectRefresh = reject;
    }),
  );

  function Controls() {
    const wallet = useWallet();
    return (
      <>
        <WalletState />
        <button onClick={() => void wallet.refreshConfidentialBalances()}>refresh</button>
      </>
    );
  }

  render(
    <WalletProvider>
      <Controls />
    </WalletProvider>,
  );
  await screen.findByText("ready:9:7");
  await act(async () => screen.getByRole("button", { name: "refresh" }).click());
  expect(screen.getByText("loading:9:7")).toBeTruthy();
  await act(async () => rejectRefresh?.(new Error("SDK 500")));

  await screen.findByText("error:9:7");
  expect(fixture.decrypt).toHaveBeenCalledTimes(2);
  expect(fixture.prepare).not.toHaveBeenCalled();
  expect(fixture.send).not.toHaveBeenCalled();
  expect(fixture.sign).not.toHaveBeenCalled();
});

test("WalletProvider discards an old account result after restoring a newer account", async () => {
  let resolveOld: ((value: { confidentialBalance: bigint; principal: bigint }) => void) | undefined;
  fixture.decrypt.mockReturnValueOnce(
    new Promise((resolve) => {
      resolveOld = resolve;
    }),
  );
  fixture.restore
    .mockResolvedValueOnce({
      address: fixture.address,
      prepareTransaction: fixture.prepare,
      sendTransaction: fixture.send,
      signTypedData: fixture.sign,
    })
    .mockResolvedValueOnce({
      address: "0x00000000000000000000000000000000000000DD",
      prepareTransaction: fixture.prepare,
      sendTransaction: fixture.send,
      signTypedData: fixture.sign,
    });
  fixture.decrypt.mockResolvedValueOnce({ confidentialBalance: 2n, principal: 1n });

  function Controls() {
    const wallet = useWallet();
    return (
      <>
        <WalletState />
        <button onClick={() => void wallet.connect()}>restore another account</button>
      </>
    );
  }

  render(
    <WalletProvider>
      <Controls />
    </WalletProvider>,
  );
  await waitFor(() => expect(fixture.decrypt).toHaveBeenCalledTimes(1));
  await act(async () => screen.getByRole("button", { name: "restore another account" }).click());
  await screen.findByText("ready:2:1");
  await act(async () => resolveOld?.({ confidentialBalance: 99n, principal: 88n }));

  expect(screen.getByText("ready:2:1")).toBeTruthy();
  expect(fixture.decrypt).toHaveBeenCalledTimes(2);
});

test("WalletProvider discards an old result when the selected pool scope changes during refresh", async () => {
  let resolveOld: ((value: { confidentialBalance: bigint; principal: bigint }) => void) | undefined;
  fixture.decrypt.mockReturnValueOnce(
    new Promise((resolve) => {
      resolveOld = resolve;
    }),
  );
  fixture.decrypt.mockResolvedValueOnce({ confidentialBalance: 2n, principal: 1n });

  function Controls() {
    const wallet = useWallet();
    return (
      <>
        <WalletState />
        <button onClick={() => void wallet.refreshConfidentialBalances()}>refresh pool</button>
      </>
    );
  }

  render(
    <WalletProvider>
      <Controls />
    </WalletProvider>,
  );
  await waitFor(() => expect(fixture.decrypt).toHaveBeenCalledTimes(1));
  fixture.pool = "0x00000000000000000000000000000000000000ee";
  await act(async () => screen.getByRole("button", { name: "refresh pool" }).click());
  await screen.findByText("ready:2:1");
  await act(async () => resolveOld?.({ confidentialBalance: 99n, principal: 88n }));

  expect(screen.getByText("ready:2:1")).toBeTruthy();
  expect(fixture.decrypt).toHaveBeenCalledTimes(2);
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

  expect(screen.getByText("idle:undefined:undefined")).toBeTruthy();
});
