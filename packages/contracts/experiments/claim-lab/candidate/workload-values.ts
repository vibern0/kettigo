import { getAddress, type Address, type Hex } from "viem";

export type Reference = Record<string, unknown>;

export const UINT64_MAX = (1n << 64n) - 1n;

export const h32 = (value: unknown, label: string): Hex => {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value))
    throw new Error(`workload data: invalid ${label}`);
  return value.toLowerCase() as Hex;
};

export const bytes = (value: unknown, label: string): Hex => {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]*$/.test(value) || value.length % 2)
    throw new Error(`workload data: invalid ${label}`);
  return value.toLowerCase() as Hex;
};

export const addr = (value: unknown, label: string): Address => {
  try {
    return getAddress(value as Address);
  } catch {
    throw new Error(`workload data: invalid ${label}`);
  }
};

export const decimal = (value: unknown, label: string, maximum = (1n << 256n) - 1n): string => {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value))
    throw new Error(`workload data: invalid ${label}`);
  if (BigInt(value) > maximum) throw new Error(`workload data: invalid ${label}`);
  return value;
};

export const refs = (value: unknown, found: Reference[] = []): Reference[] => {
  if (Array.isArray(value)) value.forEach((entry) => refs(entry, found));
  else if (value && typeof value === "object") {
    const record = value as Reference;
    if (typeof record.kind === "string") found.push(record);
    else Object.values(record).forEach((entry) => refs(entry, found));
  }
  return found;
};

export const scope = (
  workloadFingerprint: string,
  actionId: string,
  reference: Reference,
  contract: Address | null,
  extra: Record<string, unknown> = {},
) =>
  Object.freeze({
    ...extra,
    actionId,
    workloadFingerprint: h32(workloadFingerprint, "workload fingerprint"),
    reference,
    contract,
  });
