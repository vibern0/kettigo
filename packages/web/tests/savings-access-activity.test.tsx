import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { entryPoint07Address } from "viem/account-abstraction";

const fixture = vi.hoisted(() => ({
  account: "0x1111111111111111111111111111111111111111" as const,
  prepare: vi.fn(), send: vi.fn(), refresh: vi.fn(), readCalls: vi.fn(),
  pending: null as any,
  getterFails: false,
  session: undefined as any,
}));
vi.mock("viem", async (original) => ({ ...(await original<typeof import("viem")>()), createPublicClient: () => ({ readContract: async () => 0n, getBlockNumber: async () => 0n, request: async () => [], watchBlockNumber: () => () => {} }) }));
vi.mock("@/lib/contracts", async (original) => ({ ...(await original<typeof import("@/lib/contracts")>()), CONTRACTS: { usdc: fixture.account, confidentialUsdc: "0x2222222222222222222222222222222222222222", confidentialPrizePool: "0x3333333333333333333333333333333333333333" } }));
vi.mock("@/lib/wallet-context", () => ({ useWallet: () => ({ session: fixture.session, principal: undefined, confidentialBalancesLoading: false, confidentialBalancesError: null, confidentialBalancesReadState: "access-required", refreshConfidentialBalances: fixture.refresh }) }));
vi.mock("@/lib/smart-session", () => ({ sendSmartTransaction: vi.fn(), sendSmartTransactionBatch: vi.fn() }));
vi.mock("@/lib/zama", async () => ({ asChecksumAddress: (await vi.importActual<typeof import("viem")>("viem")).getAddress, createPublicZamaSDK: vi.fn(), decryptPublicUint64: vi.fn(), encryptUint64: vi.fn(), withSmartZamaSDK: vi.fn(), prepareSmartReadSessionCalls: fixture.readCalls }));
vi.mock("@/lib/client-errors", () => ({ reportClientToast: vi.fn(), reportClientError: vi.fn() }));

import SavingsPage from "@/app/savings/page";
import { ActionCenterProvider } from "@/components/ActionCenter";
import { ToastProvider } from "@/components/Toast";

beforeEach(() => {
  localStorage.clear(); fixture.prepare.mockReset(); fixture.send.mockReset(); fixture.refresh.mockReset(); fixture.readCalls.mockReset();
  fixture.readCalls.mockResolvedValue([{ to: fixture.account, data: "0x" }]);
  fixture.pending = null; fixture.getterFails = false;
  fixture.session = { address: fixture.account, prepareTransaction: fixture.prepare, getPendingOperation: () => { if (fixture.getterFails) throw new Error("stored secret"); return fixture.pending; }, recoverPendingOperation: vi.fn(async () => ({ state: "pending", operation: fixture.pending })) };
  fixture.prepare.mockResolvedValue({ cancel() {}, send: fixture.send });
  fixture.send.mockImplementation(({ onOperationPrepared }) => {
    const operation = { chainId: 11155111 as const, entryPoint: entryPoint07Address, sender: fixture.account, userOperationHash: `0x${"a".repeat(64)}` as const };
    fixture.pending = { ...operation, createdAt: 1, phase: "attempted" as const };
    onOperationPrepared(operation);
    throw new Error("gateway request body secret");
  });
});

test("attempted access approval is immediately recoverable in Activity without a retry", async () => {
  render(<ToastProvider><ActionCenterProvider><SavingsPage /></ActionCenterProvider></ToastProvider>);
  await new Promise((done) => setTimeout(done, 0));
  fireEvent.click(screen.getByRole("button", { name: "Review access" }));
  fireEvent.click(await screen.findByRole("button", { name: "Confirm" }));
  await waitFor(() => expect(fixture.send).toHaveBeenCalledTimes(1));
  fireEvent.click(await screen.findByRole("button", { name: /Activity/i }));
  expect((await screen.findAllByText(/Still processing/)).length).toBeGreaterThan(0);
  expect(screen.getByRole("button", { name: "Check status" })).toBeTruthy();
  expect(screen.queryByText("Failed")).toBeNull();
  expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  expect(document.body.textContent).not.toContain("gateway request body secret");
});

test("a pending getter failure retains the captured attempted identity as checkable Activity", async () => {
  fixture.send.mockImplementation(({ onOperationPrepared }) => {
    const operation = { chainId: 11155111 as const, entryPoint: entryPoint07Address, sender: fixture.account, userOperationHash: `0x${"b".repeat(32)}` as const };
    onOperationPrepared(operation); fixture.getterFails = true; throw new Error("gateway secret");
  });
  render(<ToastProvider><ActionCenterProvider><SavingsPage /></ActionCenterProvider></ToastProvider>);
  await new Promise((done) => setTimeout(done, 0));
  fireEvent.click(screen.getByRole("button", { name: "Review access" }));
  fireEvent.click(await screen.findByRole("button", { name: "Confirm" }));
  fireEvent.click(await screen.findByRole("button", { name: /Activity/i }));
  expect(await screen.findByRole("button", { name: "Check status" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  expect(document.body.textContent).not.toContain("stored secret");
});
