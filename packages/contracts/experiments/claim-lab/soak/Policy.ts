export interface TxBudgetRecord {
  status: "signed" | "pending" | "confirmed" | "reverted";
  quotedFeeWei: string;
  valueWei: string;
  feeWei?: string;
}

export function assertBudget(records: readonly TxBudgetRecord[], next: { feeWei: bigint; valueWei: bigint },
  limits: { feeWei: bigint; fundingWei: bigint; maxTransactions: number }): void {
  if (!Array.isArray(records)) throw new Error("Invalid transaction records");
  if (!Number.isSafeInteger(limits.maxTransactions) || limits.maxTransactions < 0) {
    throw new Error("Invalid maximum transaction count");
  }
  const feeLimit = nonnegative(limits.feeWei, "fee limit wei");
  const fundingLimit = nonnegative(limits.fundingWei, "funding limit wei");
  let fees = nonnegative(next.feeWei, "next fee wei");
  let funding = nonnegative(next.valueWei, "next value wei");
  for (const record of records) {
    if (!record || !["signed", "pending", "confirmed", "reverted"].includes(record.status)) {
      throw new Error("Invalid transaction status");
    }
    const quoted = monetaryRecord(record.quotedFeeWei, "quoted fee wei");
    funding += monetaryRecord(record.valueWei, "value wei");
    const actual = record.feeWei === undefined ? undefined : monetaryRecord(record.feeWei, "actual fee wei");
    if (record.status === "confirmed" || record.status === "reverted") {
      if (actual === undefined) throw new Error("Missing actual fee wei for terminal transaction");
      fees += actual;
    } else fees += quoted;
  }
  if (records.length + 1 > limits.maxTransactions) throw new Error("Transaction budget exceeded");
  if (fees > feeLimit) throw new Error("Fee budget exceeded");
  // Even reverted transfers stay reserved: receipt fee accounting must never
  // accidentally release a value allocation for a subsequent transaction.
  if (funding > fundingLimit) throw new Error("Funding budget exceeded");
}

export function assertResearchRequest(request: { chainId: bigint; to?: string | null; value: bigint; gasPrice: bigint; gasLimit: bigint },
  allowed: { contracts: string[]; wallets: string[]; maxGasPrice: bigint }): void {
  if (request.chainId !== 11155111n) throw new Error("Research requests require Sepolia chain 11155111");
  if (!request.to) throw new Error("Missing recipient: contract creation is forbidden");
  const value = nonnegative(request.value, "request value");
  const gasPrice = nonnegative(request.gasPrice, "gas price");
  const gasLimit = nonnegative(request.gasLimit, "gas limit");
  const ceiling = nonnegative(allowed.maxGasPrice, "maximum gas price");
  if (gasPrice === 0n || gasLimit === 0n || gasPrice > ceiling) throw new Error("Gas parameters exceed research policy");
  const recipient = normalizedAddress(request.to);
  const contracts = new Set(allowed.contracts.map(normalizedAddress));
  const wallets = new Set(allowed.wallets.map(normalizedAddress));
  if (value > 0n) {
    if (!wallets.has(recipient) || contracts.has(recipient)) throw new Error("Value transfers require a known wallet recipient");
  } else if (!contracts.has(recipient) && !wallets.has(recipient)) throw new Error("Unknown research recipient");
}
import { getAddress } from "ethers";


function nonnegative(value: bigint, label: string): bigint {
  if (typeof value !== "bigint" || value < 0n) throw new Error(`Invalid ${label}`);
  return value;
}

function monetaryRecord(value: string, label: string): bigint {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) throw new Error(`Invalid ${label}`);
  return BigInt(value);
}

function normalizedAddress(value: string): string {
  try { return getAddress(value); }
  catch { throw new Error("Invalid research address"); }
}
