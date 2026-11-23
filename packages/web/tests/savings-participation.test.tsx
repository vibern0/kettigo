import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import {
  participationMetadataReadCount,
  pendingAdmission as pending,
  renderSavingsParticipation,
  resetParticipationFixture,
} from "./helpers/savings-participation-fixture";

const fixture = vi.hoisted(() => ({
  account: "0x1111111111111111111111111111111111111111" as const,
  pool: "0x3333333333333333333333333333333333333333" as const,
  version: "legacy1",
  scopeId: "legacy-e65" as "legacy-e65" | "candidate-v2",
  onboardingEnabled: false,
  reads: vi.fn(),
  archive: vi.fn(),
  prepare: vi.fn(),
  send: vi.fn(),
  decrypt: vi.fn(),
  encrypt: vi.fn(),
  smartReads: vi.fn(),
  membershipIndex: 0n,
  walletBalance: 0n,
  principal: undefined as bigint | undefined,
  accessState: "ready" as "ready" | "access-required",
  session: undefined as { address: `0x${string}`; prepareTransaction: typeof vi.fn } | undefined,
  pending: [] as ReturnType<typeof pending>[],
}));

vi.mock("viem", async (original) => ({
  ...(await original<typeof import("viem")>()),
  createPublicClient: () => ({
    readContract: fixture.reads,
    getBlockNumber: async () => 0n,
    request: fixture.archive,
    watchBlockNumber: () => () => {},
    waitForTransactionReceipt: async () => ({ status: "success", logs: [] }),
  }),
}));
vi.mock("@/lib/runtime-config", () => ({
  get SELECTED_SCOPE() {
    return {
      id: fixture.scopeId,
      chainId: 11155111,
      usdc: fixture.account,
      wrapper: "0x2222222222222222222222222222222222222222",
      pool: fixture.pool,
      rpcUrl: "https://rpc.example",
      mode: fixture.version === "2" ? "v2" : "legacy1",
      proofServiceUrl: fixture.version === "2" ? "https://proof.example" : "",
      proofNamespace: fixture.version === "2" ? "candidate" : "",
      onboardingEnabled: fixture.onboardingEnabled,
    };
  },
  publicConfig: () => "",
}));
vi.mock("@/lib/contracts", async (original) => ({
  ...(await original<typeof import("@/lib/contracts")>()),
  CONTRACTS: {
    usdc: fixture.account,
    confidentialUsdc: fixture.account,
    confidentialPrizePool: fixture.pool,
  },
}));
vi.mock("@/lib/wallet-context", () => ({
  useWallet: () => ({
    session: fixture.session,
    principal: fixture.principal,
    confidentialBalancesLoading: false,
    confidentialBalancesError: null,
    confidentialBalancesReadState: fixture.accessState,
    refreshConfidentialBalances: vi.fn(),
  }),
}));
vi.mock("@/lib/smart-session", () => ({
  sendSmartTransaction: vi.fn(),
  sendSmartTransactionBatch: vi.fn(),
}));
vi.mock("@/lib/zama", async () => ({
  asChecksumAddress: (await vi.importActual<typeof import("viem")>("viem")).getAddress,
  createPublicZamaSDK: () => ({ terminate: vi.fn() }),
  decryptPublicBoolean: fixture.decrypt,
  decryptPublicUint64: vi.fn(),
  encryptUint64: fixture.encrypt,
  prepareSmartReadSessionCalls: fixture.smartReads,
  withSmartZamaSDK: async (_session: unknown, action: (sdk: unknown) => unknown) => action({}),
}));
vi.mock("@/components/ActionCenter", () => ({
  useActionCenter: () => ({
    runAction: (_input: unknown, runner: (controls: { update: () => void }) => Promise<void>) => {
      void runner({ update() {} });
      return "participation";
    },
  }),
}));
vi.mock("@/lib/client-errors", () => ({ reportClientToast: vi.fn() }));
vi.mock("canvas-confetti", () => ({
  default: { create: () => Object.assign(() => Promise.resolve(), { reset: vi.fn() }) },
}));

import SavingsPage from "@/app/savings/page";
import { ToastProvider } from "@/components/Toast";
const pendingCopy = "Your savings are being added to future draws automatically.";

const mount = () => renderSavingsParticipation(SavingsPage, ToastProvider);

beforeEach(() => {
  resetParticipationFixture(fixture);
});

test("legacy Savings makes zero membership and admission reads", async () => {
  mount();
  await new Promise((done) => setTimeout(done, 0));
  expect(participationMetadataReadCount(fixture.reads)).toBe(0);
});

test("candidate savings with onboarding paused blocks only a fresh deposit", async () => {
  fixture.version = "2";
  fixture.scopeId = "candidate-v2";
  fixture.onboardingEnabled = false;
  fixture.principal = 10_000_000n;
  mount();

  await screen.findByText(pendingCopy);
  expect((screen.getByRole("button", { name: "Deposit" }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  expect((screen.getByRole("button", { name: "Withdraw" }) as HTMLButtonElement).disabled).toBe(
    false,
  );
});

test("legacy savings keeps fresh deposits available when its registry onboarding flag is false", () => {
  fixture.onboardingEnabled = false;
  mount();

  expect((screen.getByRole("button", { name: "Deposit" }) as HTMLButtonElement).disabled).toBe(
    false,
  );
});

test("a completed deposit refreshes participation on the same Savings mount", async () => {
  fixture.version = "2";
  fixture.pending = [pending(false)];
  fixture.walletBalance = 100_000_000n;
  fixture.send.mockImplementation(async ({ onSigned }: { onSigned?: () => void } = {}) => {
    onSigned?.();
    fixture.pending = [pending(true)];
    return "0xdead";
  });
  mount();
  await screen.findByText("Add to savings to participate in future draws.");
  fireEvent.click(screen.getByRole("button", { name: "Deposit" }));
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "10" } });
  fireEvent.click(screen.getByRole("button", { name: "Review deposit" }));
  fireEvent.click(await screen.findByRole("button", { name: "Confirm" }));
  await screen.findByText(pendingCopy);
});

test("closing a financial sheet does not discard an initial pending status read", async () => {
  let resolveMember!: (value: bigint) => void;
  let resolvePending!: (value: ReturnType<typeof pending>) => void;
  fixture.version = "2";
  fixture.walletBalance = 100_000_000n;
  fixture.reads.mockImplementation(({ functionName }: { functionName: string }) => {
    if (functionName === "membershipIndexOf") {
      return new Promise<bigint>((resolve) => {
        resolveMember = resolve;
      });
    }
    if (functionName === "pendingAdmissionOf") {
      return new Promise<ReturnType<typeof pending>>((resolve) => {
        resolvePending = resolve;
      });
    }
    if (functionName === "balanceOf") return fixture.walletBalance;
    return 0n;
  });

  mount();
  await waitFor(() => expect(participationMetadataReadCount(fixture.reads)).toBe(2));
  fireEvent.click(screen.getByRole("button", { name: "Deposit" }));
  fireEvent.click(screen.getAllByRole("button", { name: "Close deposit sheet" }).at(-1)!);
  expect(fixture.send).not.toHaveBeenCalled();
  resolveMember(0n);
  resolvePending(pending());

  await screen.findByText(pendingCopy);
  expect(fixture.send).not.toHaveBeenCalled();
});

test("a stale initial no-pending status result cannot replace a newer deposit refresh", async () => {
  let resolveInitialMember!: (value: bigint) => void;
  let resolveInitialPending!: (value: ReturnType<typeof pending>) => void;
  let membershipReads = 0;
  let pendingReads = 0;
  fixture.version = "2";
  fixture.walletBalance = 100_000_000n;
  fixture.reads.mockImplementation(({ functionName }: { functionName: string }) => {
    if (functionName === "membershipIndexOf") {
      membershipReads += 1;
      if (membershipReads === 1) {
        return new Promise<bigint>((resolve) => {
          resolveInitialMember = resolve;
        });
      }
      return 0n;
    }
    if (functionName === "pendingAdmissionOf") {
      pendingReads += 1;
      if (pendingReads === 1) {
        return new Promise<ReturnType<typeof pending>>((resolve) => {
          resolveInitialPending = resolve;
        });
      }
      return pending();
    }
    if (functionName === "balanceOf") return fixture.walletBalance;
    return 0n;
  });
  fixture.send.mockImplementation(async ({ onSigned }: { onSigned?: () => void } = {}) => {
    onSigned?.();
    return "0xdead";
  });

  mount();
  await waitFor(() => expect(membershipReads).toBe(1));
  await waitFor(() => expect(pendingReads).toBe(1));
  fireEvent.click(screen.getByRole("button", { name: "Deposit" }));
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "10" } });
  fireEvent.click(screen.getByRole("button", { name: "Review deposit" }));
  fireEvent.click(await screen.findByRole("button", { name: "Confirm" }));
  await screen.findByText(pendingCopy);
  resolveInitialMember(0n);
  resolveInitialPending(pending(false));
  await new Promise((done) => setTimeout(done, 0));

  expect(screen.getByText(pendingCopy)).toBeTruthy();
  expect(fixture.send).toHaveBeenCalledTimes(1);
});

test("a pending mode-2 account can withdraw with no displayed balance while archive reads fail", async () => {
  fixture.version = "2";
  fixture.principal = undefined;
  fixture.archive.mockRejectedValue(new Error("archive unavailable"));
  fixture.smartReads.mockResolvedValue([{ to: fixture.account, data: "0x" }]);
  fixture.send.mockImplementation(async ({ onSigned }: { onSigned?: () => void } = {}) => {
    onSigned?.();
    return "0xdead";
  });

  mount();
  await screen.findByText(pendingCopy);
  await waitFor(() => expect(fixture.archive).toHaveBeenCalled());
  expect(screen.getByText("— USDC")).toBeTruthy();
  expect((screen.getByRole("button", { name: "Withdraw" }) as HTMLButtonElement).disabled).toBe(
    false,
  );
  expect(fixture.decrypt).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole("button", { name: "Withdraw" }));
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "5" } });
  fireEvent.click(screen.getByRole("button", { name: "Review withdrawal" }));
  await screen.findByRole("button", { name: "Confirm" });
  expect(fixture.prepare).toHaveBeenCalledTimes(1);
  expect(fixture.send).not.toHaveBeenCalled();
  const statusReadsBeforeSend = participationMetadataReadCount(fixture.reads);

  fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
  expect(fixture.send).toHaveBeenCalledTimes(1);
  await waitFor(() =>
    expect(participationMetadataReadCount(fixture.reads)).toBe(statusReadsBeforeSend + 2),
  );
  expect(fixture.prepare).toHaveBeenCalledTimes(1);
  expect(fixture.decrypt).not.toHaveBeenCalled();
});

test("pending participation refreshes automatically until active without a wallet request", async () => {
  vi.useFakeTimers();
  try {
    fixture.version = "2";
    mount();
    await act(async () => {});
    expect(screen.getByText(pendingCopy)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /participation|confirm/i })).toBeNull();
    fixture.membershipIndex = 1n;
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(screen.getByText(/Your savings are participating/)).toBeTruthy();
    const reads = participationMetadataReadCount(fixture.reads);
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(participationMetadataReadCount(fixture.reads)).toBe(reads);
    expect(fixture.prepare).not.toHaveBeenCalled();
    expect(fixture.send).not.toHaveBeenCalled();
  } finally {
    cleanup();
    vi.useRealTimers();
  }
});
