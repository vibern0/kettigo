"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { decryptConfidentialBalances } from "./confidential-balances";
import { PIMLICO_API_KEY } from "./contracts";
import { readPasskeyMetadata } from "./passkey-metadata";
import { createPasskeyAccount, restorePasskeyAccount } from "./passkey-safe";
import { isPasskeySupported } from "./passkey-webauthn";
import { publicConfig } from "./runtime-config";
import type { PasskeySmartSession } from "./smart-session";
import { getWalletError, type WalletFailureStatus } from "./wallet-errors";

export type WalletStatus =
  | "checking"
  | "no-account"
  | "creating"
  | "awaiting-verification"
  | "ready"
  | WalletFailureStatus;

type WalletState = {
  session: PasskeySmartSession | null;
  status: WalletStatus;
  error: string | null;
  hasSavedAccount: boolean;
};

type WalletContextValue = WalletState & {
  connecting: boolean;
  confidentialBalance: bigint | undefined;
  principal: bigint | undefined;
  confidentialBalancesLoading: boolean;
  confidentialBalancesError: string | null;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  refreshConfidentialBalances: () => Promise<void>;
  passkeyReady: boolean;
  pimlicoReady: boolean;
};

const WalletContext = createContext<WalletContextValue | null>(null);

export function WalletProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<WalletState>({
    session: null,
    status: "checking",
    error: null,
    hasSavedAccount: false,
  });
  const [confidentialBalance, setConfidentialBalance] = useState<bigint | undefined>();
  const [principal, setPrincipal] = useState<bigint | undefined>();
  const [confidentialBalancesLoading, setConfidentialBalancesLoading] = useState(false);
  const [confidentialBalancesError, setConfidentialBalancesError] = useState<string | null>(null);
  const balanceLoadId = useRef(0);

  const loadConfidentialBalances = useCallback(async (currentSession: PasskeySmartSession) => {
    const loadId = balanceLoadId.current + 1;
    balanceLoadId.current = loadId;
    setConfidentialBalancesLoading(true);
    setConfidentialBalancesError(null);
    try {
      const balances = await decryptConfidentialBalances(currentSession);
      if (balanceLoadId.current !== loadId) return;
      setConfidentialBalance(balances.confidentialBalance);
      setPrincipal(balances.principal);
    } catch (error) {
      console.error("Could not load account balances", error);
      if (balanceLoadId.current !== loadId) return;
      setConfidentialBalancesError("Could not load your savings balance.");
    } finally {
      if (balanceLoadId.current === loadId) setConfidentialBalancesLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function restoreSession() {
      if (!isPasskeySupported()) {
        setState({
          session: null,
          status: "unsupported",
          error: "This browser or device cannot open your account.",
          hasSavedAccount: false,
        });
        return;
      }

      const stored = readPasskeyMetadata();
      if (stored.status === "missing") {
        setState({ session: null, status: "no-account", error: null, hasSavedAccount: false });
        return;
      }
      if (stored.status === "invalid") {
        setState({
          session: null,
          status: "invalid-metadata",
          error: "Saved account details cannot be used. Creating another account will give you a different address.",
          hasSavedAccount: true,
        });
        return;
      }
      if (!PIMLICO_API_KEY) {
        setState({
          session: null,
          status: "service-unavailable",
          error: "Account service is unavailable right now. Try again.",
          hasSavedAccount: true,
        });
        return;
      }

      try {
        const session = await restorePasskeyAccount({
          metadata: stored.metadata,
          rpId: passkeyConfig().rpId,
        });
        if (!cancelled) setState({ session, status: "ready", error: null, hasSavedAccount: true });
      } catch (error) {
        console.error("Could not restore passkey account", error);
        if (!cancelled) {
          const failure = getWalletError(error);
          setState({
            session: null,
            status: failure.status,
            error: failure.message,
            hasSavedAccount: true,
          });
        }
      }
    }

    void restoreSession();
    return () => { cancelled = true; };
  }, []);

  const connect = useCallback(async () => {
    if (!isPasskeySupported()) {
      setState((current) => ({
        ...current,
        status: "unsupported",
        error: "This browser or device cannot create your account.",
      }));
      return;
    }
    if (!PIMLICO_API_KEY) {
      setState((current) => ({
        ...current,
        status: "service-unavailable",
        error: "Account service is unavailable right now. Try again.",
      }));
      return;
    }

    const replacingInvalidAccount = state.status === "invalid-metadata";
    const stored = replacingInvalidAccount ? { status: "missing" as const } : readPasskeyMetadata();
    setState((current) => ({ ...current, status: "creating", error: null }));
    try {
      let session: PasskeySmartSession;
      if (stored.status === "valid") {
        session = await restorePasskeyAccount({ metadata: stored.metadata, rpId: passkeyConfig().rpId });
      } else {
        setState((current) => ({ ...current, status: "awaiting-verification", error: null }));
        session = await createPasskeyAccount(passkeyConfig());
      }
      setState({ session, status: "ready", error: null, hasSavedAccount: true });
    } catch (error) {
      console.error("Could not open passkey account", error);
      const failure = getWalletError(error);
      setState((current) => ({
        ...current,
        session: null,
        status: failure.status,
        error: failure.message,
      }));
    }
  }, [state.status]);

  const disconnect = useCallback(async () => {
    balanceLoadId.current += 1;
    setConfidentialBalance(undefined);
    setPrincipal(undefined);
    setConfidentialBalancesError(null);
    setConfidentialBalancesLoading(false);
    setState({ session: null, status: "no-account", error: null, hasSavedAccount: true });
  }, []);

  useEffect(() => {
    if (!state.session) {
      balanceLoadId.current += 1;
      setConfidentialBalance(undefined);
      setPrincipal(undefined);
      setConfidentialBalancesError(null);
      setConfidentialBalancesLoading(false);
      return;
    }
    void loadConfidentialBalances(state.session);
  }, [state.session, loadConfidentialBalances]);

  const refreshConfidentialBalances = useCallback(async () => {
    if (state.session) await loadConfidentialBalances(state.session);
  }, [state.session, loadConfidentialBalances]);

  const connecting = ["checking", "creating", "awaiting-verification"].includes(state.status);
  const passkeyReady = isPasskeySupported();
  const pimlicoReady = Boolean(PIMLICO_API_KEY);
  const value = useMemo<WalletContextValue>(() => ({
    ...state,
    connecting,
    confidentialBalance,
    principal,
    confidentialBalancesLoading,
    confidentialBalancesError,
    connect,
    disconnect,
    refreshConfidentialBalances,
    passkeyReady,
    pimlicoReady,
  }), [
    state,
    connecting,
    confidentialBalance,
    principal,
    confidentialBalancesLoading,
    confidentialBalancesError,
    connect,
    disconnect,
    refreshConfidentialBalances,
    passkeyReady,
    pimlicoReady,
  ]);

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useWallet() {
  const context = useContext(WalletContext);
  if (!context) throw new Error("useWallet must be used inside <WalletProvider>");
  return context;
}

function passkeyConfig() {
  const configuredRpId = publicConfig("NEXT_PUBLIC_PASSKEY_RP_ID", process.env.NEXT_PUBLIC_PASSKEY_RP_ID);
  return {
    rpId: configuredRpId || window.location.hostname,
    rpName: publicConfig("NEXT_PUBLIC_PASSKEY_RP_NAME", process.env.NEXT_PUBLIC_PASSKEY_RP_NAME) || "Kettigo",
  };
}
