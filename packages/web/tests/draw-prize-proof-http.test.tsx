import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";

const fixture = vi.hoisted(() => {
  const account = "0x1111111111111111111111111111111111111111" as const;
  const pool = "0x3333333333333333333333333333333333333333" as const;
  return {
    account,
    pool,
    fetch: vi.fn(),
    request: vi.fn(),
    prepare: vi.fn(),
    send: vi.fn(),
    readCalls: vi.fn(),
    session: undefined as any,
  };
});

vi.mock("viem", async (original) => ({
  ...(await original<typeof import("viem")>()),
  createPublicClient: () => ({
    request: fixture.request,
    readContract: async ({ functionName }: { functionName: string }) => {
      if (functionName === "encryptedWinningsOf") return `0x${"0".repeat(64)}`;
      return 0n;
    },
    getBlockNumber: async () => 0n,
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
      ? "2"
      : name === "NEXT_PUBLIC_PROOF_SERVICE_URL"
        ? "https://proof.example/"
        : (fallback ?? ""),
}));
vi.mock("@/lib/wallet-context", () => ({
  useWallet: () => ({ session: fixture.session, refreshConfidentialBalances: vi.fn() }),
}));
vi.mock("@/lib/zama", async () => ({
  asChecksumAddress: (await vi.importActual<typeof import("viem")>("viem")).getAddress,
  decryptExistingSmartUint64: vi.fn(async () => 0n),
  decryptSmartUint64: vi.fn(async () => 0n),
  prepareSmartReadSessionCalls: fixture.readCalls,
  isZeroEncryptedHandle: (value: string) => value === `0x${"0".repeat(64)}`,
}));
vi.mock("@/lib/morpho-yield", () => ({
  createLatestBlockRefresher: () => ({ refresh: async () => {}, dispose() {} }),
  readProjectedMorphoYield: vi.fn(async () => ({ source: "stored", accruedYieldAssets: 0n })),
}));
vi.mock("@/lib/client-errors", () => ({ reportClientToast: vi.fn(), reportClientError: vi.fn() }));
vi.mock("wagmi", () => ({ useBlockNumber: () => ({ data: undefined }) }));

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

async function reviewRound() {
  await screen.findByText("Your past results");
  fireEvent.change(screen.getByRole("spinbutton", { name: "Round number" }), {
    target: { value: "12" },
  });
  fireEvent.click(screen.getByRole("button", { name: "View round" }));
  fireEvent.click(await screen.findByRole("button", { name: "Review check" }));
}

function otherwiseValidProof() {
  return {
    drawId: "12",
    rootHash: `0x${"1".repeat(64)}`,
    rootSum: `0x${"2".repeat(64)}`,
    ticket: `0x${"3".repeat(64)}`,
    upperBound: "1",
    closeBlockNumber: 7,
    closeLogIndex: 0,
    chainId: "11155111",
    pool: fixture.pool,
    blockHash: `0x${"4".repeat(64)}`,
    account: "0x4444444444444444444444444444444444444444",
    index: "0",
    generation: "1",
    balance: `0x${"5".repeat(64)}`,
    siblingHashes: Array(32).fill(`0x${"6".repeat(64)}`),
    siblingSums: Array(32).fill(`0x${"7".repeat(64)}`),
    parentSums: Array(32).fill(`0x${"8".repeat(64)}`),
  };
}

beforeEach(() => {
  localStorage.clear();
  fixture.fetch.mockReset();
  fixture.request.mockReset();
  fixture.prepare.mockReset();
  fixture.send.mockReset();
  fixture.readCalls.mockReset();
  fixture.readCalls.mockResolvedValue([]);
  fixture.session = {
    address: fixture.account,
    prepareTransaction: fixture.prepare,
    getPendingOperation: () => null,
  };
  fixture.request.mockImplementation(async ({ method }: { method: string }) => {
    if (method === "eth_getBlockByNumber") return { hash: `0x${"a".repeat(64)}` };
    if (method === "eth_call") return `0x${"0".repeat(64)}`;
    throw new Error(`unexpected RPC ${method}`);
  });
  vi.stubGlobal("fetch", fixture.fetch);
});

test("rejects a malformed proof HTTP body before preparing or sending", async () => {
  fixture.fetch.mockImplementation(async (input: URL) =>
    input.pathname.endsWith("/draws")
      ? new Response(JSON.stringify({ draws: [] }))
      : new Response(JSON.stringify({ proof: { drawId: "12", balance: "not-hex" } })),
  );
  mount();
  await reviewRound();
  expect(await screen.findByText("This result is unavailable right now.")).toBeTruthy();
  expect(fixture.fetch.mock.calls.some(([url]) => String(url).includes("/proof/"))).toBe(true);
  expect(fixture.prepare).not.toHaveBeenCalled();
  expect(fixture.readCalls).not.toHaveBeenCalled();
  expect(fixture.send).not.toHaveBeenCalled();
  // View and review each make one block and one checked read. Malformed proof
  // parsing must not add the draw-snapshot or close-block verification reads.
  expect(fixture.request).toHaveBeenCalledTimes(4);
});

test("rejects an otherwise valid proof with a wrong account scope before proof RPC verification", async () => {
  fixture.fetch.mockImplementation(async (input: URL) =>
    input.pathname.endsWith("/draws")
      ? new Response(JSON.stringify({ draws: [] }))
      : new Response(JSON.stringify({ proof: otherwiseValidProof() })),
  );
  mount();
  await reviewRound();
  expect(await screen.findByText("This result is unavailable right now.")).toBeTruthy();
  const proofRequest = fixture.fetch.mock.calls.find(([url]) => String(url).includes("/proof/"));
  expect(String(proofRequest?.[0])).toContain(`/draws/12/proof/${fixture.account}`);
  expect(fixture.prepare).not.toHaveBeenCalled();
  expect(fixture.readCalls).not.toHaveBeenCalled();
  expect(fixture.send).not.toHaveBeenCalled();
  // The complete body reaches scope validation, but scope rejection happens
  // before authenticated-path snapshot reads.
  expect(fixture.request).toHaveBeenCalledTimes(4);
});
