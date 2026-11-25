import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { entryPoint07Address } from "viem/account-abstraction";

const Context = createContext(null);
export const useWallet = () => useContext(Context);

// Substitute the local Safe relay for Pimlico. Persist the real signed Safe
// digest and use its mined receipt to exercise the UI's completion callbacks.
const session = {
  address: window.saverConfig.account,
  async prepareTransaction(calls, { signal } = {}) {
    let used = false;
    return {
      cancel() {
        used = true;
      },
      async send(options = {}) {
        signal?.throwIfAborted();
        if (used) throw new Error("This review is no longer active.");
        used = true;
        window.onLocalSafeSignature = async (digest) => {
          await options.onOperationPrepared?.({
            chainId: window.saverConfig.chainId,
            entryPoint: entryPoint07Address,
            sender: session.address,
            userOperationHash: digest,
          });
          options.onSigned?.();
        };
        try {
          return await window.submitLocalSafe(calls);
        } finally {
          delete window.onLocalSafeSignature;
        }
      },
    };
  },
  async lookupUserOperation(operation) {
    const receipt = await window.localReceipt(operation.userOperationHash);
    return receipt
      ? { state: "confirmed", operation, ...receipt }
      : { state: "pending", operation };
  },
};

export function WalletProvider({ children }) {
  const [principal, setPrincipal] = useState();
  const refreshConfidentialBalances = useCallback(async () => {
    setPrincipal(await window.localPrincipal());
  }, []);
  useEffect(() => {
    void refreshConfidentialBalances();
  }, [refreshConfidentialBalances]);
  return (
    <Context.Provider value={{ session, principal, refreshConfidentialBalances }}>
      {children}
    </Context.Provider>
  );
}
