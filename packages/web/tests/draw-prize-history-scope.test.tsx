import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  account: "0x1111111111111111111111111111111111111111" as `0x${string}`,
  pool: "0x3333333333333333333333333333333333333333" as `0x${string}`,
  alternateAccount: "0x4444444444444444444444444444444444444444" as const,
  alternatePool: "0x5555555555555555555555555555555555555555" as const,
  award: `0x${"2".repeat(64)}` as const,
  readerFactory: vi.fn(),
  decrypt: vi.fn(async () => 5_000_000n),
  session: undefined as any,
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
    get confidentialPrizePool() {
      return fixture.pool;
    },
  },
}));
vi.mock("@/lib/runtime-config", () => ({
  publicConfig: (name: string, fallback?: string) =>
    name === "NEXT_PUBLIC_POOL_VERSION"
      ? "2"
      : name === "NEXT_PUBLIC_PROOF_SERVICE_URL"
        ? ""
        : fallback,
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
  createViemPrizeChainReader: fixture.readerFactory,
  createViemPrizeProofClient: vi.fn(),
}));
vi.mock("@/lib/morpho-yield", () => ({
  createLatestBlockRefresher: () => ({ refresh: async () => {}, dispose() {} }),
  readProjectedMorphoYield: vi.fn(async () => ({ source: "stored", accruedYieldAssets: 0n })),
}));
vi.mock("@/lib/client-errors", () => ({ reportClientToast: vi.fn() }));
vi.mock("wagmi", () => ({ useBlockNumber: () => ({ data: undefined }) }));

import DrawPage from "@/app/draw/page";
import { ActionCenterProvider } from "@/components/ActionCenter";
import { ToastProvider } from "@/components/Toast";

function tree() {
  return (
    <ToastProvider>
      <ActionCenterProvider>
        <DrawPage />
      </ActionCenterProvider>
    </ToastProvider>
  );
}

test("replaces account and configured pool before reading the new selected round", async () => {
  let resolveOld!: (value: boolean) => void;
  fixture.session = {
    address: fixture.account,
    prepareTransaction: vi.fn(),
    sendTransaction: vi.fn(),
  };
  fixture.readerFactory.mockImplementation((_client, pool: string) => ({
    readBlockHash: vi.fn(async () => `0x${"a".repeat(64)}`),
    readChecked: vi.fn((drawId: bigint) =>
      pool === fixture.pool && drawId === 12n
        ? new Promise<boolean>((resolve) => {
            resolveOld = resolve;
          })
        : Promise.resolve(true),
    ),
    readAward: vi.fn(async () => fixture.award),
  }));
  const rendered = render(tree());
  await screen.findByText("Your past results");
  const input = screen.getByRole("spinbutton", { name: "Round number" });
  fireEvent.change(input, { target: { value: "12" } });
  fireEvent.click(screen.getByRole("button", { name: "View round" }));
  await waitFor(() => expect(fixture.readerFactory).toHaveBeenCalledTimes(1));
  fixture.pool = fixture.alternatePool;
  fixture.session = { ...fixture.session, address: fixture.alternateAccount };
  rendered.rerender(tree());
  fireEvent.change(screen.getByRole("spinbutton", { name: "Round number" }), {
    target: { value: "13" },
  });
  fireEvent.click(screen.getByRole("button", { name: "View round" }));
  expect(await screen.findByText("Round #13")).toBeTruthy();
  resolveOld(true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(screen.queryByText("Round #12")).toBeNull();
  expect(fixture.readerFactory).toHaveBeenLastCalledWith(expect.anything(), fixture.alternatePool);
});

test.each([
  ["account", true, false],
  ["pool", false, true],
])(
  "clears a checked result immediately when the %s scope changes",
  async (_scope, changeAccount, changePool) => {
    fixture.pool = "0x3333333333333333333333333333333333333333";
    fixture.session = {
      address: fixture.account,
      prepareTransaction: vi.fn(),
      sendTransaction: vi.fn(),
    };
    fixture.readerFactory.mockReturnValue({
      readBlockHash: vi.fn(async () => `0x${"a".repeat(64)}`),
      readChecked: vi.fn(async () => true),
      readAward: vi.fn(async () => fixture.award),
    });

    const rendered = render(tree());
    await screen.findByText("Your past results");
    fireEvent.change(screen.getByRole("spinbutton", { name: "Round number" }), {
      target: { value: "12" },
    });
    fireEvent.click(screen.getByRole("button", { name: "View round" }));
    expect(await screen.findByText("5.000000 USDC")).toBeTruthy();

    if (changePool) fixture.pool = fixture.alternatePool;
    if (changeAccount) fixture.session = { ...fixture.session, address: fixture.alternateAccount };
    rendered.rerender(tree());

    expect(screen.queryByText("Round #12")).toBeNull();
    expect(screen.queryByText("5.000000 USDC")).toBeNull();
  },
);
