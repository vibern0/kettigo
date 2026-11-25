import { type Address } from "viem";
import { SELECTED_SCOPE } from "@/lib/runtime-config";
import { asChecksumAddress } from "@/lib/zama";

export const asDrawAddress = (value: unknown, label: string): Address =>
  asChecksumAddress(value, label);

export function isStoredDrawOperation(value: unknown): value is {
  chainId: number;
  entryPoint: string;
  sender: string;
  userOperationHash: string;
} {
  if (typeof value !== "object" || value === null) return false;
  const operation = value as Record<string, unknown>;
  return (
    typeof operation.chainId === "number" &&
    typeof operation.entryPoint === "string" &&
    typeof operation.sender === "string" &&
    typeof operation.userOperationHash === "string"
  );
}

export function drawOperationKey(operation: {
  chainId: number;
  entryPoint: string;
  sender: string;
  userOperationHash: string;
}) {
  return `${operation.chainId}:${operation.entryPoint.toLowerCase()}:${operation.sender.toLowerCase()}:${operation.userOperationHash.toLowerCase()}`;
}

export function drawRuntimeConfig() {
  return {
    mode2: SELECTED_SCOPE?.mode === "v2",
    proofUrl: SELECTED_SCOPE?.proofServiceUrl ?? "",
  };
}

export function drawErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /encrypted|confidential|public|private|mock|testnet|sepolia|prototype|faucet|leakage|decrypted/i.test(
    message,
  )
    ? "Something went wrong. Please try again."
    : message;
}

export function formatDrawDateTime(timestamp: bigint | undefined) {
  if (timestamp === undefined) return "-";
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(Number(timestamp) * 1000),
  );
}

export function formatDrawInterval(seconds: bigint | undefined) {
  if (seconds === undefined) return "-";
  const value = Number(seconds);
  const unit = (amount: number, singular: string, plural: string) =>
    `${amount} ${amount === 1 ? singular : plural}`;
  if (value > 86_400) {
    const days = Math.floor(value / 86_400),
      hours = Math.floor((value % 86_400) / 3_600);
    return hours > 0
      ? `${unit(days, "day", "days")} ${unit(hours, "hour", "hours")}`
      : unit(days, "day", "days");
  }
  if (value > 3_600) {
    const hours = Math.floor(value / 3_600),
      minutes = Math.floor((value % 3_600) / 60);
    return minutes > 0
      ? `${unit(hours, "hour", "hours")} ${unit(minutes, "minute", "minutes")}`
      : unit(hours, "hour", "hours");
  }
  return value > 60
    ? unit(Math.round(value / 60), "minute", "minutes")
    : unit(value, "second", "seconds");
}
