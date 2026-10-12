import { getAddress, type Address } from "viem";

export const PASSKEY_METADATA_KEY = "kettigo.passkey.v1";

type PasskeyStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export type PasskeyMetadata = {
  rawId: string;
  coordinates: {
    x: `0x${string}`;
    y: `0x${string}`;
  };
  verifierAddress: Address;
  safeAddress: Address;
};

export type PasskeyMetadataResult =
  | { status: "missing" }
  | { status: "invalid" }
  | { status: "valid"; metadata: PasskeyMetadata };

export function readPasskeyMetadata(storage = getPasskeyStorage()): PasskeyMetadataResult {
  if (!storage) return { status: "missing" };

  let raw: string | null;
  try {
    raw = storage.getItem(PASSKEY_METADATA_KEY);
  } catch {
    return { status: "invalid" };
  }
  if (raw === null) return { status: "missing" };

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || parsed.version !== 1) return { status: "invalid" };
    const metadata = parsePasskeyMetadata(parsed);
    return metadata ? { status: "valid", metadata } : { status: "invalid" };
  } catch {
    return { status: "invalid" };
  }
}

export function writePasskeyMetadata(
  input: PasskeyMetadata | (PasskeyMetadata & Record<string, unknown>),
  storage = getPasskeyStorage(),
): PasskeyMetadata {
  const metadata = parsePasskeyMetadata(input);
  if (!metadata) throw new Error("Invalid passkey metadata.");
  if (!storage) throw new Error("Passkey metadata storage is unavailable.");

  storage.setItem(PASSKEY_METADATA_KEY, JSON.stringify({ version: 1, ...metadata }));
  return metadata;
}

function parsePasskeyMetadata(value: Record<string, unknown>): PasskeyMetadata | null {
  if (
    typeof value.rawId !== "string" ||
    !isCredentialId(value.rawId) ||
    !isRecord(value.coordinates) ||
    !isCoordinate(value.coordinates.x) ||
    !isCoordinate(value.coordinates.y) ||
    typeof value.verifierAddress !== "string" ||
    typeof value.safeAddress !== "string"
  ) {
    return null;
  }

  try {
    return {
      rawId: value.rawId.toLowerCase(),
      coordinates: {
        x: value.coordinates.x.toLowerCase() as `0x${string}`,
        y: value.coordinates.y.toLowerCase() as `0x${string}`,
      },
      verifierAddress: getAddress(value.verifierAddress),
      safeAddress: getAddress(value.safeAddress),
    };
  } catch {
    return null;
  }
}

function isCredentialId(value: string): boolean {
  return value.length > 0 && value.length <= 2048 && value.length % 2 === 0 && /^[a-fA-F0-9]+$/.test(value);
}

function isCoordinate(value: unknown): value is `0x${string}` {
  return typeof value === "string" && /^0x[a-fA-F0-9]{64}$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getPasskeyStorage(): PasskeyStorage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
