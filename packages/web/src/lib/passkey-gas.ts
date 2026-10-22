import { getAddress, type Address, type Hex } from "viem";

// Public test vector, unrelated to any account or credential. A valid signature
// exercises full P256 verification instead of an invalid signature's fast path.
export const PASSKEY_VERIFIER_PROBE_DATA: Hex = "0xd2832f0f754dc136f8058cb53001ba970a472966b3b2c9fc9b301d11431975136c343838b6adb6c766d252167b694d1000b4f944440d39b03467c563da90356007c4a5b0c687c6103e9e05084d00b367be940b33d0a19af75c747afb5d14238851b3e47f5253fb769b5f918e5b580780d23d712841ca13fc1b91f26c5075458799848f0fd5b4373beda93dc4c345133949e6b55460becabdd2ba826bfd1be251";

type ProbeClient = {
  call(input: { to: Address; data: Hex }): Promise<{ data?: Hex }>;
  estimateGas(input: { to: Address; data: Hex }): Promise<bigint>;
};

export function createPasskeyVerifierGasProbe(client: ProbeClient, now = Date.now, timeoutMs = 4_000) {
  // One client is bound to one chain. Coalesce concurrent wallet actions and
  // periodically remeasure; never persist a failed probe as a valid estimate.
  const cache = new Map<Address, { expires: number; gas: Promise<bigint> }>();
  return (verifier: Address): Promise<bigint> => {
    const address = getAddress(verifier);
    const cached = cache.get(address);
    if (cached && cached.expires > now()) return cached.gas;
    const measurement = (async () => {
      const input = { to: address, data: PASSKEY_VERIFIER_PROBE_DATA };
      const result = await client.call(input);
      if (result.data !== `0x${"0".repeat(63)}1`) throw new Error("Passkey verifier probe was not accepted.");
      const estimate = await client.estimateGas(input);
      if (estimate <= 0n) throw new Error("Passkey verifier probe returned no gas estimate.");
      return estimate;
    })();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const gas = Promise.race([
      measurement,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Passkey verifier probe timed out.")), timeoutMs);
      }),
    ]).finally(() => { clearTimeout(timer); });
    const entry = { expires: now() + 300_000, gas };
    cache.set(address, entry);
    void gas.catch(() => { if (cache.get(address) === entry) cache.delete(address); });
    return gas;
  };
}

export type PasskeyGasDiagnostics = {
  phase?: "estimation" | "sponsorship" | "signing" | "submission" | "receipt";
  verifierProbe?: "measured" | "fallback";
  verifierGas?: string;
  bundlerVerificationGas?: string;
  requestedVerificationGas?: string;
  sponsoredVerificationGas?: string;
  submittedVerificationGas?: string;
  submittedCallGas?: string;
  submittedPreVerificationGas?: string;
  submittedMaxFeePerGas?: string;
  submittedMaxPriorityFeePerGas?: string;
  aaCode?: string;
};

export async function withPasskeyStage<T>(
  diagnostics: PasskeyGasDiagnostics,
  phase: NonNullable<PasskeyGasDiagnostics["phase"]>,
  action: () => Promise<T>,
): Promise<T> {
  diagnostics.phase = phase;
  try {
    return await action();
  } catch (cause) {
    // Preserve DOMException cancellation and RPC error subclasses for callers.
    const error = cause instanceof Error && Object.isExtensible(cause)
      ? cause : new Error(cause instanceof Error ? cause.message : String(cause), { cause });
    const aaCode = error.message.match(/\bAA\d{2}\b/)?.[0];
    throw Object.assign(error, { passkeyDiagnostics: { ...diagnostics, ...(aaCode ? { aaCode } : {}) } });
  }
}
