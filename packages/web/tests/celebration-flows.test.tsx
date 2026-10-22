import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { LazyMotion, MotionConfig, domMax } from "motion/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import SavingsPage from "../src/app/savings/page";
import DrawPage from "../src/app/draw/page";
import { ToastProvider } from "../src/components/Toast";

const fixture = vi.hoisted(() => ({
  receipt: vi.fn(),
  decrypt: vi.fn(),
  sendBatch: vi.fn(),
  handle: `0x${"1".repeat(64)}`,
  account: "0x1111111111111111111111111111111111111111",
  refresh: vi.fn(async () => {}),
}));

vi.mock("viem", async (original) => ({
  ...await original<typeof import("viem")>(),
  createPublicClient: () => ({
    readContract: async ({ functionName }: { functionName: string }) => {
      if (functionName === "balanceOf") return 1_000_000_000n;
      if (functionName === "encryptedWinningsOf") return fixture.handle;
      return 0n;
    },
    getBlockNumber: async () => 0n,
    request: async () => [],
    watchBlockNumber: () => () => {},
    waitForTransactionReceipt: fixture.receipt,
  }),
}));
vi.mock("@/lib/contracts", async (original) => ({
  ...await original<typeof import("@/lib/contracts")>(),
  CONTRACTS: {
    usdc: "0x1111111111111111111111111111111111111111",
    confidentialUsdc: "0x2222222222222222222222222222222222222222",
    confidentialPrizePool: "0x3333333333333333333333333333333333333333",
  },
}));
vi.mock("@/lib/wallet-context", () => ({
  useWallet: () => ({
    session: { address: fixture.account, ownerAddress: fixture.account },
    principal: 0n,
    refreshConfidentialBalances: fixture.refresh,
  }),
}));
vi.mock("@/lib/web3auth", () => ({
  sendSmartTransactionBatch: fixture.sendBatch,
  sendSmartTransaction: vi.fn(),
}));
vi.mock("@/lib/zama", async () => {
  const { getAddress } = await vi.importActual<typeof import("viem")>("viem");
  return {
    asChecksumAddress: getAddress,
    createSmartZamaSDK: () => ({ terminate() {} }),
    createOwnerZamaSDK: () => ({ terminate() {} }),
    createPublicZamaSDK: vi.fn(),
    decryptUint64: fixture.decrypt,
    decryptPublicUint64: vi.fn(),
    encryptUint64: async () => ({ handle: fixture.handle, inputProof: "0x" }),
    isZeroEncryptedHandle: (handle: string) => handle === `0x${"0".repeat(64)}`,
  };
});
vi.mock("@/components/ActionCenter", () => ({
  useActionCenter: () => ({
    runAction: (_input: unknown, runner: (controls: unknown) => Promise<void>) => {
      void runner({ id: "deposit", update() {} });
      return "deposit";
    },
  }),
}));
vi.mock("@/lib/morpho-yield", () => ({
  createLatestBlockRefresher: () => ({ refresh: async () => {}, dispose() {} }),
  readProjectedMorphoYield: vi.fn(),
}));
vi.mock("wagmi", () => ({
  useBlockNumber: () => ({ data: undefined }),
}));
vi.mock("canvas-confetti", () => ({
  default: { create: () => Object.assign(() => {}, { reset() {} }) },
}));

function mount(page: React.ReactNode) {
  return render(<MotionConfig reducedMotion="user"><LazyMotion features={domMax}>
    <ToastProvider>{page}</ToastProvider>
  </LazyMotion></MotionConfig>);
}

async function deposit() {
  const view = mount(<SavingsPage />);
  await screen.findByText("1,000.00 USDC");
  fireEvent.click(screen.getByRole("button", { name: /^Deposit$/ }));
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "10" } });
  fireEvent.click(screen.getByRole("button", { name: "Review deposit" }));
  fireEvent.click(screen.getByRole("button", { name: /^Confirm$/ }));
  return view;
}

beforeEach(() => {
  localStorage.clear();
  fixture.handle = `0x${"1".repeat(64)}`;
  fixture.receipt.mockResolvedValue({ status: "success" });
  fixture.sendBatch.mockResolvedValue(`0x${"2".repeat(64)}`);
  fixture.decrypt.mockResolvedValue(25_000_000n);
});

describe("deposit celebrations", () => {
  it("waits for confirmation before celebrating a deposit", async () => {
    let confirm!: (receipt: { status: string }) => void;
    fixture.receipt.mockReturnValue(new Promise(resolve => { confirm = resolve; }));
    const { container } = await deposit();
    await waitFor(() => expect(fixture.receipt).toHaveBeenCalled());
    expect(container.querySelector("canvas")).toBeNull();
    expect(screen.queryByText("Deposit complete.")).toBeNull();
    await act(async () => confirm({ status: "success" }));
    expect(screen.getByRole("status").textContent).toContain("Deposit complete.");
    expect(container.querySelector("canvas")).not.toBeNull();
  });

  it("does not celebrate a reverted deposit", async () => {
    fixture.receipt.mockResolvedValue({ status: "reverted" });
    const { container } = await deposit();
    await screen.findByText("Transaction failed");
    expect(container.querySelector("canvas")).toBeNull();
    expect(screen.queryByText("Deposit complete.")).toBeNull();
  });

  it("does not celebrate a rejected deposit approval", async () => {
    fixture.sendBatch.mockRejectedValue(new Error("Request rejected"));
    const { container } = await deposit();
    await screen.findByText("Transaction failed");
    expect(container.querySelector("canvas")).toBeNull();
  });
});

describe("prize reveals", () => {
  it("celebrates only after a positive prize amount is available", async () => {
    let reveal!: (amount: bigint) => void;
    fixture.decrypt.mockReturnValue(new Promise(resolve => { reveal = resolve; }));
    const { container } = mount(<DrawPage />);
    fireEvent.click(screen.getByRole("button", { name: "Check prize" }));
    await waitFor(() => expect(fixture.decrypt).toHaveBeenCalled());
    expect(container.querySelector("canvas")).toBeNull();
    await act(async () => reveal(25_000_000n));
    expect(screen.getByRole("status").textContent).toContain("25.000000 USDC");
    expect(container.querySelector("canvas")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Claim prize" })).toBeTruthy();
  });

  it.each(["zero amount", "empty balance"])("keeps %s calm", async (scenario) => {
    fixture.decrypt.mockResolvedValue(0n);
    if (scenario === "empty balance") fixture.handle = `0x${"0".repeat(64)}`;
    const { container } = mount(<DrawPage />);
    fireEvent.click(screen.getByRole("button", { name: "Check prize" }));
    await screen.findByText("No prize this time.");
    expect(container.querySelector("canvas")).toBeNull();
    expect(screen.getByRole("button", { name: "Check prize" })).toBeTruthy();
  });

  it("does not celebrate an unsuccessful prize check", async () => {
    fixture.decrypt.mockRejectedValue(new Error("Request rejected"));
    const { container } = mount(<DrawPage />);
    fireEvent.click(screen.getByRole("button", { name: "Check prize" }));
    await screen.findByText("Transaction failed");
    expect(container.querySelector("canvas")).toBeNull();
  });
});
