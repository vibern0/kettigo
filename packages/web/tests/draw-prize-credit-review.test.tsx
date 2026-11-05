import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { beforeEach, expect, test, vi } from "vitest";
import { encodeFunctionData } from "viem";
import { entryPoint07Address } from "viem/account-abstraction";
import { confidentialPrizePoolAbi } from "@/lib/contracts";

const fixture = vi.hoisted(() => {
  const account = "0x1111111111111111111111111111111111111111" as const;
  const pool = "0x3333333333333333333333333333333333333333" as const;
  return {
    account,
    pool,
    decrypt: vi.fn(),
    mode: "legacy1",
    prepareTransaction: vi.fn(),
    sendTransaction: vi.fn(),
    session: undefined as any,
  };
});

vi.mock("viem", async (original) => ({
  ...(await original<typeof import("viem")>()),
  createPublicClient: () => ({
    getBlockNumber: async () => 0n,
    readContract: async ({ functionName }: { functionName: string }) =>
      functionName === "encryptedWinningsOf" ? `0x${"1".repeat(64)}` : 0n,
    request: async () => [],
    waitForTransactionReceipt: async () => ({ status: "success" }),
    watchBlockNumber: () => () => {},
  }),
}));
vi.mock("wagmi", () => ({ useBlockNumber: () => ({ data: undefined }) }));
vi.mock("@/lib/contracts", async (original) => ({
  ...(await original<typeof import("@/lib/contracts")>()),
  CONTRACTS: {
    usdc: fixture.account,
    confidentialUsdc: "0x2222222222222222222222222222222222222222",
    confidentialPrizePool: fixture.pool,
  },
}));
vi.mock("@/lib/runtime-config", () => ({
  publicConfig: (name: string, fallback?: string) =>
    name === "NEXT_PUBLIC_POOL_VERSION"
      ? fixture.mode
      : name === "NEXT_PUBLIC_PROOF_SERVICE_URL"
        ? "https://proof.example"
        : (fallback ?? ""),
}));
vi.mock("@/lib/wallet-context", () => ({
  useWallet: () => ({ session: fixture.session, refreshConfidentialBalances: vi.fn() }),
}));
vi.mock("@/lib/zama", async () => ({
  asChecksumAddress: (await vi.importActual<typeof import("viem")>("viem")).getAddress,
  decryptExistingSmartUint64: fixture.decrypt,
  decryptSmartUint64: fixture.decrypt,
  isZeroEncryptedHandle: () => false,
}));
vi.mock("@/lib/morpho-yield", () => ({
  createLatestBlockRefresher: () => ({ dispose() {}, refresh: async () => {} }),
}));
vi.mock("@/lib/client-errors", () => ({ reportClientError: vi.fn(), reportClientToast: vi.fn() }));
vi.mock("canvas-confetti", () => ({
  default: { create: () => Object.assign(() => {}, { reset() {} }) },
}));

import DrawPage from "@/app/draw/page";
import { ActionCenterProvider, useActionCenter } from "@/components/ActionCenter";
import { ToastProvider } from "@/components/Toast";

function ActionProbe() {
  const { actions } = useActionCenter();
  return <output data-testid="actions">{JSON.stringify(actions)}</output>;
}

function mount() {
  return render(
    <ToastProvider>
      <ActionCenterProvider>
        <DrawPage />
        <ActionProbe />
      </ActionCenterProvider>
    </ToastProvider>,
  );
}

function operation(char = "a") {
  return {
    chainId: 11155111 as const,
    entryPoint: entryPoint07Address,
    sender: fixture.account,
    userOperationHash: `0x${char.repeat(64)}` as `0x${string}`,
  };
}

async function review(label: "Claim prize" | "Add prize to savings") {
  fireEvent.click(screen.getByRole("button", { name: "Check prize" }));
  await screen.findByRole("button", { name: label });
  fireEvent.click(screen.getByRole("button", { name: label }));
  return screen.findByRole("button", { name: "Confirm" });
}

function actionRecords() {
  return JSON.parse(screen.getByTestId("actions").textContent ?? "[]") as unknown[];
}

beforeEach(() => {
  localStorage.clear();
  fixture.mode = "legacy1";
  fixture.decrypt.mockReset();
  fixture.prepareTransaction.mockReset();
  fixture.sendTransaction.mockReset();
  fixture.decrypt.mockResolvedValue(5_000_000n);
  fixture.session = {
    address: fixture.account,
    getPendingOperation: vi.fn(() => null),
    prepareTransaction: fixture.prepareTransaction,
    sendTransaction: fixture.sendTransaction,
  };
});

test.each([
  ["legacy1", "Claim prize", "claimPrize"],
  ["legacy1", "Add prize to savings", "claimPrizeToSavings"],
  ["2", "Claim prize", "claimPrize"],
  ["2", "Add prize to savings", "claimPrizeToSavings"],
] as const)(
  "%s %s reviews the existing credit before one prepared %s confirmation",
  async (mode, label, method) => {
    fixture.mode = mode;
    const observed = operation(method === "claimPrize" ? "c" : "d");
    const send = vi.fn(async ({ onOperationPrepared }) => {
      onOperationPrepared(observed);
      return `0x${"e".repeat(64)}` as const;
    });
    fixture.prepareTransaction.mockResolvedValue({ cancel: vi.fn(), send });

    mount();
    const confirm = await review(label);

    expect(fixture.decrypt).toHaveBeenCalledTimes(1);
    expect(fixture.prepareTransaction).toHaveBeenCalledWith(
      [
        {
          to: fixture.pool,
          data: encodeFunctionData({
            abi: confidentialPrizePoolAbi,
            functionName: method,
            args: [],
          }),
        },
      ],
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(fixture.sendTransaction).not.toHaveBeenCalled();

    fireEvent.click(confirm);
    expect(send).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(actionRecords()).toHaveLength(1));
    expect(screen.getByTestId("actions").textContent).toContain(observed.userOperationHash);
  },
);

test("double Confirm in one turn sends, observes, and records the prepared action once", async () => {
  let resolveSend!: (hash: `0x${string}`) => void;
  const observed = operation("f");
  const send = vi.fn(({ onOperationPrepared }) => {
    onOperationPrepared(observed);
    return new Promise<`0x${string}`>((resolve) => {
      resolveSend = resolve;
    });
  });
  fixture.prepareTransaction.mockResolvedValue({ cancel: vi.fn(), send });

  mount();
  const confirm = await review("Claim prize");
  fireEvent.click(confirm);
  fireEvent.click(confirm);

  expect(send).toHaveBeenCalledTimes(1);
  await waitFor(() => expect(actionRecords()).toHaveLength(1));
  expect(screen.getByTestId("actions").textContent).toContain(observed.userOperationHash);
  resolveSend(`0x${"a".repeat(64)}`);
});
