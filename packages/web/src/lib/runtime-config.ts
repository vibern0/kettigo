import {
  validateSelectedPoolScope,
  type SelectedPoolScope,
} from "../../worker/selected-pool-scope";

type RuntimeConfig = Partial<Record<`NEXT_PUBLIC_${string}`, string>> & {
  selectedPoolScope?: unknown;
};

declare global {
  interface Window {
    __KETTIGO_CONFIG__?: RuntimeConfig;
  }
}

export function publicConfig(name: `NEXT_PUBLIC_${string}`, fallback?: string): string {
  if (typeof window !== "undefined") {
    return window.__KETTIGO_CONFIG__?.[name] ?? fallback ?? "";
  }

  return fallback ?? "";
}

function staticSelectedScope(): SelectedPoolScope | undefined {
  const candidateOnboarding = process.env.NEXT_PUBLIC_CANDIDATE_V2_ONBOARDING_ENABLED;
  const onboardingEnabled =
    candidateOnboarding === "true" ? true : candidateOnboarding === "false" ? false : undefined;
  const candidate = validateSelectedPoolScope({
    id: "candidate-v2",
    chainId: 11155111,
    usdc: process.env.NEXT_PUBLIC_CANDIDATE_V2_USDC_ADDRESS,
    wrapper: process.env.NEXT_PUBLIC_CANDIDATE_V2_CONFIDENTIAL_USDC_ADDRESS,
    pool: process.env.NEXT_PUBLIC_CANDIDATE_V2_CONFIDENTIAL_PRIZE_POOL_ADDRESS,
    rpcUrl: process.env.NEXT_PUBLIC_CANDIDATE_V2_RPC_URL,
    mode: "v2",
    proofServiceUrl: process.env.NEXT_PUBLIC_CANDIDATE_V2_PROOF_SERVICE_URL,
    proofNamespace: process.env.NEXT_PUBLIC_CANDIDATE_V2_PROOF_NAMESPACE,
    onboardingEnabled,
  });
  if (candidate && process.env.NEXT_PUBLIC_POOL_VERSION === "2") return candidate;

  const shared = {
    chainId: 11155111,
    usdc: process.env.NEXT_PUBLIC_USDC_ADDRESS,
    wrapper: process.env.NEXT_PUBLIC_CONFIDENTIAL_USDC_ADDRESS,
    pool: process.env.NEXT_PUBLIC_CONFIDENTIAL_PRIZE_POOL_ADDRESS,
    rpcUrl: process.env.NEXT_PUBLIC_RPC_URL,
    mode: "legacy1",
    proofServiceUrl: "",
    proofNamespace: "",
    onboardingEnabled: false,
  } as const;
  return (
    validateSelectedPoolScope({ id: "legacy-e65", ...shared }) ??
    validateSelectedPoolScope({ id: "legacy-9c", ...shared })
  );
}

/** Reads only a complete Worker-emitted scope; it never mixes in fallback fields. */
export function readSelectedPoolScope(runtimeConfig: unknown): SelectedPoolScope | undefined {
  if (typeof runtimeConfig !== "object" || runtimeConfig === null) return undefined;
  return validateSelectedPoolScope(Reflect.get(runtimeConfig, "selectedPoolScope"));
}

/** The immutable trusted scope for this document, or no available scope. */
export const SELECTED_SCOPE: SelectedPoolScope | undefined =
  typeof window === "undefined"
    ? staticSelectedScope()
    : readSelectedPoolScope(window.__KETTIGO_CONFIG__);
