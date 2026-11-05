import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { entryPoint07Address } from "viem/account-abstraction";

const fixture = vi.hoisted(() => {
  const account = "0x1111111111111111111111111111111111111111" as const;
  const pool = "0x3333333333333333333333333333333333333333" as `0x${string}`;
  return {
    account,
    pool,
    award: `0x${"2".repeat(64)}` as const,
    prepare: vi.fn(),
    coordinator: vi.fn(),
    readerFactory: vi.fn(),
    proofFactory: vi.fn(),
    decrypt: vi.fn(),
    winningsHandle: `0x${"1".repeat(64)}` as `0x${string}`,
    session: undefined as any,
  };
});

vi.mock("viem", async (original) => ({
  ...(await original<typeof import("viem")>()),
  createPublicClient: () => ({
    readContract: async ({ functionName }: { functionName: string }) =>
      functionName === "encryptedWinningsOf" ? fixture.winningsHandle : 0n,
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
  SELECTED_SCOPE: {
    id: "candidate-v2",
    mode: "v2",
    proofServiceUrl: "https://proof.example",
  },
  publicConfig: (name: string, fallback?: string) =>
    name === "NEXT_PUBLIC_POOL_VERSION"
      ? "2"
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
  prepareSmartReadSessionCalls: vi.fn(async () => []),
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
}));
vi.mock("@/lib/client-errors", () => ({ reportClientToast: vi.fn(), reportClientError: vi.fn() }));
vi.mock("wagmi", () => ({ useBlockNumber: () => ({ data: undefined }) }));
vi.mock("canvas-confetti", () => ({
  default: { create: () => Object.assign(() => {}, { reset() {} }) },
}));

import DrawPage from "@/app/draw/page";
import { ActionCenterProvider } from "@/components/ActionCenter";
import { ToastProvider } from "@/components/Toast";

function mount() {
  return render(
    <ToastProvider>
      <ActionCenterProvider>
        <DrawPage />
      </ActionCenterProvider>
    </ToastProvider>,
  );
}

function savedIntent() {
  return {
    chainId: 11155111 as const,
    pool: fixture.pool,
    account: fixture.account,
    drawId: 12n,
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
  fixture.coordinator.mockReset();
  fixture.readerFactory.mockReset();
  fixture.proofFactory.mockReset();
  fixture.decrypt.mockReset();
  fixture.decrypt.mockResolvedValue(5_000_000n);
  fixture.winningsHandle = `0x${"1".repeat(64)}`;
  fixture.session = { address: fixture.account, prepareTransaction: fixture.prepare };
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
  localStorage.setItem(
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
