import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { beforeEach, expect, test, vi } from "vitest";
import { encodeFunctionData } from "viem";
import { entryPoint07Address } from "viem/account-abstraction";
import { confidentialPrizePoolAbi } from "@/lib/contracts";
import {
  SafeUserOperationPendingError,
  SafeUserOperationRejectedError,
} from "@/lib/passkey-operation";

const fixture = vi.hoisted(() => {
  const account = "0x1111111111111111111111111111111111111111" as const;
  const pool = "0x3333333333333333333333333333333333333333" as const;
  return {
    account,
    pool,
    decrypt: vi.fn(),
    listDraws: vi.fn(),
    mode: "legacy1",
    proofUrl: "https://proof.example",
    prepareTransaction: vi.fn(),
    recoverPendingOperation: vi.fn(),
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
        ? fixture.proofUrl
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
vi.mock("@/lib/prize-check-coordinator", () => ({
  createPrizeCheckCoordinator: vi.fn(),
  createPrizeCheckIntentStore: vi.fn(),
  createViemPrizeChainReader: vi.fn(),
  createViemPrizeProofClient: () => ({ listDraws: fixture.listDraws }),
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
  fixture.proofUrl = "https://proof.example";
  fixture.decrypt.mockReset();
  fixture.listDraws.mockReset();
  fixture.prepareTransaction.mockReset();
  fixture.recoverPendingOperation.mockReset();
  fixture.sendTransaction.mockReset();
  fixture.decrypt.mockResolvedValue(5_000_000n);
  fixture.listDraws.mockResolvedValue({ kind: "draws", draws: [] });
  fixture.session = {
    address: fixture.account,
    getPendingOperation: vi.fn(() => null),
    prepareTransaction: fixture.prepareTransaction,
    recoverPendingOperation: fixture.recoverPendingOperation,
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

test.each(["Claim prize", "Add prize to savings"] as const)(
  "%s stays available when the mounted archive list rejects",
  async (label) => {
    fixture.mode = "2";
    fixture.listDraws.mockRejectedValue(new Error("archive unavailable"));
    const send = vi.fn(async ({ onOperationPrepared }) => {
      onOperationPrepared(operation("f"));
      return `0x${"e".repeat(64)}` as const;
    });
    fixture.prepareTransaction.mockResolvedValue({ cancel: vi.fn(), send });

    mount();
    await waitFor(() => expect(fixture.listDraws).toHaveBeenCalledTimes(1));
    fireEvent.click(await review(label));
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

    expect(send).toHaveBeenCalledTimes(1);
    expect(fixture.listDraws).toHaveBeenCalledTimes(1);
  },
);

test.each(["Claim prize", "Add prize to savings"] as const)(
  "%s stays available when no archive endpoint is configured",
  async (label) => {
    fixture.mode = "2";
    fixture.proofUrl = "";
    const send = vi.fn(async ({ onOperationPrepared }) => {
      onOperationPrepared(operation("8"));
      return `0x${"7".repeat(64)}` as const;
    });
    fixture.prepareTransaction.mockResolvedValue({ cancel: vi.fn(), send });

    mount();
    fireEvent.click(await review(label));
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

    expect(send).toHaveBeenCalledTimes(1);
    expect(fixture.listDraws).not.toHaveBeenCalled();
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

test("a known declined credited action releases its confirmed review after pending lookup fails", async () => {
  const observed = operation("b");
  const firstSend = vi.fn(({ onOperationPrepared }) => {
    onOperationPrepared(observed);
    throw new SafeUserOperationRejectedError(observed, 4001);
  });
  fixture.session.getPendingOperation = vi.fn(() => {
    throw new Error("pending reader unavailable");
  });
  fixture.prepareTransaction
    .mockResolvedValueOnce({ cancel: vi.fn(), send: firstSend })
    .mockResolvedValueOnce({ cancel: vi.fn(), send: vi.fn() });

  mount();
  fireEvent.click(await review("Claim prize"));
  await waitFor(() => expect(screen.getByTestId("actions").textContent).toContain("rejected"));
  expect(screen.getByTestId("actions").textContent).toContain(observed.userOperationHash);

  fireEvent.click(screen.getByRole("button", { name: "Claim prize" }));
  expect(await screen.findByRole("button", { name: "Confirm" })).toBeTruthy();
  expect(fixture.prepareTransaction).toHaveBeenCalledTimes(2);
});

test("a matching terminal status check releases an uncertain credited review without replaying it", async () => {
  const observed = operation("9");
  const firstSend = vi.fn(({ onOperationPrepared }) => {
    onOperationPrepared(observed);
    throw new SafeUserOperationPendingError(observed);
  });
  fixture.recoverPendingOperation.mockResolvedValue({
    state: "not-submitted",
    operation: observed,
  });
  fixture.prepareTransaction
    .mockResolvedValueOnce({ cancel: vi.fn(), send: firstSend })
    .mockResolvedValueOnce({ cancel: vi.fn(), send: vi.fn() });

  mount();
  fireEvent.click(await review("Add prize to savings"));
  await waitFor(() => expect(screen.getByTestId("actions").textContent).toContain("confirming"));
  fireEvent.click(screen.getByRole("button", { name: /^Activity/ }));
  fireEvent.click(await screen.findByRole("button", { name: "Check status" }));
  await waitFor(() => expect(screen.getByTestId("actions").textContent).toContain("not-submitted"));

  fireEvent.click(screen.getByRole("button", { name: "Add prize to savings" }));
  expect(await screen.findByRole("button", { name: "Confirm" })).toBeTruthy();
  expect(firstSend).toHaveBeenCalledTimes(1);
  expect(fixture.prepareTransaction).toHaveBeenCalledTimes(2);
});

test("an unrelated terminal status check does not unlock an uncertain credited review", async () => {
  const observed = operation("6");
  const unrelated = operation("5");
  const firstSend = vi.fn(({ onOperationPrepared }) => {
    onOperationPrepared(observed);
    throw new SafeUserOperationPendingError(observed);
  });
  fixture.recoverPendingOperation.mockResolvedValue({
    state: "not-submitted",
    operation: unrelated,
  });
  fixture.prepareTransaction.mockResolvedValue({ cancel: vi.fn(), send: firstSend });

  mount();
  fireEvent.click(await review("Claim prize"));
  await waitFor(() => expect(screen.getByTestId("actions").textContent).toContain("confirming"));
  fireEvent.click(screen.getByRole("button", { name: /^Activity/ }));
  fireEvent.click(await screen.findByRole("button", { name: "Check status" }));
  await waitFor(() => expect(fixture.recoverPendingOperation).toHaveBeenCalledTimes(1));

  fireEvent.click(screen.getByRole("button", { name: "Claim prize" }));
  expect(fixture.prepareTransaction).toHaveBeenCalledTimes(1);
  expect(firstSend).toHaveBeenCalledTimes(1);
});

test("reload status recovery never replays the original credited runner", async () => {
  const observed = operation("4");
  const firstSend = vi.fn(({ onOperationPrepared }) => {
    onOperationPrepared(observed);
    throw new SafeUserOperationPendingError(observed);
  });
  fixture.prepareTransaction
    .mockResolvedValueOnce({ cancel: vi.fn(), send: firstSend })
    .mockResolvedValueOnce({ cancel: vi.fn(), send: vi.fn() });

  const first = mount();
  fireEvent.click(await review("Claim prize"));
  await waitFor(() =>
    expect(screen.getByTestId("actions").textContent).toContain(observed.userOperationHash),
  );
  first.unmount();
  fixture.session.getPendingOperation = vi.fn(() => ({
    ...observed,
    createdAt: 1,
    phase: "attempted",
  }));
  fixture.recoverPendingOperation.mockResolvedValue({
    state: "not-submitted",
    operation: observed,
  });

  mount();
  fireEvent.click(await screen.findByRole("button", { name: /^Activity/ }));
  fireEvent.click(await screen.findByRole("button", { name: "Check status" }));
  await waitFor(() => expect(screen.getByTestId("actions").textContent).toContain("not-submitted"));
  expect(firstSend).toHaveBeenCalledTimes(1);
  expect(fixture.prepareTransaction).toHaveBeenCalledTimes(1);
});
