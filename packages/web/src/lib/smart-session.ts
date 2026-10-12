import type { Address, Hex } from "viem";

export type SmartAccountCall = {
  to: Address;
  data: Hex;
  value?: bigint;
};

export type PasskeySmartSession = {
  address: Address;
  signTypedData: (typedData: unknown) => Promise<Hex>;
  sendTransaction: (calls: SmartAccountCall[]) => Promise<Hex>;
};

export async function sendSmartTransaction(
  session: PasskeySmartSession,
  to: Address,
  data: Hex,
): Promise<Hex> {
  return session.sendTransaction([{ to, data }]);
}

export async function sendSmartTransactionBatch(
  session: PasskeySmartSession,
  calls: SmartAccountCall[],
): Promise<Hex> {
  return session.sendTransaction(calls);
}
