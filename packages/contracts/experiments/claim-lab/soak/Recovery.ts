import { Transaction, getAddress } from "ethers";
import { assertResearchRequest, TxBudgetRecord } from "./Policy";
export function recoverSignedRecord(raw: string, senders: string[], allowed: { contracts: string[]; wallets: string[]; maxGasPrice: bigint }):
  TxBudgetRecord & { hash: string; sender: string; nonce: number } {
  const tx = Transaction.from(raw);
  if (!tx.signature || !tx.hash || !tx.from) throw new Error("Orphan transaction is unsigned");
  if (!senders.map(getAddress).includes(tx.from)) throw new Error("Unknown orphan transaction signer");
  if (tx.type !== 0 || tx.gasPrice === null) throw new Error("Only fixed-price legacy research transactions can resume");
  assertResearchRequest({ chainId: tx.chainId, to: tx.to, value: tx.value, gasPrice: tx.gasPrice, gasLimit: tx.gasLimit }, allowed);
  return { hash: tx.hash, sender: tx.from, nonce: tx.nonce, status: "signed", quotedFeeWei: String(tx.gasLimit * tx.gasPrice), valueWei: String(tx.value) };
}
