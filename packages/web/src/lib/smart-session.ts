import type { Address, Hex } from "viem";

export type SmartAccountCall = {
  to: Address;
  data: Hex;
  value?: bigint;
};

export type PasskeySmartSession = {
  address: Address;
  signTypedData: (typedData: unknown) => Promise<Hex>;
  sendTransaction: (calls: SmartAccountCall[], options?: SmartTransactionOptions) => Promise<Hex>;
};

export type SmartTransactionOptions = {
  onSigned?: () => void;
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
