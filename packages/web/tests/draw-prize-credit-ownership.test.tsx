import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { beforeEach, expect, test, vi } from "vitest";
import { entryPoint07Address } from "viem/account-abstraction";
import { ZamaReadSessionAccessRequiredError } from "@/lib/zama-session-manager";

const fixture = vi.hoisted(() => {
  const account = "0x1111111111111111111111111111111111111111" as const;
  const pool = "0x3333333333333333333333333333333333333333" as const;
  return {
    account,
    pool,
    decrypt: vi.fn(),
    getPendingOperation: vi.fn(),
    mode: "2",
    prepareTransaction: vi.fn(),
    prepareCheck: vi.fn(),
    readCalls: vi.fn(),
    reader: vi.fn(),
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
  prepareSmartReadSessionCalls: fixture.readCalls,
}));
vi.mock("@/lib/prize-check-coordinator", () => ({
  createPrizeCheckCoordinator: () => ({
    pending: () => null,
    prepare: fixture.prepareCheck,
    review: async () => ({ drawId: 12n, proof: {}, state: "ready" }),
  }),
  createPrizeCheckIntentStore: vi.fn(),
  createViemPrizeChainReader: fixture.reader,
  createViemPrizeProofClient: () => ({ listDraws: async () => ({ draws: [], kind: "draws" }) }),
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

function operation(char: string) {
  return {
    chainId: 11155111 as const,
    entryPoint: entryPoint07Address,
    sender: fixture.account,
    userOperationHash: `0x${char.repeat(64)}` as `0x${string}`,
  };
}

async function revealCredit() {
  fireEvent.click(screen.getByRole("button", { name: "Check prize" }));
  await screen.findByRole("button", { name: "Claim prize" });
}

async function selectRound() {
  await screen.findByText("Your past results");
  fireEvent.change(screen.getByRole("spinbutton", { name: "Round number" }), {
    target: { value: "12" },
  });
  fireEvent.click(screen.getByRole("button", { name: "View round" }));
}

function actions() {
  return JSON.parse(screen.getByTestId("actions").textContent ?? "[]") as unknown[];
}

beforeEach(() => {
  localStorage.clear();
  fixture.decrypt.mockReset();
  fixture.getPendingOperation.mockReset();
  fixture.prepareCheck.mockReset();
  fixture.prepareTransaction.mockReset();
  fixture.readCalls.mockReset();
  fixture.reader.mockReset();
  fixture.decrypt.mockResolvedValue(5_000_000n);
  fixture.getPendingOperation.mockReturnValue(null);
  fixture.readCalls.mockResolvedValue([]);
  fixture.session = {
    address: fixture.account,
    getPendingOperation: fixture.getPendingOperation,
    prepareTransaction: fixture.prepareTransaction,
  };
  fixture.reader.mockReturnValue({
    readAward: vi.fn(async () => `0x${"2".repeat(64)}`),
    readBlockHash: vi.fn(async () => `0x${"a".repeat(64)}`),
    readChecked: vi.fn(async () => false),
  });
});

test("parent claim replaces unused historical access Ready once while retaining its checked round", async () => {
  const cancelAccess = vi.fn();
  fixture.reader.mockReturnValue({
    readAward: vi.fn(async () => `0x${"2".repeat(64)}`),
    readBlockHash: vi.fn(async () => `0x${"a".repeat(64)}`),
    readChecked: vi.fn(async () => true),
  });
  fixture.decrypt
    .mockResolvedValueOnce(5_000_000n)
    .mockRejectedValueOnce(new ZamaReadSessionAccessRequiredError());
  fixture.prepareTransaction
    .mockResolvedValueOnce({ cancel: cancelAccess, send: vi.fn() })
    .mockResolvedValueOnce({ cancel: vi.fn(), send: vi.fn() });

  mount();
  await revealCredit();
  await selectRound();
  fireEvent.click(await screen.findByRole("button", { name: "Review access" }));
  await screen.findByRole("button", { name: "Confirm" });
  fireEvent.click(screen.getByRole("button", { name: "Claim prize" }));

  await waitFor(() => expect(cancelAccess).toHaveBeenCalledTimes(1));
  expect(await screen.findByText("Result checked")).toBeTruthy();
  expect(screen.getByText("Round #12")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Confirm" })).toBeTruthy();
  expect(fixture.prepareCheck).not.toHaveBeenCalled();
});

test("parent confirmation refuses repeated parent confirmation and child review until its exact operation is observed", async () => {
  let observe!: (value: ReturnType<typeof operation>) => void;
  let rejectSend!: (reason: Error) => void;
  const parentOperation = operation("c");
  const parentCancel = vi.fn();
  const parentSend = vi.fn(({ onOperationPrepared }) => {
    observe = onOperationPrepared;
    return new Promise<`0x${string}`>((_resolve, reject) => {
      rejectSend = reject;
    });
  });
  fixture.prepareTransaction.mockResolvedValue({ cancel: parentCancel, send: parentSend });

  mount();
  await revealCredit();
  fireEvent.click(screen.getByRole("button", { name: "Claim prize" }));
  fireEvent.click(await screen.findByRole("button", { name: "Confirm" }));
  expect(parentSend).toHaveBeenCalledTimes(1);

  fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
  await selectRound();
  fireEvent.click(await screen.findByRole("button", { name: "Review check" }));
  expect(fixture.prepareTransaction).toHaveBeenCalledTimes(1);
  expect(fixture.prepareCheck).not.toHaveBeenCalled();
  expect(parentCancel).not.toHaveBeenCalled();

  fixture.getPendingOperation.mockReturnValue(parentOperation);
  observe(parentOperation);
  rejectSend(new Error("native signing interrupted"));
  await waitFor(() => expect(actions()).toHaveLength(1));
  expect(screen.getByTestId("actions").textContent).toContain(parentOperation.userOperationHash);
  expect(fixture.prepareTransaction).toHaveBeenCalledTimes(1);
});

test("child access confirmation refuses a parent credited review until its exact operation settles", async () => {
  let resolveAccess!: (hash: `0x${string}`) => void;
  const childOperation = operation("d");
  const childCancel = vi.fn();
  const childSend = vi.fn(({ onOperationPrepared }) => {
    onOperationPrepared(childOperation);
    return new Promise<`0x${string}`>((resolve) => {
      resolveAccess = resolve;
    });
  });
  fixture.reader.mockReturnValue({
    readAward: vi.fn(async () => `0x${"2".repeat(64)}`),
    readBlockHash: vi.fn(async () => `0x${"a".repeat(64)}`),
    readChecked: vi.fn(async () => true),
  });
  fixture.decrypt
    .mockResolvedValueOnce(5_000_000n)
    .mockRejectedValueOnce(new ZamaReadSessionAccessRequiredError())
    .mockResolvedValueOnce(5_000_000n);
  fixture.prepareTransaction.mockResolvedValue({ cancel: childCancel, send: childSend });

  mount();
  await revealCredit();
  await selectRound();
  fireEvent.click(await screen.findByRole("button", { name: "Review access" }));
  fireEvent.click(await screen.findByRole("button", { name: "Confirm" }));
  expect(childSend).toHaveBeenCalledTimes(1);

  fireEvent.click(screen.getByRole("button", { name: "Claim prize" }));
  expect(fixture.prepareTransaction).toHaveBeenCalledTimes(1);
  expect(childCancel).not.toHaveBeenCalled();
  await waitFor(() => expect(actions()).toHaveLength(1));
  expect(screen.getByTestId("actions").textContent).toContain(childOperation.userOperationHash);

  resolveAccess(`0x${"e".repeat(64)}`);
  await screen.findByText("Result checked");
});
