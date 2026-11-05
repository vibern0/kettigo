import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createRef } from "react";
import {
  participationMarker as marker,
  participationMetadataReadCount,
  participationProof as proof,
  pendingAdmission as pending,
  renderSavingsParticipation,
  resetParticipationFixture,
  startRetainedParticipationScope,
} from "./helpers/savings-participation-fixture";

const fixture = vi.hoisted(() => ({
  account: "0x1111111111111111111111111111111111111111" as const,
  pool: "0x3333333333333333333333333333333333333333" as const,
  version: "legacy1",
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
  pending: [] as [`0x${string}`, bigint, `0x${string}`, boolean][],
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
    return { mode: fixture.version === "2" ? "v2" : "legacy1" };
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
import type { ParticipationPanelHandle } from "@/components/savings/ParticipationPanel";

const mount = () => renderSavingsParticipation(SavingsPage, ToastProvider);

beforeEach(() => {
  resetParticipationFixture(fixture);
});

test("legacy Savings makes zero membership and admission reads", async () => {
  mount();
  await new Promise((done) => setTimeout(done, 0));
  expect(participationMetadataReadCount(fixture.reads)).toBe(0);
});

test("a retained old-scope status refresh cannot replace settled participation", async () => {
  const alternateAccount = "0x4444444444444444444444444444444444444444" as const;
  const ref = createRef<ParticipationPanelHandle>();
  const { refreshOldScope, readsBeforeOldRefresh } = await startRetainedParticipationScope(
    fixture,
    ref,
    alternateAccount,
  );

  refreshOldScope();
  await Promise.resolve();

  expect(screen.getByRole("button", { name: "Review participation" })).toBeTruthy();
  expect(
    screen.queryByText(
      "Your savings are participating. Eligibility is determined at the end of each draw.",
    ),
  ).toBeNull();
  expect(participationMetadataReadCount(fixture.reads)).toBe(readsBeforeOldRefresh);
});

test("a positive pending balance is reviewed before one synchronous participation confirm", async () => {
  fixture.version = "2";
  mount();
  await screen.findByRole("button", { name: "Review participation" });
  fireEvent.click(screen.getByRole("button", { name: "Review participation" }));
  await waitFor(() => expect(fixture.decrypt).toHaveBeenCalledTimes(1));
  await screen.findByRole("button", { name: "Confirm" });
  expect(fixture.prepare).toHaveBeenCalledTimes(1);
  expect(fixture.send).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
  expect(fixture.send).toHaveBeenCalledTimes(1);
  await screen.findByText(
    "Your savings are participating. Eligibility is determined at the end of each draw.",
  );
});

test("a false participation marker does not prepare or send", async () => {
  fixture.version = "2";
  fixture.decrypt.mockResolvedValue({ clearValue: false, decryptionProof: proof });
  mount();
  await screen.findByRole("button", { name: "Review participation" });
  fireEvent.click(screen.getByRole("button", { name: "Review participation" }));
  await waitFor(() => expect(fixture.decrypt).toHaveBeenCalledTimes(1));
  await screen.findByText("No savings are ready to add yet.");
  expect(fixture.prepare).not.toHaveBeenCalled();
  expect(fixture.send).not.toHaveBeenCalled();
});

test("a no-longer-pending review never prepares or sends", async () => {
  fixture.version = "2";
  fixture.pending = [pending(), pending(), pending(false)];
  mount();
  await screen.findByRole("button", { name: "Review participation" });
  fireEvent.click(screen.getByRole("button", { name: "Review participation" }));
  await waitFor(() => expect(fixture.prepare).not.toHaveBeenCalled());
  expect(fixture.send).not.toHaveBeenCalled();
});

test("an expired participation Ready requires an explicit fresh review without sending", async () => {
  const now = vi.spyOn(Date, "now").mockReturnValue(0);
  try {
    fixture.version = "2";
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Review participation" }));
    await screen.findByRole("button", { name: "Confirm" });
    now.mockReturnValue(61_000);
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect(fixture.send).not.toHaveBeenCalled();
    expect(await screen.findByText("Please review your savings again.")).toBeTruthy();
    expect(fixture.prepare).toHaveBeenCalledTimes(1);
  } finally {
    now.mockRestore();
  }
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
  await screen.findByText("Add to savings, then finish setup when you are ready to participate.");
  fireEvent.click(screen.getByRole("button", { name: "Deposit" }));
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "10" } });
  fireEvent.click(screen.getByRole("button", { name: "Review deposit" }));
  fireEvent.click(await screen.findByRole("button", { name: "Confirm" }));
  await screen.findByRole("button", { name: "Review participation" });
});

test("starting a deposit aborts a pending participation decryption before preparation", async () => {
  let resolveDecrypt!: (value: { clearValue: boolean; decryptionProof: `0x${string}` }) => void;
  fixture.version = "2";
  fixture.decrypt.mockReturnValueOnce(
    new Promise((resolve) => {
      resolveDecrypt = resolve;
    }),
  );
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Review participation" }));
  await waitFor(() => expect(fixture.decrypt).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByRole("button", { name: "Deposit" }));
  resolveDecrypt({ clearValue: true, decryptionProof: proof });
  await new Promise((done) => setTimeout(done, 0));
  expect(fixture.prepare).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: "Confirm" })).toBeNull();
});

test("starting access review aborts a pending participation decryption before preparation", async () => {
  let resolveDecrypt!: (value: { clearValue: boolean; decryptionProof: `0x${string}` }) => void;
  fixture.version = "2";
  fixture.accessState = "access-required";
  fixture.decrypt.mockReturnValueOnce(
    new Promise((resolve) => {
      resolveDecrypt = resolve;
    }),
  );
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Review participation" }));
  await waitFor(() => expect(fixture.decrypt).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByRole("button", { name: "Review access" }));
  resolveDecrypt({ clearValue: true, decryptionProof: proof });
  await new Promise((done) => setTimeout(done, 0));
  expect(fixture.prepare).not.toHaveBeenCalled();
});

test("starting a withdrawal disposes a late participation preparation", async () => {
  let resolvePrepared!: (value: { cancel: () => void; send: typeof fixture.send }) => void;
  const lateCancel = vi.fn();
  fixture.version = "2";
  fixture.principal = 10_000_000n;
  fixture.prepare.mockReturnValueOnce(
    new Promise((resolve) => {
      resolvePrepared = resolve;
    }),
  );
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Review participation" }));
  await waitFor(() => expect(fixture.prepare).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByRole("button", { name: "Withdraw" }));
  resolvePrepared({ cancel: lateCancel, send: fixture.send });
  await waitFor(() => expect(lateCancel).toHaveBeenCalledTimes(1));
  expect(screen.queryByRole("button", { name: "Confirm" })).toBeNull();
});

test("replacing the account disposes a late participation preparation", async () => {
  let resolvePrepared!: (value: { cancel: () => void; send: typeof fixture.send }) => void;
  const lateCancel = vi.fn();
  fixture.version = "2";
  fixture.prepare.mockReturnValueOnce(
    new Promise((resolve) => {
      resolvePrepared = resolve;
    }),
  );
  const view = mount();
  fireEvent.click(await screen.findByRole("button", { name: "Review participation" }));
  await waitFor(() => expect(fixture.prepare).toHaveBeenCalledTimes(1));
  fixture.session = {
    address: "0x4444444444444444444444444444444444444444",
    prepareTransaction: fixture.prepare,
  };
  view.rerender(
    <ToastProvider>
      <SavingsPage />
    </ToastProvider>,
  );
  resolvePrepared({ cancel: lateCancel, send: fixture.send });
  await waitFor(() => expect(lateCancel).toHaveBeenCalledTimes(1));
  expect(screen.queryByRole("button", { name: "Confirm" })).toBeNull();
});

test("unmounting disposes a late participation preparation", async () => {
  let resolvePrepared!: (value: { cancel: () => void; send: typeof fixture.send }) => void;
  const lateCancel = vi.fn();
  fixture.version = "2";
  fixture.prepare.mockReturnValueOnce(
    new Promise((resolve) => {
      resolvePrepared = resolve;
    }),
  );
  const view = mount();
  fireEvent.click(await screen.findByRole("button", { name: "Review participation" }));
  await waitFor(() => expect(fixture.prepare).toHaveBeenCalledTimes(1));
  view.unmount();
  resolvePrepared({ cancel: lateCancel, send: fixture.send });
  await waitFor(() => expect(lateCancel).toHaveBeenCalledTimes(1));
});

test("dismissing an unused deposit Ready preserves pending participation for a fresh confirmation", async () => {
  const events: string[] = [];
  const oldSend = vi.fn();
  const newSend = vi.fn(async () => {
    events.push("participation-send");
    fixture.membershipIndex = 1n;
    fixture.pending = [pending(false)];
    return "0xdead";
  });
  const deposit = {
    cancel: vi.fn(() => events.push("deposit-cancel")),
    send: oldSend,
  };
  const participation = { cancel: vi.fn(), send: newSend };
  fixture.version = "2";
  fixture.walletBalance = 100_000_000n;
  fixture.prepare.mockImplementation(async () => {
    events.push(`prepare-${fixture.prepare.mock.calls.length}`);
    return fixture.prepare.mock.calls.length === 1 ? deposit : participation;
  });

  mount();
  await screen.findByRole("button", { name: "Review participation" });
  fireEvent.click(screen.getByRole("button", { name: "Deposit" }));
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "10" } });
  fireEvent.click(screen.getByRole("button", { name: "Review deposit" }));
  await screen.findByRole("button", { name: "Confirm" });
  fireEvent.click(screen.getByRole("button", { name: "Back" }));
  fireEvent.click(screen.getAllByRole("button", { name: "Close deposit sheet" }).at(-1)!);
  expect(deposit.cancel).toHaveBeenCalledTimes(1);
  expect(oldSend).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole("button", { name: "Review participation" }));
  await screen.findByRole("button", { name: "Confirm" });
  expect(events.indexOf("deposit-cancel")).toBeLessThan(events.indexOf("prepare-2"));
  expect(oldSend).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
  expect(newSend).toHaveBeenCalledTimes(1);
  expect(oldSend).not.toHaveBeenCalled();
});

test("dismissing an unused withdrawal Ready preserves pending participation for a fresh confirmation", async () => {
  const events: string[] = [];
  const oldSend = vi.fn();
  const newSend = vi.fn(async () => {
    events.push("participation-send");
    fixture.membershipIndex = 1n;
    fixture.pending = [pending(false)];
    return "0xdead";
  });
  const withdrawal = {
    cancel: vi.fn(() => events.push("withdrawal-cancel")),
    send: oldSend,
  };
  const participation = { cancel: vi.fn(), send: newSend };
  fixture.version = "2";
  fixture.principal = 50_000_000n;
  fixture.prepare.mockImplementation(async () => {
    events.push(`prepare-${fixture.prepare.mock.calls.length}`);
    return fixture.prepare.mock.calls.length === 1 ? withdrawal : participation;
  });

  mount();
  await screen.findByRole("button", { name: "Review participation" });
  fireEvent.click(screen.getByRole("button", { name: "Withdraw" }));
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "5" } });
  fireEvent.click(screen.getByRole("button", { name: "Review withdrawal" }));
  await screen.findByRole("button", { name: "Confirm" });
  fireEvent.click(screen.getByRole("button", { name: "Back" }));
  fireEvent.click(screen.getAllByRole("button", { name: "Close withdrawal sheet" }).at(-1)!);
  expect(withdrawal.cancel).toHaveBeenCalledTimes(1);
  expect(oldSend).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole("button", { name: "Review participation" }));
  await screen.findByRole("button", { name: "Confirm" });
  expect(events.indexOf("withdrawal-cancel")).toBeLessThan(events.indexOf("prepare-2"));
  expect(oldSend).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
  expect(newSend).toHaveBeenCalledTimes(1);
  expect(oldSend).not.toHaveBeenCalled();
});

test("dismissing an unused balance-access Ready preserves pending participation for a fresh confirmation", async () => {
  const events: string[] = [];
  const oldSend = vi.fn();
  const newSend = vi.fn(async () => {
    events.push("participation-send");
    fixture.membershipIndex = 1n;
    fixture.pending = [pending(false)];
    return "0xdead";
  });
  const access = {
    cancel: vi.fn(() => events.push("access-cancel")),
    send: oldSend,
  };
  const participation = { cancel: vi.fn(), send: newSend };
  fixture.version = "2";
  fixture.accessState = "access-required";
  fixture.smartReads.mockResolvedValue([{ to: fixture.account, data: "0x" }]);
  fixture.prepare.mockImplementation(async () => {
    events.push(`prepare-${fixture.prepare.mock.calls.length}`);
    return fixture.prepare.mock.calls.length === 1 ? access : participation;
  });

  mount();
  await screen.findByRole("button", { name: "Review participation" });
  fireEvent.click(screen.getByRole("button", { name: "Review access" }));
  await screen.findByRole("button", { name: "Confirm" });
  fireEvent.click(screen.getByRole("button", { name: "Back" }));
  expect(access.cancel).toHaveBeenCalledTimes(1);
  expect(oldSend).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole("button", { name: "Review participation" }));
  await screen.findByRole("button", { name: "Confirm" });
  expect(events.indexOf("access-cancel")).toBeLessThan(events.indexOf("prepare-2"));
  expect(oldSend).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
  expect(newSend).toHaveBeenCalledTimes(1);
  expect(oldSend).not.toHaveBeenCalled();
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

  await screen.findByRole("button", { name: "Review participation" });
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
  await screen.findByRole("button", { name: "Review participation" });
  resolveInitialMember(0n);
  resolveInitialPending(pending(false));
  await new Promise((done) => setTimeout(done, 0));

  expect(screen.getByRole("button", { name: "Review participation" })).toBeTruthy();
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
  await screen.findByRole("button", { name: "Review participation" });
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
