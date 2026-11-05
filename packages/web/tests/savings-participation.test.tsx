import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  account: "0x1111111111111111111111111111111111111111" as const,
  pool: "0x3333333333333333333333333333333333333333" as const,
  version: "legacy1",
  reads: vi.fn(),
  prepare: vi.fn(),
  send: vi.fn(),
  decrypt: vi.fn(),
  membershipIndex: 0n,
  session: undefined as { address: `0x${string}`; prepareTransaction: typeof vi.fn } | undefined,
  pending: [] as [`0x${string}`, bigint, `0x${string}`, boolean][],
}));

vi.mock("viem", async (original) => ({
  ...(await original<typeof import("viem")>()),
  createPublicClient: () => ({
    readContract: fixture.reads,
    getBlockNumber: async () => 0n,
    request: async () => [],
    watchBlockNumber: () => () => {},
    waitForTransactionReceipt: async () => ({ status: "success" }),
  }),
}));
vi.mock("@/lib/runtime-config", () => ({
  publicConfig: (name: string, fallback?: string) =>
    name === "NEXT_PUBLIC_POOL_VERSION" ? fixture.version : (fallback ?? ""),
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
    principal: undefined,
    confidentialBalancesLoading: false,
    confidentialBalancesError: null,
    confidentialBalancesReadState: "ready",
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
  encryptUint64: vi.fn(),
  prepareSmartReadSessionCalls: vi.fn(),
  withSmartZamaSDK: vi.fn(),
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

import SavingsPage from "@/app/savings/page";
import { ToastProvider } from "@/components/Toast";

const marker = `0x${"a".repeat(64)}` as const;
const proof = "0x1234" as const;
const pending = (requested = true): [`0x${string}`, bigint, `0x${string}`, boolean] => [
  marker,
  7n,
  marker,
  requested,
];

function mount() {
  return render(
    <ToastProvider>
      <SavingsPage />
    </ToastProvider>,
  );
}

beforeEach(() => {
  fixture.version = "legacy1";
  fixture.pending = [pending()];
  fixture.membershipIndex = 0n;
  fixture.reads.mockReset();
  fixture.prepare.mockReset();
  fixture.send.mockReset();
  fixture.decrypt.mockReset();
  fixture.session = { address: fixture.account, prepareTransaction: fixture.prepare };
  fixture.reads.mockImplementation(async ({ functionName }: { functionName: string }) => {
    if (functionName === "membershipIndexOf") return fixture.membershipIndex;
    if (functionName === "pendingAdmissionOf") return fixture.pending.shift() ?? pending();
    if (functionName === "balanceOf") return 0n;
    return 0n;
  });
  fixture.prepare.mockResolvedValue({ cancel: vi.fn(), send: fixture.send });
  fixture.send.mockImplementation(async () => {
    fixture.membershipIndex = 1n;
    fixture.pending = [pending(false)];
    return "0xdead";
  });
  fixture.decrypt.mockResolvedValue({ clearValue: true, decryptionProof: proof });
});

afterEach(cleanup);

test("legacy Savings makes zero membership and admission reads", async () => {
  mount();
  await new Promise((done) => setTimeout(done, 0));
  expect(
    fixture.reads.mock.calls.filter(([call]) =>
      ["membershipIndexOf", "pendingAdmissionOf"].includes(call.functionName),
    ),
  ).toHaveLength(0);
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
