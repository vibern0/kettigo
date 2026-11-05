import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { entryPoint07Address } from "viem/account-abstraction";

const fixture = vi.hoisted(() => ({
  account: "0x1111111111111111111111111111111111111111" as const,
  alternateAccount: "0x4444444444444444444444444444444444444444" as const,
  pool: "0x3333333333333333333333333333333333333333" as `0x${string}`,
  alternatePool: "0x5555555555555555555555555555555555555555" as const,
  prepare: vi.fn(),
  send: vi.fn(),
  refresh: vi.fn(),
  readCalls: vi.fn(),
  pending: null as any,
  getterFails: false,
  version: "legacy1",
  decrypt: vi.fn(),
  postReadFailure: undefined as "membership" | "pending" | undefined,
  postReadFailureUsed: false,
  sent: false,
  session: undefined as any,
  membershipByScope: undefined as Record<string, bigint> | undefined,
  pendingByScope: undefined as
    Record<string, readonly [`0x${string}`, bigint, `0x${string}`, boolean]> | undefined,
}));
vi.mock("viem", async (original) => ({
  ...(await original<typeof import("viem")>()),
  createPublicClient: () => ({
    readContract: async ({
      address,
      args,
      functionName,
    }: {
      address: string;
      args: readonly string[];
      functionName: string;
    }) => {
      if (
        fixture.sent &&
        fixture.postReadFailure ===
          (functionName === "membershipIndexOf" ? "membership" : "pending") &&
        !fixture.postReadFailureUsed
      ) {
        fixture.postReadFailureUsed = true;
        throw new Error(`${functionName} unavailable`);
      }
      const scope = `${address.toLowerCase()}:${args[0]?.toLowerCase()}`;
      return functionName === "pendingAdmissionOf"
        ? (fixture.pendingByScope?.[scope] ?? [
            `0x${"a".repeat(64)}`,
            7n,
            `0x${"a".repeat(64)}`,
            true,
          ])
        : (fixture.membershipByScope?.[scope] ?? 0n);
    },
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
vi.mock("@/lib/runtime-config", () => ({
  publicConfig: (name: string, fallback?: string) =>
    name === "NEXT_PUBLIC_POOL_VERSION" ? fixture.version : (fallback ?? ""),
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
  createPublicZamaSDK: () => ({ terminate: vi.fn() }),
  decryptPublicBoolean: fixture.decrypt,
  decryptPublicUint64: vi.fn(),
  encryptUint64: vi.fn(),
  withSmartZamaSDK: vi.fn(),
  prepareSmartReadSessionCalls: fixture.readCalls,
}));
vi.mock("@/lib/client-errors", () => ({ reportClientToast: vi.fn(), reportClientError: vi.fn() }));

import SavingsPage from "@/app/savings/page";
import { ActionCenterProvider, useActionCenter } from "@/components/ActionCenter";
import { ToastProvider } from "@/components/Toast";
import {
  SafeUserOperationFailedError,
  SafeUserOperationNotSubmittedError,
  SafeUserOperationRejectedError,
} from "@/lib/passkey-operation";

function ActionStatusProbe() {
  const { actions } = useActionCenter();
  return <output data-testid="action-statuses">{JSON.stringify(actions)}</output>;
}

function savingsActivityTree() {
  return (
    <ToastProvider>
      <ActionCenterProvider>
        <SavingsPage />
        <ActionStatusProbe />
      </ActionCenterProvider>
    </ToastProvider>
  );
}

function renderSavingsActivity() {
  return render(savingsActivityTree());
}

beforeEach(() => {
  localStorage.clear();
  fixture.prepare.mockReset();
  fixture.send.mockReset();
  fixture.refresh.mockReset();
  fixture.readCalls.mockReset();
  fixture.readCalls.mockResolvedValue([{ to: fixture.account, data: "0x" }]);
  fixture.pending = null;
  fixture.getterFails = false;
  fixture.version = "legacy1";
  fixture.postReadFailure = undefined;
  fixture.postReadFailureUsed = false;
  fixture.sent = false;
  fixture.pool = "0x3333333333333333333333333333333333333333";
  fixture.membershipByScope = undefined;
  fixture.pendingByScope = undefined;
  fixture.decrypt.mockReset();
  fixture.decrypt.mockResolvedValue({ clearValue: true, decryptionProof: "0x1234" });
  fixture.session = {
    address: fixture.account,
    prepareTransaction: fixture.prepare,
    getPendingOperation: () => {
      if (fixture.getterFails) throw new Error("stored secret");
      return fixture.pending;
    },
    recoverPendingOperation: vi.fn(async () => ({ state: "pending", operation: fixture.pending })),
  };
  fixture.prepare.mockResolvedValue({ cancel() {}, send: fixture.send });
  fixture.send.mockImplementation(({ onOperationPrepared }) => {
    const operation = {
      chainId: 11155111 as const,
      entryPoint: entryPoint07Address,
      sender: fixture.account,
      userOperationHash: `0x${"a".repeat(64)}` as const,
    };
    fixture.pending = { ...operation, createdAt: 1, phase: "attempted" as const };
    onOperationPrepared(operation);
    throw new Error("gateway request body secret");
  });
});

test("attempted access approval is immediately recoverable in Activity without a retry", async () => {
  render(
    <ToastProvider>
      <ActionCenterProvider>
        <SavingsPage />
      </ActionCenterProvider>
    </ToastProvider>,
  );
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
    const operation = {
      chainId: 11155111 as const,
      entryPoint: entryPoint07Address,
      sender: fixture.account,
      userOperationHash: `0x${"b".repeat(32)}` as const,
    };
    onOperationPrepared(operation);
    fixture.getterFails = true;
    throw new Error("gateway secret");
  });
  render(
    <ToastProvider>
      <ActionCenterProvider>
        <SavingsPage />
      </ActionCenterProvider>
    </ToastProvider>,
  );
  await new Promise((done) => setTimeout(done, 0));
  fireEvent.click(screen.getByRole("button", { name: "Review access" }));
  fireEvent.click(await screen.findByRole("button", { name: "Confirm" }));
  fireEvent.click(await screen.findByRole("button", { name: /Activity/i }));
  expect(await screen.findByRole("button", { name: "Check status" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  expect(document.body.textContent).not.toContain("stored secret");
});

test("attempted participation confirmation retains its captured identity when the pending getter throws", async () => {
  fixture.version = "2";
  fixture.send.mockImplementation(({ onOperationPrepared }) => {
    const operation = {
      chainId: 11155111 as const,
      entryPoint: entryPoint07Address,
      sender: fixture.account,
      userOperationHash: `0x${"c".repeat(64)}` as const,
    };
    onOperationPrepared(operation);
    fixture.getterFails = true;
    throw new Error("participation gateway secret");
  });
  render(
    <ToastProvider>
      <ActionCenterProvider>
        <SavingsPage />
      </ActionCenterProvider>
    </ToastProvider>,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Review participation" }));
  fireEvent.click(await screen.findByRole("button", { name: "Confirm" }));
  await waitFor(() => expect(fixture.send).toHaveBeenCalledTimes(1));
  fireEvent.click(await screen.findByRole("button", { name: /Activity/i }));
  expect(await screen.findByRole("button", { name: "Check status" })).toBeTruthy();
  expect(screen.queryByText("Failed")).toBeNull();
  expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  expect(document.body.textContent).not.toContain("participation gateway secret");
});

test("participation Activity reloads the saved attempted identity for read-only recovery", async () => {
  fixture.version = "2";
  const operation = {
    chainId: 11155111 as const,
    entryPoint: entryPoint07Address,
    sender: fixture.account,
    userOperationHash: `0x${"d".repeat(64)}` as const,
  };
  fixture.send.mockImplementation(({ onOperationPrepared }) => {
    onOperationPrepared(operation);
    fixture.pending = { ...operation, createdAt: 1, phase: "attempted" as const };
    fixture.getterFails = true;
    throw new Error("participation gateway secret");
  });
  const view = render(
    <ToastProvider>
      <ActionCenterProvider>
        <SavingsPage />
      </ActionCenterProvider>
    </ToastProvider>,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Review participation" }));
  fireEvent.click(await screen.findByRole("button", { name: "Confirm" }));
  await screen.findByRole("button", { name: /Activity/i });
  await waitFor(() =>
    expect(localStorage.getItem("kettigo:actions")).toContain(operation.userOperationHash),
  );
  view.unmount();
  fixture.getterFails = false;
  render(
    <ToastProvider>
      <ActionCenterProvider>
        <SavingsPage />
      </ActionCenterProvider>
    </ToastProvider>,
  );
  fireEvent.click(await screen.findByRole("button", { name: /Activity/i }));
  fireEvent.click(await screen.findByRole("button", { name: "Check status" }));
  expect(
    await screen.findByText("Still processing. Check status to see the latest update."),
  ).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
});

test.each(["membership", "pending"] as const)(
  "a canonical participation send keeps %s-read failure refreshable without retrying",
  async (postReadFailure) => {
    fixture.version = "2";
    fixture.postReadFailure = postReadFailure;
    fixture.send.mockImplementation(async () => {
      fixture.sent = true;
      return "0xdead";
    });
    render(
      <ToastProvider>
        <ActionCenterProvider>
          <SavingsPage />
        </ActionCenterProvider>
      </ToastProvider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Review participation" }));
    fireEvent.click(await screen.findByRole("button", { name: "Confirm" }));
    expect(await screen.findByText("Your savings status needs a refresh.")).toBeTruthy();
    expect(fixture.send).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: /Activity/i }));
    expect(screen.queryByText("Failed")).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Refresh status" }));
    await screen.findByText("Your savings status needs a refresh.");
    expect(screen.queryByRole("button", { name: "Review participation" })).toBeNull();
    expect(fixture.send).toHaveBeenCalledTimes(1);
  },
);

test.each([
  [
    "rejected",
    (operation: {
      chainId: 11155111;
      entryPoint: typeof entryPoint07Address;
      sender: typeof fixture.account;
      userOperationHash: `0x${string}`;
    }) => new SafeUserOperationRejectedError(operation, 4001, new Error("rejection secret")),
    "rejected",
  ],
  [
    "known-not-submitted",
    (operation: {
      chainId: 11155111;
      entryPoint: typeof entryPoint07Address;
      sender: typeof fixture.account;
      userOperationHash: `0x${string}`;
    }) => new SafeUserOperationNotSubmittedError(operation, new Error("submission secret")),
    "not-submitted",
  ],
  [
    "inner-failed",
    (operation: {
      chainId: 11155111;
      entryPoint: typeof entryPoint07Address;
      sender: typeof fixture.account;
      userOperationHash: `0x${string}`;
    }) => new SafeUserOperationFailedError(operation),
    "failed",
  ],
] as const)(
  "a %s participation terminal error stays terminal without a canonical-success hold",
  async (_kind, terminalError, expectedStatus) => {
    fixture.version = "2";
    fixture.send.mockImplementation(({ onOperationPrepared }) => {
      const operation = {
        chainId: 11155111 as const,
        entryPoint: entryPoint07Address,
        sender: fixture.account,
        userOperationHash: `0x${"e".repeat(64)}` as const,
      };
      onOperationPrepared(operation);
      throw terminalError(operation);
    });
    renderSavingsActivity();
    fireEvent.click(await screen.findByRole("button", { name: "Review participation" }));
    fireEvent.click(await screen.findByRole("button", { name: "Confirm" }));
    await waitFor(() =>
      expect(screen.getByTestId("action-statuses").textContent).toContain(
        `\"status\":\"${expectedStatus}\"`,
      ),
    );
    expect(fixture.prepare).toHaveBeenCalledTimes(1);
    expect(fixture.send).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Your savings status needs a refresh.")).toBeNull();
    expect(document.body.textContent).not.toContain("rejection secret");
    expect(document.body.textContent).not.toContain("submission secret");
  },
);

test.each(["account", "pool"] as const)(
  "a late canonical participation result cannot update the replaced %s scope",
  async (scope) => {
    fixture.version = "2";
    const operation = {
      chainId: 11155111 as const,
      entryPoint: entryPoint07Address,
      sender: fixture.account,
      userOperationHash: `0x${"f".repeat(64)}` as const,
    };
    let resolveSend!: (hash: `0x${string}`) => void;
    const cancel = vi.fn();
    fixture.prepare.mockResolvedValue({ cancel, send: fixture.send });
    fixture.send.mockImplementation(({ onOperationPrepared }) => {
      onOperationPrepared(operation);
      return new Promise((resolve) => {
        resolveSend = resolve;
      });
    });
    const view = renderSavingsActivity();
    fireEvent.click(await screen.findByRole("button", { name: "Review participation" }));
    fireEvent.click(await screen.findByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(fixture.send).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(localStorage.getItem("kettigo:actions")).toContain(operation.userOperationHash),
    );

    if (scope === "account") {
      fixture.session = { ...fixture.session, address: fixture.alternateAccount };
    } else {
      fixture.pool = fixture.alternatePool;
    }
    view.rerender(savingsActivityTree());
    resolveSend("0xdead");

    await waitFor(() =>
      expect(screen.getByTestId("action-statuses").textContent).toContain('"status":"confirming"'),
    );
    expect(await screen.findByRole("button", { name: "Review participation" })).toBeTruthy();
    expect(screen.queryByText("Savings setup complete.")).toBeNull();
    expect(cancel).not.toHaveBeenCalled();
    expect(fixture.prepare).toHaveBeenCalledTimes(1);
    expect(fixture.send).toHaveBeenCalledTimes(1);
  },
);

test("an unmounted participation confirmation keeps its attempted Activity identity recoverable", async () => {
  fixture.version = "2";
  const operation = {
    chainId: 11155111 as const,
    entryPoint: entryPoint07Address,
    sender: fixture.account,
    userOperationHash: `0x${"9".repeat(64)}` as const,
  };
  let rejectSend!: (error: Error) => void;
  const cancel = vi.fn();
  fixture.prepare.mockResolvedValue({ cancel, send: fixture.send });
  fixture.send.mockImplementation(({ onOperationPrepared }) => {
    fixture.pending = { ...operation, createdAt: 1, phase: "attempted" as const };
    onOperationPrepared(operation);
    return new Promise((_resolve, reject) => {
      rejectSend = reject;
    });
  });
  const view = renderSavingsActivity();
  fireEvent.click(await screen.findByRole("button", { name: "Review participation" }));
  fireEvent.click(await screen.findByRole("button", { name: "Confirm" }));
  await waitFor(() => expect(fixture.send).toHaveBeenCalledTimes(1));
  await waitFor(() =>
    expect(localStorage.getItem("kettigo:actions")).toContain(operation.userOperationHash),
  );
  view.unmount();
  rejectSend(new Error("late old-scope secret"));
  await Promise.resolve();

  renderSavingsActivity();
  fireEvent.click(await screen.findByRole("button", { name: /Activity/i }));
  expect(await screen.findByRole("button", { name: "Check status" })).toBeTruthy();
  expect(cancel).not.toHaveBeenCalled();
  expect(fixture.prepare).toHaveBeenCalledTimes(1);
  expect(fixture.send).toHaveBeenCalledTimes(1);
  expect(document.body.textContent).not.toContain("late old-scope secret");
});
