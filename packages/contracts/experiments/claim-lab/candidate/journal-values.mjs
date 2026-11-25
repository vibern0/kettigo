import { createHash } from "node:crypto";

export function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function canonical(value) {
  return JSON.stringify(value, (_, entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entry;
    return Object.fromEntries(
      Object.keys(entry)
        .sort()
        .map((key) => [key, entry[key]]),
    );
  });
}

export function envelopeIdentity(envelope) {
  return createHash("sha256").update(canonical(envelope)).digest("hex");
}

export function decimalMicro(value, fail) {
  if (
    typeof value !== "string" ||
    value.length > 80 ||
    !/^(0|[1-9][0-9]*)(?:\.[0-9]{1,6})?$/.test(value)
  )
    fail("invalid USDC commitment");
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole) * 1_000_000n + BigInt(`${fraction}000000`.slice(0, 6));
}
