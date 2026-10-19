"use client";

import { ReactNode, useEffect, useState } from "react";
import { WagmiProvider } from "wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { wagmiConfig } from "@/lib/wagmi";
import { WalletProvider } from "@/lib/wallet-context";
import { ToastProvider } from "@/components/Toast";
import { ActionCenterProvider } from "@/components/ActionCenter";

const CHUNK_RELOAD_KEY = "kettigo:last-chunk-reload";
const CHUNK_RELOAD_WINDOW_MS = 10_000;

function isChunkLoadError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("ChunkLoadError") ||
    message.includes("Loading chunk") ||
    message.includes("failed to fetch dynamically imported module")
  );
}

function reloadForFreshChunks(error: unknown) {
  if (!isChunkLoadError(error)) return;

  const lastReload = Number(window.sessionStorage.getItem(CHUNK_RELOAD_KEY) ?? 0);
  if (Date.now() - lastReload < CHUNK_RELOAD_WINDOW_MS) return;

  window.sessionStorage.setItem(CHUNK_RELOAD_KEY, String(Date.now()));
  window.location.reload();
}

function ChunkLoadRecovery() {
  useEffect(() => {
    const onError = (event: ErrorEvent) => reloadForFreshChunks(event.error ?? event.message);
    const onUnhandledRejection = (event: PromiseRejectionEvent) => reloadForFreshChunks(event.reason);

    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onUnhandledRejection);

    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onUnhandledRejection);
    };
  }, []);

  return null;
}

// Shared client providers for contracts, cached queries, wallet state, and toasts.
export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { staleTime: 30_000, retry: 1 },
        },
      })
  );

  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <WalletProvider>
          <ToastProvider>
            <ActionCenterProvider>
              <ChunkLoadRecovery />
              {children}
            </ActionCenterProvider>
          </ToastProvider>
        </WalletProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
