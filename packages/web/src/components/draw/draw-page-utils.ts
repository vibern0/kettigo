import { type Address } from "viem";
import { publicConfig } from "@/lib/runtime-config";
import { asChecksumAddress } from "@/lib/zama";

export const asDrawAddress = (value: unknown, label: string): Address =>
  asChecksumAddress(value, label);

export function drawRuntimeConfig() {
  return {
    mode2:
      publicConfig(
        "NEXT_PUBLIC_POOL_VERSION",
        process.env.NEXT_PUBLIC_POOL_VERSION || "legacy1",
      ) === "2",
    proofUrl: publicConfig(
      "NEXT_PUBLIC_PROOF_SERVICE_URL",
      process.env.NEXT_PUBLIC_PROOF_SERVICE_URL,
    ),
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
