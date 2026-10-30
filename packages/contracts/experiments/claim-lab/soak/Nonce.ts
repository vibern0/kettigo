import { getAddress } from "ethers";
export function nextResearchNonce(records: readonly {sender: string; nonce: number}[], sender: string, rpcNonce: number): number {
  if (!Number.isSafeInteger(rpcNonce) || rpcNonce < 0) throw new Error("Invalid RPC nonce");
  const owner = getAddress(sender);
  let next = rpcNonce;
  for (const item of records) if (getAddress(item.sender) === owner) {
    if (!Number.isSafeInteger(item.nonce) || item.nonce < 0 || item.nonce >= Number.MAX_SAFE_INTEGER) throw new Error("Invalid saved nonce");
    next = Math.max(next, item.nonce + 1);
  }
  return next;
}
