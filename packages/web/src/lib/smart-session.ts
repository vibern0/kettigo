import type { Address, Hex } from "viem";
import type {
  SafeUserOperationIdentity,
  SafeUserOperationReceipt,
} from "./canonical-user-operation-receipt.ts";

export type {
  SafeUserOperationIdentity,
  SafeUserOperationReceipt,
} from "./canonical-user-operation-receipt.ts";

export type SmartAccountCall = {
  to: Address;
  data: Hex;
  value?: bigint;
};

export type PasskeySmartSession = {
  address: Address;
  signTypedData: (typedData: unknown) => Promise<Hex>;
  prepareTransaction: (
    calls: SmartAccountCall[],
    options?: PrepareSmartTransactionOptions,
  ) => Promise<PreparedSmartTransaction>;
  sendTransaction: (calls: SmartAccountCall[], options?: SmartTransactionOptions) => Promise<Hex>;
  lookupUserOperation?: (operation: SafeUserOperationIdentity) => Promise<SafeUserOperationReceipt>;
  getPendingOperation?: () => PendingOperationRecord | null;
  recoverPendingOperation?: () => Promise<PendingOperationRecoveryResult>;
};

export type PrepareSmartTransactionOptions = { signal?: AbortSignal };

export type PendingOperationRecord = Readonly<{
  chainId: 11155111;
  entryPoint: Address;
  sender: Address;
  userOperationHash: Hex;
  createdAt: number;
  phase: "prepared" | "attempted";
}>;

export type PendingOperationRecoveryResult =
  | Readonly<{ state: "none" }>
  | Readonly<{ state: "not-submitted"; operation: SafeUserOperationIdentity }>
  | SafeUserOperationReceipt;

export type SmartTransactionOptions = {
  onSigned?: () => void;
  onOperationPrepared?: (operation: SafeUserOperationIdentity) => void | Promise<void>;
};

export async function sendSmartTransaction(
  session: PasskeySmartSession,
  to: Address,
  data: Hex,
  options?: SmartTransactionOptions,
): Promise<Hex> {
  return session.sendTransaction([{ to, data }], options);
}

export async function sendSmartTransactionBatch(
  session: PasskeySmartSession,
  calls: SmartAccountCall[],
  options?: SmartTransactionOptions,
): Promise<Hex> {
  return session.sendTransaction(calls, options);
}

export type PreparedSmartTransaction = {
  cancel: () => void;
  send: (options?: SmartTransactionOptions) => Promise<Hex>;
};
