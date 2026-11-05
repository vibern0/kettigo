import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";

const fixture = vi.hoisted(() => {
  const account = "0x1111111111111111111111111111111111111111" as const;
  const pool = "0x3333333333333333333333333333333333333333" as const;
  const award = `0x${"2".repeat(64)}` as const;
  return {
    account,
    pool,
    award,
    version: "legacy1",
    proofUrl: "https://proof.example",
    listDraws: vi.fn(),
    proofFactory: vi.fn(),
    readerFactory: vi.fn(),
    decryptExisting: vi.fn(),
    refresh: vi.fn(),
    session: { address: account, prepareTransaction: vi.fn(), sendTransaction: vi.fn() },
  };
});

vi.mock("viem", async (original) => ({
  ...(await original<typeof import("viem")>()),
  createPublicClient: () => ({
    readContract: async ({ functionName }: { functionName: string }) => {
      if (functionName === "encryptedWinningsOf") return `0x${"0".repeat(64)}`;
      return 0n;
    },
    getBlockNumber: async () => 0n,
    waitForTransactionReceipt: vi.fn(),
    watchBlockNumber: () => () => {},
  }),
}));
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
      ? fixture.version
      : name === "NEXT_PUBLIC_PROOF_SERVICE_URL"
        ? fixture.proofUrl
        : (fallback ?? ""),
}));
vi.mock("@/lib/wallet-context", () => ({
  useWallet: () => ({ session: fixture.session, refreshConfidentialBalances: fixture.refresh }),
}));
vi.mock("@/lib/zama", async () => ({
  asChecksumAddress: (await vi.importActual<typeof import("viem")>("viem")).getAddress,
  decryptExistingSmartUint64: fixture.decryptExisting,
  decryptSmartUint64: fixture.decryptExisting,
  isZeroEncryptedHandle: (value: string) => value === `0x${"0".repeat(64)}`,
}));
vi.mock("@/lib/prize-check-coordinator", () => ({
  createViemPrizeChainReader: fixture.readerFactory,
  createViemPrizeProofClient: fixture.proofFactory,
}));
vi.mock("@/lib/morpho-yield", () => ({
  createLatestBlockRefresher: () => ({ refresh: async () => {}, dispose() {} }),
  readProjectedMorphoYield: vi.fn(async () => ({ source: "stored", accruedYieldAssets: 0n })),
}));
vi.mock("@/lib/client-errors", () => ({ reportClientToast: vi.fn() }));
vi.mock("wagmi", () => ({ useBlockNumber: () => ({ data: undefined }) }));

import DrawPage from "@/app/draw/page";
import { ToastProvider } from "@/components/Toast";

function mount() {
  return render(
    <ToastProvider>
      <DrawPage />
    </ToastProvider>,
  );
}

beforeEach(() => {
  fixture.version = "legacy1";
  fixture.proofUrl = "https://proof.example";
  fixture.listDraws.mockReset();
  fixture.proofFactory.mockReset();
  fixture.readerFactory.mockReset();
  fixture.decryptExisting.mockReset();
  fixture.refresh.mockReset();
  fixture.readerFactory.mockReturnValue({
    readBlockHash: vi.fn(async () => `0x${"a".repeat(64)}`),
    readChecked: vi.fn(async () => true),
    readAward: vi.fn(async () => fixture.award),
  });
  fixture.proofFactory.mockImplementation(() => ({ listDraws: fixture.listDraws }));
  fixture.listDraws.mockResolvedValue({
    kind: "draws",
    draws: [
      {
        drawId: 4n,
        closeBlockNumber: 44n,
        closeLogIndex: 0,
        chainId: 11155111n,
        pool: fixture.pool,
        blockHash: `0x${"a".repeat(64)}`,
        rootHash: `0x${"b".repeat(64)}`,
        rootSum: `0x${"c".repeat(64)}`,
        ticket: `0x${"d".repeat(64)}`,
        upperBound: 2n,
      },
      {
        drawId: 3n,
        closeBlockNumber: 33n,
        closeLogIndex: 0,
        chainId: 11155111n,
        pool: fixture.pool,
        blockHash: `0x${"a".repeat(64)}`,
        rootHash: `0x${"b".repeat(64)}`,
        rootSum: `0x${"c".repeat(64)}`,
        ticket: `0x${"d".repeat(64)}`,
        upperBound: 2n,
      },
    ],
  });
  fixture.decryptExisting.mockResolvedValue(5_000_000n);
});

test("keeps the legacy draw page free of history reads", async () => {
  mount();
  await screen.findByText("My winnings");
  expect(screen.queryByText("Your past results")).toBeNull();
  expect(fixture.readerFactory).not.toHaveBeenCalled();
  expect(fixture.proofFactory).not.toHaveBeenCalled();
});

test("lists one bounded descending page of past results", async () => {
  fixture.version = "2";
  mount();
  expect(await screen.findByRole("button", { name: "Round #4" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Round #3" })).toBeTruthy();
  const request = fixture.listDraws.mock.calls[0][0] as { limit: number };
  expect(request.limit).toBeGreaterThanOrEqual(1);
  expect(request.limit).toBeLessThanOrEqual(100);
});

test("loads an earlier page only when the person asks", async () => {
  fixture.version = "2";
  const draw = (drawId: bigint) => ({
    drawId,
    closeBlockNumber: drawId,
    closeLogIndex: 0,
    chainId: 11155111n,
    pool: fixture.pool,
    blockHash: `0x${"a".repeat(64)}` as const,
    rootHash: `0x${"b".repeat(64)}` as const,
    rootSum: `0x${"c".repeat(64)}` as const,
    ticket: `0x${"d".repeat(64)}` as const,
    upperBound: 2n,
  });
  fixture.listDraws
    .mockResolvedValueOnce({
      kind: "draws",
      draws: Array.from({ length: 25 }, (_, i) => draw(BigInt(30 - i))),
    })
    .mockResolvedValueOnce({ kind: "draws", draws: [draw(5n)] });
  mount();
  await screen.findByRole("button", { name: "Show earlier results" });
  expect(fixture.listDraws).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "Show earlier results" }));
  expect(await screen.findByRole("button", { name: "Round #5" })).toBeTruthy();
  expect(fixture.listDraws).toHaveBeenCalledTimes(2);
  expect(fixture.listDraws.mock.calls[1][0]).toMatchObject({ cursor: 6n, limit: 25 });
});

test("shows a requested checked round without an archive client", async () => {
  fixture.version = "2";
  fixture.proofUrl = "";
  mount();
  await screen.findByText("Your past results");
  fireEvent.change(screen.getByRole("spinbutton", { name: "Round number" }), {
    target: { value: "12" },
  });
  fireEvent.click(screen.getByRole("button", { name: "View round" }));
  expect(await screen.findByText("Round #12")).toBeTruthy();
  expect(screen.getByText("Result checked")).toBeTruthy();
  expect(screen.getByText("5.000000 USDC")).toBeTruthy();
  expect(fixture.proofFactory).not.toHaveBeenCalled();
  expect(fixture.decryptExisting).toHaveBeenCalledTimes(1);
  expect(fixture.session.prepareTransaction).not.toHaveBeenCalled();
  expect(fixture.session.sendTransaction).not.toHaveBeenCalled();
});

test("keeps a late selected-round result out of the newer view", async () => {
  fixture.version = "2";
  fixture.proofUrl = "";
  let resolveOld!: (value: boolean) => void;
  fixture.readerFactory.mockReturnValue({
    readBlockHash: vi.fn(async () => `0x${"a".repeat(64)}`),
    readChecked: vi.fn((drawId: bigint) =>
      drawId === 12n
        ? new Promise<boolean>((resolve) => {
            resolveOld = resolve;
          })
        : Promise.resolve(true),
    ),
    readAward: vi.fn(async () => fixture.award),
  });
  mount();
  await screen.findByText("Your past results");
  const input = screen.getByRole("spinbutton", { name: "Round number" });
  fireEvent.change(input, { target: { value: "12" } });
  fireEvent.click(screen.getByRole("button", { name: "View round" }));
  await waitFor(() => expect(fixture.readerFactory).toHaveBeenCalledTimes(1));
  fireEvent.change(input, { target: { value: "13" } });
  fireEvent.click(screen.getByRole("button", { name: "View round" }));
  expect(await screen.findByText("Round #13")).toBeTruthy();
  resolveOld(true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(screen.queryByText("Round #12")).toBeNull();
});
