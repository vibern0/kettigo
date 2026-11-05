import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  scopeId: "legacy-9c" as "legacy-9c" | "candidate-v2",
  alternateOrigin: false,
  session: undefined as { address: `0x${string}` } | undefined,
}));

vi.mock("next/image", () => ({
  default: (props: React.ImgHTMLAttributes<HTMLImageElement>) => <img {...props} />,
}));
vi.mock("next/navigation", () => ({ usePathname: () => "/draw" }));
vi.mock("@/lib/runtime-config", () => ({
  get SELECTED_SCOPE() {
    return {
      id: fixture.scopeId,
      chainId: 11155111,
      usdc: "0x1111111111111111111111111111111111111111",
      wrapper: "0x2222222222222222222222222222222222222222",
      pool: "0x3333333333333333333333333333333333333333",
      rpcUrl: "https://rpc.example",
      mode: fixture.scopeId === "candidate-v2" ? "v2" : "legacy1",
      proofServiceUrl: fixture.scopeId === "candidate-v2" ? "https://proof.example" : "",
      proofNamespace: fixture.scopeId === "candidate-v2" ? "candidate" : "",
      onboardingEnabled: false,
    };
  },
}));
vi.mock("@/lib/wallet-context", () => ({
  useWallet: () => ({
    session: fixture.session,
    connect: vi.fn(),
    connecting: false,
    disconnect: vi.fn(),
    error: null,
    passkeyReady: true,
    pimlicoReady: true,
    hasSavedAccount: false,
    principal: 0n,
    confidentialBalancesLoading: false,
    confidentialBalancesError: null,
    confidentialBalance: 0n,
  }),
}));
vi.mock("@/lib/usePoolData", () => ({ useUSDCBalance: () => ({ data: [{ result: 0n }] }) }));
vi.mock("@/lib/scope-navigation", async (original) => {
  const actual = await original<typeof import("@/lib/scope-navigation")>();
  return {
    ...actual,
    isAlternateSavingsOrigin: () => fixture.alternateOrigin,
  };
});

import { Header } from "@/components/Header";
import HomePage from "@/app/page";
import ProfilePage from "@/app/profile/page";

beforeEach(() => {
  fixture.scopeId = "legacy-9c";
  fixture.alternateOrigin = false;
  fixture.session = undefined;
  window.history.replaceState(
    {},
    "",
    "/draw?tab=withdraw&tag=one&tag=two&savings=legacy-e65#current",
  );
});

afterEach(() => vi.clearAllMocks());

test("Header and home render selected-scope hrefs without dropping repeated query values", () => {
  const { unmount } = render(<Header />);
  expect(screen.getByRole("link", { name: "KettigoKettigo" }).getAttribute("href")).toBe(
    "/?tab=withdraw&tag=one&tag=two&savings=legacy-9c",
  );
  expect(screen.getByRole("link", { name: "Save" }).getAttribute("href")).toBe(
    "/savings?tab=withdraw&tag=one&tag=two&savings=legacy-9c",
  );
  expect(screen.getByRole("link", { name: "Results" }).getAttribute("href")).toBe(
    "/draw?tab=withdraw&tag=one&tag=two&savings=legacy-9c",
  );
  expect(screen.queryByRole("link", { name: "Earlier savings" })).toBeNull();
  unmount();

  fixture.session = { address: "0x1111111111111111111111111111111111111111" };
  render(<HomePage />);
  expect(screen.getByRole("link", { name: "Deposit / Withdraw" }).getAttribute("href")).toBe(
    "/savings?tab=withdraw&tag=one&tag=two&savings=legacy-9c",
  );
  expect(screen.getByRole("link", { name: "View results" }).getAttribute("href")).toBe(
    "/draw?tab=withdraw&tag=one&tag=two&savings=legacy-9c",
  );
});

test("Header renders the fixed earlier-savings origin only for the alternate candidate document", async () => {
  fixture.scopeId = "candidate-v2";
  fixture.alternateOrigin = true;
  const { unmount } = render(<Header />);
  expect((await screen.findByRole("link", { name: "Earlier savings" })).getAttribute("href")).toBe(
    "https://kettigo.xyz",
  );
  unmount();
  fixture.alternateOrigin = false;
  render(<Header />);
  await waitFor(() => expect(screen.queryByRole("link", { name: "Earlier savings" })).toBeNull());
});

test("Profile renders no hidden navigation anchors", () => {
  const { rerender } = render(<ProfilePage />);
  expect(screen.queryAllByRole("link")).toHaveLength(0);
  fixture.session = { address: "0x1111111111111111111111111111111111111111" };
  rerender(<ProfilePage />);
  expect(screen.queryAllByRole("link")).toHaveLength(0);
});
