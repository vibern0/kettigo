// @vitest-environment-options {"url":"https://kettigo.xyz/draw?tab=withdraw&tag=one&tag=two&savings=candidate-v2"}

import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  session: undefined as { address: `0x${string}` } | undefined,
}));

vi.mock("next/image", () => ({
  default: (props: React.ImgHTMLAttributes<HTMLImageElement>) => <img {...props} />,
}));
vi.mock("next/navigation", () => ({ usePathname: () => "/draw" }));
vi.mock("@/lib/runtime-config", () => ({
  SELECTED_SCOPE: {
    id: "candidate-v2",
    chainId: 11155111,
    usdc: "0x1111111111111111111111111111111111111111",
    wrapper: "0x2222222222222222222222222222222222222222",
    pool: "0x3333333333333333333333333333333333333333",
    rpcUrl: "https://rpc.example",
    mode: "v2",
    proofServiceUrl: "https://proof.example",
    proofNamespace: "candidate",
    onboardingEnabled: false,
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

import { Header } from "@/components/Header";

afterEach(() => vi.clearAllMocks());

test("Header omits earlier savings on the actual canonical candidate origin", async () => {
  expect(window.location.origin).toBe("https://kettigo.xyz");
  render(<Header />);
  await waitFor(() => expect(screen.queryByRole("link", { name: "Earlier savings" })).toBeNull());
});
