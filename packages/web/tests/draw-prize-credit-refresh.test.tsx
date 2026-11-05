import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { beforeEach, expect, test, vi } from "vitest";
import { entryPoint07Address } from "viem/account-abstraction";
import { SafeUserOperationPendingError } from "@/lib/passkey-operation";

const fixture = vi.hoisted(() => {
  const account = "0x1111111111111111111111111111111111111111" as const;
  const pool = "0x3333333333333333333333333333333333333333" as `0x${string}`;
  return {
    account,
    pool,
    alternateAccount: "0x4444444444444444444444444444444444444444" as const,
    alternatePool: "0x5555555555555555555555555555555555555555" as const,
    aggregate: `0x${"1".repeat(64)}` as `0x${string}`,
    aggregateRead: vi.fn(),
    readContract: vi.fn(),
    mode: "legacy1",
    membership: 0n,
    pending: { requested: false },
    decrypt: vi.fn(),
    prepare: vi.fn(),
    refreshBalances: vi.fn(),
    refreshSnapshot: vi.fn(),
    recover: vi.fn(),
    session: undefined as any,
  };
});

vi.mock("viem", async (original) => ({
  ...(await original<typeof import("viem")>()),
  createPublicClient: () => ({
    getBlockNumber: async () => 0n,
    readContract: (args: { functionName: string; address: `0x${string}` }) => fixture.readContract(args),
    request: async () => [],
    watchBlockNumber: () => () => {},
  }),
}));
vi.mock("wagmi", () => ({ useBlockNumber: () => ({ data: undefined }) }));
vi.mock("@/lib/contracts", async (original) => ({
  ...(await original<typeof import("@/lib/contracts")>()),
  CONTRACTS: {
    usdc: fixture.account,
    confidentialUsdc: "0x2222222222222222222222222222222222222222",
    get confidentialPrizePool() {
      return fixture.pool;
    },
  },
}));
vi.mock("@/lib/runtime-config", () => ({
  publicConfig: (name: string, fallback?: string) =>
    name === "NEXT_PUBLIC_POOL_VERSION" ? fixture.mode : (fallback ?? ""),
}));
vi.mock("@/lib/wallet-context", () => ({
  useWallet: () => ({
    session: fixture.session,
    refreshConfidentialBalances: fixture.refreshBalances,
  }),
}));
vi.mock("@/lib/zama", async () => ({
  asChecksumAddress: (await vi.importActual<typeof import("viem")>("viem")).getAddress,
  decryptExistingSmartUint64: fixture.decrypt,
  decryptSmartUint64: fixture.decrypt,
  isZeroEncryptedHandle: (value: string) => value === `0x${"0".repeat(64)}`,
}));
vi.mock("@/lib/morpho-yield", () => ({
  createLatestBlockRefresher: () => ({ dispose() {}, refresh: fixture.refreshSnapshot }),
}));
vi.mock("@/lib/client-errors", () => ({ reportClientError: vi.fn(), reportClientToast: vi.fn() }));
vi.mock("canvas-confetti", () => ({
  default: { create: () => Object.assign(() => {}, { reset() {} }) },
}));

import DrawPage from "@/app/draw/page";
import { ActionCenterProvider } from "@/components/ActionCenter";
import { ToastProvider } from "@/components/Toast";

function tree() {
  return (
    <ToastProvider>
      <ActionCenterProvider>
        <DrawPage />
      </ActionCenterProvider>
    </ToastProvider>
  );
}

function mount() {
  return render(tree());
}

function operation() {
  return {
    chainId: 11155111 as const,
    entryPoint: entryPoint07Address,
    sender: fixture.account,
    userOperationHash: `0x${"a".repeat(64)}` as const,
  };
}

beforeEach(() => {
  localStorage.clear();
  fixture.aggregate = `0x${"1".repeat(64)}`;
  fixture.aggregateRead.mockReset();
  fixture.aggregateRead.mockImplementation(() => fixture.aggregate);
  fixture.readContract.mockReset();
  fixture.readContract.mockImplementation(({ functionName }) => {
    if (functionName === "encryptedWinningsOf") return fixture.aggregateRead();
    if (functionName === "membershipIndexOf") return fixture.membership;
    if (functionName === "pendingAdmissionOf") return fixture.pending;
    return 0n;
  });
  fixture.mode = "legacy1";
  fixture.membership = 0n;
  fixture.pending = { requested: false };
  fixture.decrypt.mockReset();
  fixture.prepare.mockReset();
  fixture.refreshBalances.mockReset();
  fixture.refreshSnapshot.mockReset();
  fixture.recover.mockReset();
  fixture.decrypt.mockResolvedValue(5_000_000n);
  fixture.refreshSnapshot.mockResolvedValue(undefined);
  fixture.session = {
    address: fixture.account,
    getPendingOperation: vi.fn(() => null),
    prepareTransaction: fixture.prepare,
    recoverPendingOperation: fixture.recover,
  };
});

test.each([
  ["Claim prize", "claimPrize"],
  ["Add prize to savings", "claimPrizeToSavings"],
] as const)(
  "%s refreshes the consumed aggregate and balances only after canonical completion",
  async (label, _method) => {
    const send = vi.fn(async ({ onOperationPrepared }) => {
      onOperationPrepared(operation());
      fixture.aggregate = `0x${"0".repeat(64)}`;
      return `0x${"b".repeat(64)}` as const;
    });
    fixture.prepare.mockResolvedValue({ cancel: vi.fn(), send });

    mount();
    fireEvent.click(screen.getByRole("button", { name: "Check prize" }));
    fireEvent.click(await screen.findByRole("button", { name: label }));
    fireEvent.click(await screen.findByRole("button", { name: "Confirm" }));

    await waitFor(() => expect(screen.getByText("Nothing ready to claim")).toBeTruthy());
    expect(fixture.decrypt).toHaveBeenCalledTimes(1);
    expect(fixture.refreshBalances).toHaveBeenCalledTimes(1);
    expect(fixture.refreshSnapshot).toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(1);
  },
);

test("a matching Activity completion refreshes an uncertain credited action without another send", async () => {
  const observed = operation();
  const send = vi.fn(({ onOperationPrepared }) => {
    onOperationPrepared(observed);
    throw new SafeUserOperationPendingError(observed);
  });
  fixture.prepare.mockResolvedValue({ cancel: vi.fn(), send });
  fixture.recover.mockResolvedValue({
    state: "confirmed",
    operation: observed,
    transactionHash: `0x${"c".repeat(64)}`,
  });

  mount();
  fireEvent.click(screen.getByRole("button", { name: "Check prize" }));
  fireEvent.click(await screen.findByRole("button", { name: "Claim prize" }));
  fireEvent.click(await screen.findByRole("button", { name: "Confirm" }));
  await screen.findByRole("button", { name: /^Activity/ });
  fixture.aggregate = `0x${"0".repeat(64)}`;
  fireEvent.click(screen.getByRole("button", { name: /^Activity/ }));
  fireEvent.click(await screen.findByRole("button", { name: "Check status" }));

  await waitFor(() => expect(screen.getByText("Nothing ready to claim")).toBeTruthy());
  expect(fixture.refreshBalances).toHaveBeenCalledTimes(1);
  expect(send).toHaveBeenCalledTimes(1);
});

test("reinvest refreshes an unadmitted member's current participation status", async () => {
  fixture.mode = "2";
  fixture.pending = { requested: true };
  fixture.prepare.mockResolvedValue({
    cancel: vi.fn(),
    send: async ({
      onOperationPrepared,
    }: {
      onOperationPrepared: (value: ReturnType<typeof operation>) => void;
    }) => {
      onOperationPrepared(operation());
      fixture.aggregate = `0x${"0".repeat(64)}`;
      return `0x${"b".repeat(64)}` as const;
    },
  });

  mount();
  fireEvent.click(screen.getByRole("button", { name: "Check prize" }));
  fireEvent.click(await screen.findByRole("button", { name: "Add prize to savings" }));
  fireEvent.click(await screen.findByRole("button", { name: "Confirm" }));

  expect(
    await screen.findByText(
      "Your savings are waiting to be included in a future draw. Review participation in Savings.",
    ),
  ).toBeTruthy();
});

test("a post-completion display read can refresh without resending the credited action", async () => {
  const send = vi.fn(async ({ onOperationPrepared }) => {
    onOperationPrepared(operation());
    fixture.aggregate = `0x${"0".repeat(64)}`;
    return `0x${"b".repeat(64)}` as const;
  });
  fixture.prepare.mockResolvedValue({ cancel: vi.fn(), send });
  fixture.refreshBalances.mockRejectedValueOnce(new Error("balance read unavailable"));

  mount();
  fireEvent.click(screen.getByRole("button", { name: "Check prize" }));
  fireEvent.click(await screen.findByRole("button", { name: "Claim prize" }));
  fireEvent.click(await screen.findByRole("button", { name: "Confirm" }));

  fireEvent.click(await screen.findByRole("button", { name: "Refresh winnings" }));
  await waitFor(() => expect(screen.getByText("Nothing ready to claim")).toBeTruthy());
  expect(send).toHaveBeenCalledTimes(1);
  expect(fixture.refreshBalances).toHaveBeenCalledTimes(2);
});

test("cancels a late unused credit preparation after the Draw mode changes", async () => {
  let resolvePrepare!: (value: { cancel: () => void; send: () => Promise<`0x${string}`> }) => void;
  const cancel = vi.fn();
  fixture.prepare.mockImplementation(
    () =>
      new Promise((resolve) => {
        resolvePrepare = resolve;
      }),
  );

  const rendered = mount();
  fireEvent.click(screen.getByRole("button", { name: "Check prize" }));
  fireEvent.click(await screen.findByRole("button", { name: "Claim prize" }));
  fixture.mode = "2";
  rendered.rerender(tree());
  resolvePrepare({ cancel, send: async () => `0x${"d".repeat(64)}` });

  await waitFor(() => expect(cancel).toHaveBeenCalledTimes(1));
  expect(screen.queryByRole("button", { name: "Confirm" })).toBeNull();
});

test("ignores a late aggregate reveal after the selected pool changes", async () => {
  let resolveAggregate!: (value: `0x${string}`) => void;
  fixture.aggregateRead.mockReturnValue(
    new Promise<`0x${string}`>((resolve) => {
      resolveAggregate = resolve;
    }),
  );
  const rendered = mount();
  fireEvent.click(screen.getByRole("button", { name: "Check prize" }));
  fixture.pool = fixture.alternatePool;
  rendered.rerender(tree());
  resolveAggregate(`0x${"1".repeat(64)}`);

  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(screen.queryByText("5.000000 USDC")).toBeNull();
});
