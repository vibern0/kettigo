import type { SelectedPoolScope } from "./selected-pool-scope";

export const PUBLIC_RUNTIME_KEYS = [
  "NEXT_PUBLIC_CHAIN_ID",
  "NEXT_PUBLIC_CONFIDENTIAL_PRIZE_POOL_ADDRESS",
  "NEXT_PUBLIC_CONFIDENTIAL_USDC_ADDRESS",
  "NEXT_PUBLIC_PASSKEY_RP_ID",
  "NEXT_PUBLIC_PASSKEY_RP_NAME",
  "NEXT_PUBLIC_PIMLICO_API_KEY",
  "NEXT_PUBLIC_POOL_VERSION",
  "NEXT_PUBLIC_PROOF_SERVICE_URL",
  "NEXT_PUBLIC_RPC_URL",
  "NEXT_PUBLIC_USDC_ADDRESS",
  "NEXT_PUBLIC_CANDIDATE_V2_RPC_URL",
  "NEXT_PUBLIC_CANDIDATE_V2_USDC_ADDRESS",
  "NEXT_PUBLIC_CANDIDATE_V2_CONFIDENTIAL_USDC_ADDRESS",
  "NEXT_PUBLIC_CANDIDATE_V2_CONFIDENTIAL_PRIZE_POOL_ADDRESS",
  "NEXT_PUBLIC_CANDIDATE_V2_PROOF_SERVICE_URL",
  "NEXT_PUBLIC_CANDIDATE_V2_PROOF_NAMESPACE",
  "NEXT_PUBLIC_CANDIDATE_V2_ONBOARDING_ENABLED",
] as const;

export type PublicRuntimeEnv = KettigoPublicRuntimeEnv;

export function runtimeConfig(
  env: PublicRuntimeEnv,
  selectedPoolScope: SelectedPoolScope,
): Record<string, string | SelectedPoolScope> {
  return {
    NEXT_PUBLIC_PASSKEY_RP_ID: env.NEXT_PUBLIC_PASSKEY_RP_ID ?? "",
    NEXT_PUBLIC_PASSKEY_RP_NAME: env.NEXT_PUBLIC_PASSKEY_RP_NAME ?? "",
    NEXT_PUBLIC_PIMLICO_API_KEY: env.NEXT_PUBLIC_PIMLICO_API_KEY ?? "",
    NEXT_PUBLIC_CHAIN_ID: String(selectedPoolScope.chainId),
    NEXT_PUBLIC_CONFIDENTIAL_PRIZE_POOL_ADDRESS: selectedPoolScope.pool,
    NEXT_PUBLIC_CONFIDENTIAL_USDC_ADDRESS: selectedPoolScope.wrapper,
    NEXT_PUBLIC_POOL_VERSION: selectedPoolScope.mode === "v2" ? "2" : "legacy1",
    NEXT_PUBLIC_PROOF_SERVICE_URL: selectedPoolScope.proofServiceUrl,
    NEXT_PUBLIC_RPC_URL: selectedPoolScope.rpcUrl,
    NEXT_PUBLIC_USDC_ADDRESS: selectedPoolScope.usdc,
    selectedPoolScope,
  };
}

export function runtimeConfigScript(
  env: PublicRuntimeEnv,
  selectedPoolScope: SelectedPoolScope,
): string {
  const serialized = JSON.stringify(runtimeConfig(env, selectedPoolScope)).replaceAll(
    "<",
    "\\u003c",
  );
  return `window.__KETTIGO_CONFIG__ = ${serialized};\n`;
}
