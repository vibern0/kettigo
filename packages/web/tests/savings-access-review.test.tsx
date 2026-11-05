import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  account: "0x1111111111111111111111111111111111111111" as const,
  prepare: vi.fn(),
  send: vi.fn(),
  refresh: vi.fn(),
  readCalls: vi.fn(),
  session: undefined as { address: `0x${string}`; prepareTransaction: typeof vi.fn } | undefined,
}));

vi.mock("viem", async (original) => ({
  ...(await original<typeof import("viem")>()),
  createPublicClient: () => ({
    readContract: async () => 0n,
    getBlockNumber: async () => 0n,
    request: async () => [],
    watchBlockNumber: () => () => {},
  }),
}));
vi.mock("@/lib/contracts", async (original) => ({
  ...(await original<typeof import("@/lib/contracts")>()),
  CONTRACTS: {
    usdc: fixture.account,
    confidentialUsdc: "0x2222222222222222222222222222222222222222",
    confidentialPrizePool: "0x3333333333333333333333333333333333333333",
  },
}));
vi.mock("@/lib/wallet-context", () => ({
  useWallet: () => ({
    session: fixture.session,
    principal: undefined,
    confidentialBalancesLoading: false,
    confidentialBalancesError: null,
    confidentialBalancesReadState: "access-required",
    refreshConfidentialBalances: fixture.refresh,
  }),
}));
vi.mock("@/lib/smart-session", () => ({
  sendSmartTransaction: vi.fn(),
  sendSmartTransactionBatch: vi.fn(),
}));
vi.mock("@/lib/zama", async () => ({
  asChecksumAddress: (await vi.importActual<typeof import("viem")>("viem")).getAddress,
  createPublicZamaSDK: vi.fn(),
  decryptPublicUint64: vi.fn(),
  encryptUint64: vi.fn(),
  withSmartZamaSDK: vi.fn(),
  prepareSmartReadSessionCalls: fixture.readCalls,
}));
vi.mock("@/components/ActionCenter", () => ({ useActionCenter: () => ({ runAction: vi.fn() }) }));
vi.mock("@/lib/client-errors", () => ({ reportClientToast: vi.fn() }));

import SavingsPage from "@/app/savings/page";
import { ToastProvider } from "@/components/Toast";

function mount() {
  return render(
    <ToastProvider>
      <SavingsPage />
    </ToastProvider>,
  );
}

beforeEach(() => {
  fixture.prepare.mockReset();
  fixture.send.mockReset();
  fixture.refresh.mockReset();
  fixture.readCalls.mockReset();
  fixture.session = { address: fixture.account, prepareTransaction: fixture.prepare };
  fixture.readCalls.mockResolvedValue([{ to: fixture.account, data: "0x" }]);
  fixture.prepare.mockResolvedValue({ cancel() {}, send: fixture.send });
  fixture.send.mockResolvedValue(`0x${"4".repeat(64)}`);
  fixture.refresh.mockResolvedValue(undefined);
});

test("Review access only prepares; Confirm sends the prepared operation once", async () => {
  mount();
  await new Promise((done) => setTimeout(done, 0));
  fireEvent.click(screen.getByRole("button", { name: "Review access" }));
  await screen.findByRole("button", { name: "Confirm" });
  expect(fixture.prepare).toHaveBeenCalledTimes(1);
  expect(fixture.send).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
  await waitFor(() => expect(fixture.send).toHaveBeenCalledTimes(1));
  expect(fixture.prepare).toHaveBeenCalledTimes(1);
  await waitFor(() => expect(fixture.refresh).toHaveBeenCalledTimes(1));
});

test("switching from a ready access review to Deposit cancels its prepared operation", async () => {
  const cancel = vi.fn();
  fixture.prepare.mockResolvedValue({ cancel, send: fixture.send });
  mount();
  await new Promise((done) => setTimeout(done, 0));
  fireEvent.click(screen.getByRole("button", { name: "Review access" }));
  await screen.findByRole("button", { name: "Confirm" });
  fireEvent.click(screen.getByRole("button", { name: "Deposit" }));
  expect(cancel).toHaveBeenCalledTimes(1);
});
