import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { entryPoint07Address } from "viem/account-abstraction";
import { ZamaReadSessionAccessRequiredError } from "@/lib/zama-session-manager";

const fixture = vi.hoisted(() => {
  const account = "0x1111111111111111111111111111111111111111" as const;
  const pool = "0x3333333333333333333333333333333333333333" as `0x${string}`;
  const award = `0x${"2".repeat(64)}` as const;
  return {
    account,
    pool,
    alternateAccount: "0x4444444444444444444444444444444444444444" as const,
    alternatePool: "0x5555555555555555555555555555555555555555" as const,
    award,
    version: "2",
    proofUrl: "https://proof.example",
    prepare: vi.fn(),
    confirm: vi.fn(),
    send: vi.fn(),
    recover: vi.fn(),
    pending: vi.fn(),
    coordinator: vi.fn(),
    readerFactory: vi.fn(),
    proofFactory: vi.fn(),
    decrypt: vi.fn(),
    winningsHandle: `0x${"1".repeat(64)}` as `0x${string}`,
    readCalls: vi.fn(),
    session: undefined as any,
  };
});

vi.mock("viem", async (original) => ({
  ...(await original<typeof import("viem")>()),
  createPublicClient: () => ({
    readContract: async ({ functionName }: { functionName: string }) => {
      if (functionName === "encryptedWinningsOf") return fixture.winningsHandle;
      return 0n;
    },
    getBlockNumber: async () => 0n,
    request: async () => [],
    watchBlockNumber: () => () => {},
    waitForTransactionReceipt: async () => ({ status: "success" }),
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
    name === "NEXT_PUBLIC_POOL_VERSION"
      ? fixture.version
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
  prepareSmartReadSessionCalls: fixture.readCalls,
  isZeroEncryptedHandle: (value: string) => value === `0x${"0".repeat(64)}`,
}));
vi.mock("@/lib/prize-check-coordinator", () => ({
  createPrizeCheckCoordinator: fixture.coordinator,
  createPrizeCheckIntentStore: vi.fn(),
  createViemPrizeChainReader: fixture.readerFactory,
  createViemPrizeProofClient: fixture.proofFactory,
}));
vi.mock("@/lib/morpho-yield", () => ({
  createLatestBlockRefresher: () => ({ refresh: async () => {}, dispose() {} }),
  readProjectedMorphoYield: vi.fn(async () => ({ source: "stored", accruedYieldAssets: 0n })),
}));
vi.mock("@/lib/client-errors", () => ({ reportClientToast: vi.fn(), reportClientError: vi.fn() }));
vi.mock("wagmi", () => ({ useBlockNumber: () => ({ data: undefined }) }));
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

async function prepareCheck() {
  mount();
  await screen.findByText("Your past results");
  fireEvent.change(screen.getByRole("spinbutton", { name: "Round number" }), {
    target: { value: "12" },
  });
  fireEvent.click(screen.getByRole("button", { name: "View round" }));
  fireEvent.click(await screen.findByRole("button", { name: "Review check" }));
  return screen.findByRole("button", { name: "Confirm" });
}

function savedIntent(drawId = 12n) {
  return {
    chainId: 11155111 as const,
    pool: fixture.pool,
    account: fixture.account,
    drawId,
    action: "checkPrize" as const,
    operation: {
      chainId: 11155111 as const,
      entryPoint: entryPoint07Address,
      sender: fixture.account,
      userOperationHash: `0x${"e".repeat(64)}` as const,
    },
  };
}

async function viewRound() {
  await screen.findByText("Your past results");
  fireEvent.change(screen.getByRole("spinbutton", { name: "Round number" }), {
    target: { value: "12" },
  });
  fireEvent.click(screen.getByRole("button", { name: "View round" }));
}

beforeEach(() => {
  localStorage.clear();
  fixture.prepare.mockReset();
  fixture.confirm.mockReset();
  fixture.send.mockReset();
  fixture.recover.mockReset();
  fixture.pending.mockReset();
  fixture.coordinator.mockReset();
  fixture.readerFactory.mockReset();
  fixture.proofFactory.mockReset();
  fixture.decrypt.mockReset();
  fixture.readCalls.mockReset();
  fixture.decrypt.mockResolvedValue(5_000_000n);
  fixture.winningsHandle = `0x${"1".repeat(64)}`;
  fixture.readCalls.mockResolvedValue([]);
  fixture.pending.mockReturnValue(null);
  fixture.recover.mockResolvedValue({ state: "pending" });
  fixture.session = {
    address: fixture.account,
    prepareTransaction: fixture.prepare,
    getPendingOperation: fixture.pending,
    recoverPendingOperation: fixture.recover,
  };
  fixture.readerFactory.mockReturnValue({
    readBlockHash: vi.fn(async () => `0x${"a".repeat(64)}`),
    readChecked: vi.fn(async () => false),
    readAward: vi.fn(async () => `0x${"b".repeat(64)}`),
  });
  fixture.proofFactory.mockReturnValue({
    listDraws: vi.fn(async () => ({ kind: "draws", draws: [] })),
  });
  fixture.coordinator.mockReturnValue({
    pending: () => null,
    reconcile: vi.fn(),
    review: vi.fn(async () => ({ state: "ready", drawId: 12n, proof: {} })),
    prepare: fixture.prepare,
  });
});

test("a failed attempted prize check keeps its observed operation checkable when pending lookup fails", async () => {
  const operation = {
    chainId: 11155111 as const,
    entryPoint: entryPoint07Address,
    sender: fixture.account,
    userOperationHash: `0x${"c".repeat(64)}` as const,
  };
  fixture.prepare.mockResolvedValue({
    cancel: vi.fn(),
    confirm: async ({
      onOperationPrepared,
    }: {
      onOperationPrepared: (value: typeof operation) => void;
    }) => {
      onOperationPrepared(operation);
      throw new Error("original prize check failure");
    },
  });
  fixture.pending.mockImplementation(() => {
    throw new Error("pending lookup failed");
  });
  fixture.recover.mockImplementation(() => {
    throw new Error("status lookup failed");
  });

  fireEvent.click(await prepareCheck());
  await waitFor(() =>
    expect(screen.getByTestId("actions").textContent).toContain(operation.userOperationHash),
  );
  fireEvent.click(screen.getByRole("button", { name: /^Activity/ }));
  expect(await screen.findByRole("button", { name: "Check status" })).toBeTruthy();
  expect(screen.getByText("Still processing")).toBeTruthy();
  expect(screen.queryByText("Failed")).toBeNull();
  expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  expect(screen.getByTestId("actions").textContent).toContain(operation.userOperationHash);

  fireEvent.click(screen.getByRole("button", { name: "Check status" }));
  await waitFor(() => expect(fixture.recover).toHaveBeenCalledTimes(1));
  expect(fixture.prepare).toHaveBeenCalledTimes(1);
  expect(fixture.send).not.toHaveBeenCalled();
  expect(screen.getByTestId("actions").textContent).toContain(operation.userOperationHash);
});

test("double Confirm creates one Activity action and sends one prepared prize check", async () => {
  const operation = {
    chainId: 11155111 as const,
    entryPoint: entryPoint07Address,
    sender: fixture.account,
    userOperationHash: `0x${"d".repeat(64)}` as const,
  };
  let resolveConfirm!: () => void;
  fixture.confirm.mockImplementation(
    ({ onOperationPrepared }: { onOperationPrepared: (value: typeof operation) => void }) => {
      onOperationPrepared(operation);
      return new Promise<void>((resolve) => {
        resolveConfirm = resolve;
      });
    },
  );
  fixture.prepare.mockResolvedValue({
    cancel: vi.fn(),
    confirm: fixture.confirm,
  });

  const confirm = await prepareCheck();
  fireEvent.click(confirm);
  fireEvent.click(confirm);

  await waitFor(() => expect(fixture.prepare).toHaveBeenCalledTimes(1));
  expect(fixture.confirm).toHaveBeenCalledTimes(1);
  await waitFor(() =>
    expect(screen.getByTestId("actions").textContent).toContain(operation.userOperationHash),
  );
  expect(JSON.parse(screen.getByTestId("actions").textContent ?? "[]")).toHaveLength(1);
  resolveConfirm();
});

test("reloads an exact pending prize check without preparing another action", async () => {
  const intent = savedIntent();
  fixture.coordinator.mockReturnValue({
    pending: (drawId: bigint) => (drawId === intent.drawId ? intent : null),
    reconcile: vi.fn(async () => ({ state: "pending", operation: intent.operation })),
    review: vi.fn(),
    prepare: fixture.prepare,
  });
  const first = mount();
  await viewRound();
  expect(await screen.findByText("This check is still processing.")).toBeTruthy();
  first.unmount();
  mount();
  await viewRound();
  expect(await screen.findByText("This check is still processing.")).toBeTruthy();
  expect(fixture.prepare).not.toHaveBeenCalled();
  expect(fixture.session.prepareTransaction).not.toHaveBeenCalled();
});

test("keeps a confirmed but unreadable result updating and retains recovery without retrying", async () => {
  const intent = savedIntent();
  const reconcile = vi.fn(async () => {
    throw new Error("checked state unavailable");
  });
  fixture.coordinator.mockReturnValue({
    pending: () => intent,
    reconcile,
    review: vi.fn(),
    prepare: fixture.prepare,
  });
  mount();
  await viewRound();
  expect(await screen.findByText("This result is updating. Check back shortly.")).toBeTruthy();
  expect(reconcile).toHaveBeenCalledWith(12n, intent, expect.any(AbortSignal));
  expect(fixture.prepare).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: "Review check" })).toBeNull();
});

test("renders the immutable recovered award without a fresh prize check", async () => {
  const intent = savedIntent();
  fixture.coordinator.mockReturnValue({
    pending: () => intent,
    reconcile: vi.fn(async () => ({ state: "checked", drawId: 12n, award: fixture.award })),
    review: vi.fn(),
    prepare: fixture.prepare,
  });
  mount();
  await viewRound();
  expect(await screen.findByText("Result checked")).toBeTruthy();
  expect(screen.getByText("5.000000 USDC")).toBeTruthy();
  expect(fixture.prepare).not.toHaveBeenCalled();
});

test.each(["Claim prize", "Add prize to savings"] as const)(
  "%s leaves a checked round visible after the aggregate credit is consumed",
  async (label) => {
    fixture.readerFactory.mockReturnValue({
      readBlockHash: vi.fn(async () => `0x${"a".repeat(64)}`),
      readChecked: vi.fn(async () => true),
      readAward: vi.fn(async () => fixture.award),
    });
    fixture.decrypt.mockImplementation(async (_session, handle) =>
      handle === fixture.award ? 5_000_000n : 5_000_000n,
    );
    fixture.prepare.mockResolvedValue({
      cancel: vi.fn(),
      send: async ({
        onOperationPrepared,
      }: {
        onOperationPrepared: (value: ReturnType<typeof savedIntent>["operation"]) => void;
      }) => {
        onOperationPrepared(savedIntent().operation);
        fixture.winningsHandle = `0x${"0".repeat(64)}`;
        return `0x${"f".repeat(64)}` as const;
      },
    });

    mount();
    await viewRound();
    expect(await screen.findByText("Round #12")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Check prize" }));
    fireEvent.click(await screen.findByRole("button", { name: label }));
    fireEvent.click(await screen.findByRole("button", { name: "Confirm" }));

    await waitFor(() => expect(screen.getByText("Nothing ready to claim")).toBeTruthy());
    expect(screen.getByText("Round #12")).toBeTruthy();
    expect(screen.getByText("5.000000 USDC")).toBeTruthy();
  },
);

test("a matching completed Activity record rereads the selected immutable award", async () => {
  const intent = savedIntent();
  window.localStorage.setItem(
    "kettigo:actions",
    JSON.stringify([
      {
        id: "completed-check",
        label: "Check prize",
        type: "check",
        status: "completed",
        operation: intent.operation,
        createdAt: 1,
        updatedAt: 1,
      },
    ]),
  );
  const reconcile = vi
    .fn()
    .mockResolvedValueOnce({ state: "pending", operation: intent.operation })
    .mockResolvedValueOnce({ state: "checked", drawId: 12n, award: fixture.award });
  fixture.coordinator.mockReturnValue({
    pending: () => intent,
    reconcile,
    review: vi.fn(),
    prepare: fixture.prepare,
  });
  mount();
  await viewRound();
  expect(await screen.findByText("Result checked")).toBeTruthy();
  expect(reconcile).toHaveBeenCalledTimes(2);
  expect(fixture.prepare).not.toHaveBeenCalled();
});

test.each([
  ["rejected", "This check was not approved.", false],
  ["not-submitted", "This check was not sent.", true],
  ["failed", "This check did not go through.", false],
] as const)(
  "shows the %s terminal state without automatically reviewing again",
  async (status, copy, canReview) => {
    const intent = savedIntent();
    window.localStorage.setItem(
      "kettigo:actions",
      JSON.stringify([
        {
          id: `saved-${status}`,
          label: "Check prize",
          type: "check",
          status,
          operation: intent.operation,
          createdAt: 1,
          updatedAt: 1,
        },
      ]),
    );
    fixture.coordinator.mockReturnValue({
      pending: () => intent,
      reconcile: vi.fn(async () => ({ state: "pending", operation: intent.operation })),
      review: vi.fn(),
      prepare: fixture.prepare,
    });
    mount();
    await viewRound();
    expect(await screen.findByText(copy)).toBeTruthy();
    expect(Boolean(screen.queryByRole("button", { name: "Review check" }))).toBe(canReview);
    expect(fixture.prepare).not.toHaveBeenCalled();
  },
);

test("never applies an unrelated saved round to the selected outcome", async () => {
  const intent = savedIntent(13n);
  const reconcile = vi.fn();
  fixture.coordinator.mockReturnValue({
    pending: (drawId: bigint) => (drawId === intent.drawId ? intent : null),
    reconcile,
    review: vi.fn(),
    prepare: fixture.prepare,
  });
  mount();
  await viewRound();
  expect(await screen.findByRole("button", { name: "Review check" })).toBeTruthy();
  expect(reconcile).not.toHaveBeenCalled();
  expect(fixture.prepare).not.toHaveBeenCalled();
});

test("reviews missing historical access once and retries the same checked result", async () => {
  const send = vi.fn(async () => `0x${"a".repeat(64)}` as const);
  fixture.readerFactory.mockReturnValue({
    readBlockHash: vi.fn(async () => `0x${"a".repeat(64)}`),
    readChecked: vi.fn(async () => true),
    readAward: vi.fn(async () => fixture.award),
  });
  fixture.decrypt
    .mockRejectedValueOnce(new ZamaReadSessionAccessRequiredError())
    .mockResolvedValueOnce(5_000_000n);
  fixture.prepare.mockResolvedValue({ cancel: vi.fn(), send });

  mount();
  await viewRound();
  expect(await screen.findByRole("button", { name: "Review access" })).toBeTruthy();
  expect(fixture.readCalls).not.toHaveBeenCalled();
  expect(fixture.prepare).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole("button", { name: "Review access" }));
  fireEvent.click(await screen.findByRole("button", { name: "Confirm" }));
  await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
  expect(fixture.readCalls).toHaveBeenCalledTimes(1);
  expect(fixture.prepare).toHaveBeenCalledTimes(1);
  expect(fixture.coordinator).not.toHaveBeenCalled();
  expect(await screen.findByText("5.000000 USDC")).toBeTruthy();
});

test("cancels an unused historical access review without losing the checked result", async () => {
  const cancel = vi.fn();
  fixture.readerFactory.mockReturnValue({
    readBlockHash: vi.fn(async () => `0x${"a".repeat(64)}`),
    readChecked: vi.fn(async () => true),
    readAward: vi.fn(async () => fixture.award),
  });
  fixture.decrypt.mockRejectedValue(new ZamaReadSessionAccessRequiredError());
  fixture.prepare.mockResolvedValue({ cancel, send: fixture.send });

  mount();
  await viewRound();
  fireEvent.click(await screen.findByRole("button", { name: "Review access" }));
  expect(await screen.findByRole("button", { name: "Confirm" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "View round" }));

  await waitFor(() => expect(cancel).toHaveBeenCalledTimes(1));
  expect(fixture.send).not.toHaveBeenCalled();
  expect(await screen.findByRole("button", { name: "Review access" })).toBeTruthy();
  fixture.prepare.mockRejectedValueOnce(new Error("review unavailable"));
  fireEvent.click(screen.getByRole("button", { name: "Review access" }));
  await waitFor(() => expect(fixture.prepare).toHaveBeenCalledTimes(2));
  expect(await screen.findByRole("button", { name: "Review access" })).toBeTruthy();
  expect(fixture.send).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: "Review check" })).toBeNull();
});

test("cancels a late unused check review but retains an attempted operation", async () => {
  const lateCancel = vi.fn();
  let resolvePrepare!: (value: { cancel: () => void; confirm: typeof fixture.confirm }) => void;
  fixture.prepare.mockImplementation(
    () =>
      new Promise((resolve) => {
        resolvePrepare = resolve;
      }),
  );

  mount();
  await viewRound();
  fireEvent.click(await screen.findByRole("button", { name: "Review check" }));
  await waitFor(() => expect(fixture.prepare).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByRole("button", { name: "View round" }));
  resolvePrepare({ cancel: lateCancel, confirm: fixture.confirm });
  await waitFor(() => expect(lateCancel).toHaveBeenCalledTimes(1));
  expect(screen.queryByRole("button", { name: "Confirm" })).toBeNull();

  const readyCancel = vi.fn();
  fixture.prepare.mockResolvedValue({ cancel: readyCancel, confirm: fixture.confirm });
  fireEvent.click(await screen.findByRole("button", { name: "Review check" }));
  expect(await screen.findByRole("button", { name: "Confirm" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "View round" }));
  await waitFor(() => expect(readyCancel).toHaveBeenCalledTimes(1));

  const operation = {
    chainId: 11155111 as const,
    entryPoint: entryPoint07Address,
    sender: fixture.account,
    userOperationHash: `0x${"f".repeat(64)}` as const,
  };
  const attemptedCancel = vi.fn();
  fixture.prepare.mockResolvedValue({
    cancel: attemptedCancel,
    confirm: ({
      onOperationPrepared,
    }: {
      onOperationPrepared: (value: typeof operation) => void;
    }) => {
      onOperationPrepared(operation);
      return new Promise<never>(() => undefined);
    },
  });
  fireEvent.click(await screen.findByRole("button", { name: "Review check" }));
  fireEvent.click(await screen.findByRole("button", { name: "Confirm" }));
  await waitFor(() =>
    expect(screen.getByTestId("actions").textContent).toContain(operation.userOperationHash),
  );
  fireEvent.click(screen.getByRole("button", { name: "View round" }));
  expect(attemptedCancel).not.toHaveBeenCalled();
  expect(screen.getByTestId("actions").textContent).toContain(operation.userOperationHash);
});

test("keeps a NotEntitled historical read terminal without offering an access review", async () => {
  const notEntitled = Object.assign(new Error("raw SDK error"), { name: "NotEntitled" });
  fixture.readerFactory.mockReturnValue({
    readBlockHash: vi.fn(async () => `0x${"a".repeat(64)}`),
    readChecked: vi.fn(async () => true),
    readAward: vi.fn(async () => fixture.award),
  });
  fixture.decrypt.mockRejectedValue(notEntitled);

  mount();
  await viewRound();
  expect(await screen.findByText("This result cannot be shown right now.")).toBeTruthy();
  expect(screen.getByText("Result checked")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Review access" })).toBeNull();
  expect(fixture.decrypt).toHaveBeenCalledTimes(1);
  expect(fixture.readCalls).not.toHaveBeenCalled();
  expect(fixture.prepare).not.toHaveBeenCalled();
  expect(screen.queryByText("raw SDK error")).toBeNull();
});
