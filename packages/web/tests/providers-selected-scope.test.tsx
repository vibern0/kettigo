import { act } from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const fixture = vi.hoisted(() => ({ scope: undefined as object | undefined, walletMounts: 0 }));

vi.mock("@/lib/runtime-config", () => ({
  get SELECTED_SCOPE() {
    return fixture.scope;
  },
}));
vi.mock("@/lib/wagmi", () => ({ wagmiConfig: {} }));
vi.mock("wagmi", () => ({
  WagmiProvider: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("@tanstack/react-query", () => ({
  QueryClient: class QueryClient {},
  QueryClientProvider: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("@/lib/wallet-context", () => ({
  WalletProvider: ({ children }: { children: React.ReactNode }) => {
    fixture.walletMounts += 1;
    return children;
  },
}));
vi.mock("@/components/Toast", () => ({
  ToastProvider: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("@/components/ActionCenter", () => ({
  ActionCenterProvider: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("motion/react", () => ({
  LazyMotion: ({ children }: { children: React.ReactNode }) => children,
  MotionConfig: ({ children }: { children: React.ReactNode }) => children,
  domMax: {},
}));

import { Providers } from "@/app/providers";

beforeEach(() => {
  fixture.scope = undefined;
  fixture.walletMounts = 0;
});

afterEach(() => vi.restoreAllMocks());

test("keeps server and first hydration neutral before valid scope providers mount", async () => {
  fixture.scope = { id: "legacy-e65" };
  const html = renderToString(
    <Providers>
      <span>Financial child</span>
    </Providers>,
  );
  expect(html).toContain("Loading savings");
  expect(html).not.toContain("Financial child");
  expect(fixture.walletMounts).toBe(0);

  const container = document.createElement("div");
  container.innerHTML = html;
  const recoverable = vi.fn();
  await act(async () => {
    hydrateRoot(
      container,
      <Providers>
        <span>Financial child</span>
      </Providers>,
      { onRecoverableError: recoverable },
    );
  });
  expect(recoverable).not.toHaveBeenCalled();
  expect(container.textContent).toContain("Financial child");
  expect(fixture.walletMounts).toBeGreaterThan(0);
});

test("keeps unavailable scope nonfinancial after hydration", async () => {
  const container = document.createElement("div");
  container.innerHTML = renderToString(
    <Providers>
      <span>Financial child</span>
    </Providers>,
  );
  await act(async () => {
    hydrateRoot(
      container,
      <Providers>
        <span>Financial child</span>
      </Providers>,
    );
  });
  expect(container.textContent).toContain("Savings are unavailable");
  expect(container.textContent).not.toContain("Financial child");
  expect(fixture.walletMounts).toBe(0);
});
