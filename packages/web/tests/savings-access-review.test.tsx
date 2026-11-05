import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  account: "0x1111111111111111111111111111111111111111" as const,
  prepare: vi.fn(),
  send: vi.fn(),
  refresh: vi.fn(),
  readCalls: vi.fn(),
  encrypt: vi.fn(),
  walletBalance: 100_000_000n,
  principal: undefined as bigint | undefined,
  pool: "0x3333333333333333333333333333333333333333" as `0x${string}`,
  session: undefined as { address: `0x${string}`; prepareTransaction: typeof vi.fn } | undefined,
}));

vi.mock("viem", async (original) => ({
  ...(await original<typeof import("viem")>()),
  createPublicClient: () => ({
    readContract: async ({ functionName }: { functionName: string }) =>
      functionName === "balanceOf" ? fixture.walletBalance : 0n,
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
    get confidentialPrizePool() {
      return fixture.pool;
    },
  },
}));
vi.mock("@/lib/wallet-context", () => ({
  useWallet: () => ({
    session: fixture.session,
    principal: fixture.principal,
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
  encryptUint64: fixture.encrypt,
  withSmartZamaSDK: async (_session: unknown, action: (sdk: unknown) => unknown) => action({}),
  prepareSmartReadSessionCalls: fixture.readCalls,
}));
vi.mock("@/components/ActionCenter", () => ({
  useActionCenter: () => ({
    runAction: (_input: unknown, runner: (controls: { update: () => void }) => Promise<void>) => {
      void runner({ update() {} });
      return "access";
    },
  }),
}));
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
  fixture.encrypt.mockReset();
  fixture.walletBalance = 100_000_000n;
  fixture.principal = undefined;
  fixture.pool = "0x3333333333333333333333333333333333333333";
  fixture.session = { address: fixture.account, prepareTransaction: fixture.prepare };
  fixture.readCalls.mockResolvedValue([{ to: fixture.account, data: "0x" }]);
  fixture.encrypt.mockResolvedValue({ handle: `0x${"1".repeat(64)}`, inputProof: "0x" });
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

test("deposit Ready then withdrawal review cancels the unused deposit before preparing withdrawal", async () => {
  const events: string[] = [];
  const deposit = { cancel: vi.fn(() => events.push("deposit-cancel")), send: fixture.send };
  const withdrawal = { cancel: vi.fn(), send: fixture.send };
  fixture.principal = 50_000_000n;
  fixture.prepare.mockImplementation(async () => {
    events.push(`prepare-${fixture.prepare.mock.calls.length}`);
    return fixture.prepare.mock.calls.length === 1 ? deposit : withdrawal;
  });
  mount();
  await screen.findByText("100.00 USDC");
  fireEvent.click(screen.getByRole("button", { name: "Deposit" }));
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "10" } });
  fireEvent.click(screen.getByRole("button", { name: "Review deposit" }));
  await screen.findByRole("button", { name: "Confirm" });
  fireEvent.click(screen.getByRole("button", { name: "Back" }));
  fireEvent.click(screen.getAllByRole("button", { name: "Close deposit sheet" }).at(-1)!);
  fireEvent.click(screen.getByRole("button", { name: "Withdraw" }));
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "5" } });
  fireEvent.click(screen.getByRole("button", { name: "Review withdrawal" }));
  await waitFor(() => expect(fixture.prepare).toHaveBeenCalledTimes(2));
  expect(deposit.cancel).toHaveBeenCalledTimes(1);
  expect(events.indexOf("deposit-cancel")).toBeLessThan(events.indexOf("prepare-2"));
});

test("an in-flight deposit preparation is aborted and its late prepared transaction is cancelled before access review", async () => {
  let resolveDeposit!: (value: { cancel: () => void; send: typeof fixture.send }) => void;
  const lateCancel = vi.fn();
  const pendingDeposit = new Promise<{ cancel: () => void; send: typeof fixture.send }>(
    (resolve) => {
      resolveDeposit = resolve;
    },
  );
  fixture.prepare
    .mockImplementationOnce(() => pendingDeposit)
    .mockResolvedValueOnce({ cancel() {}, send: fixture.send });
  mount();
  await screen.findByText("100.00 USDC");
  fireEvent.click(screen.getByRole("button", { name: "Deposit" }));
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "10" } });
  fireEvent.click(screen.getByRole("button", { name: "Review deposit" }));
  await waitFor(() => expect(fixture.prepare).toHaveBeenCalledTimes(1));
  const signal = fixture.prepare.mock.calls[0]?.[1]?.signal as AbortSignal;
  fireEvent.click(screen.getAllByRole("button", { name: "Close deposit sheet" }).at(-1)!);
  fireEvent.click(screen.getByRole("button", { name: "Review access" }));
  await waitFor(() => expect(signal.aborted).toBe(true));
  resolveDeposit({ cancel: lateCancel, send: fixture.send });
  await waitFor(() => expect(lateCancel).toHaveBeenCalledTimes(1));
  await screen.findByRole("button", { name: "Confirm" });
});

test("editing a deposit amount cancels its unused Ready review", async () => {
  const cancel = vi.fn();
  fixture.prepare.mockResolvedValue({ cancel, send: fixture.send });
  mount();
  await screen.findByText("100.00 USDC");
  fireEvent.click(screen.getByRole("button", { name: "Deposit" }));
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "10" } });
  fireEvent.click(screen.getByRole("button", { name: "Review deposit" }));
  await screen.findByRole("button", { name: "Confirm" });
  fireEvent.click(screen.getByRole("button", { name: "Back" }));
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "11" } });
  await waitFor(() => expect(cancel).toHaveBeenCalledTimes(1));
  expect(screen.queryByRole("button", { name: "Confirm" })).toBeNull();
});

test("replacing the account aborts an in-flight review and cancels its late result", async () => {
  let resolve!: (value: { cancel: () => void; send: typeof fixture.send }) => void;
  const lateCancel = vi.fn();
  fixture.prepare.mockReturnValueOnce(
    new Promise((done) => {
      resolve = done;
    }),
  );
  const view = mount();
  await screen.findByText("100.00 USDC");
  fireEvent.click(screen.getByRole("button", { name: "Deposit" }));
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "10" } });
  fireEvent.click(screen.getByRole("button", { name: "Review deposit" }));
  await waitFor(() => expect(fixture.prepare).toHaveBeenCalledTimes(1));
  const signal = fixture.prepare.mock.calls[0]?.[1]?.signal as AbortSignal;
  fixture.session = {
    address: "0x4444444444444444444444444444444444444444",
    prepareTransaction: fixture.prepare,
  };
  view.rerender(
    <ToastProvider>
      <SavingsPage />
    </ToastProvider>,
  );
  await waitFor(() => expect(signal.aborted).toBe(true));
  resolve({ cancel: lateCancel, send: fixture.send });
  await waitFor(() => expect(lateCancel).toHaveBeenCalledTimes(1));
});

test("unmounting a pending review cancels its late result and a new pool mount prepares independently", async () => {
  let resolve!: (value: { cancel: () => void; send: typeof fixture.send }) => void;
  const lateCancel = vi.fn();
  fixture.prepare
    .mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    )
    .mockResolvedValueOnce({ cancel() {}, send: fixture.send });
  const view = mount();
  await screen.findByText("100.00 USDC");
  fireEvent.click(screen.getByRole("button", { name: "Deposit" }));
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "10" } });
  fireEvent.click(screen.getByRole("button", { name: "Review deposit" }));
  await waitFor(() => expect(fixture.prepare).toHaveBeenCalledTimes(1));
  const signal = fixture.prepare.mock.calls[0]?.[1]?.signal as AbortSignal;
  view.unmount();
  fixture.pool = "0x5555555555555555555555555555555555555555";
  mount();
  await waitFor(() => expect(signal.aborted).toBe(true));
  resolve({ cancel: lateCancel, send: fixture.send });
  await waitFor(() => expect(lateCancel).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByRole("button", { name: "Review access" }));
  await screen.findByRole("button", { name: "Confirm" });
  expect(fixture.prepare).toHaveBeenCalledTimes(2);
});

test("an expired access Ready review cancels without sending and a fresh review can become Ready", async () => {
  const cancel = vi.fn();
  const now = vi.spyOn(Date, "now").mockReturnValue(0);
  fixture.prepare.mockResolvedValue({ cancel, send: fixture.send });
  try {
    mount();
    await new Promise((done) => setTimeout(done, 0));
    fireEvent.click(screen.getByRole("button", { name: "Review access" }));
    await screen.findByRole("button", { name: "Confirm" });
    now.mockReturnValue(61_000);
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect(fixture.send).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("Please review access again.")).toBeTruthy();
    now.mockReturnValue(62_000);
    fireEvent.click(screen.getByRole("button", { name: "Review access" }));
    await screen.findByRole("button", { name: "Confirm" });
    expect(fixture.prepare).toHaveBeenCalledTimes(2);
  } finally {
    now.mockRestore();
  }
});

test("zero-call access review only refreshes the existing read and never prepares or sends", async () => {
  fixture.readCalls.mockResolvedValue([]);
  mount();
  await new Promise((done) => setTimeout(done, 0));
  fireEvent.click(screen.getByRole("button", { name: "Review access" }));
  await waitFor(() => expect(fixture.refresh).toHaveBeenCalledTimes(1));
  expect(fixture.prepare).not.toHaveBeenCalled();
  expect(fixture.send).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: "Confirm" })).toBeNull();
});

test("an unavailable displayed balance still permits a contract-capped withdrawal review without archive work", async () => {
  fixture.principal = undefined;
  mount();
  await screen.findByText("100.00 USDC");
  expect((screen.getByRole("button", { name: "Withdraw" }) as HTMLButtonElement).disabled).toBe(
    false,
  );
  fireEvent.click(screen.getByRole("button", { name: "Withdraw" }));
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "5" } });
  fireEvent.click(screen.getByRole("button", { name: "Review withdrawal" }));
  await screen.findByRole("button", { name: "Confirm" });
  expect(fixture.prepare).toHaveBeenCalledTimes(1);
});
