export const PUBLIC_RUNTIME_KEYS = [
  "NEXT_PUBLIC_CHAIN_ID",
  "NEXT_PUBLIC_CONFIDENTIAL_PRIZE_POOL_ADDRESS",
  "NEXT_PUBLIC_CONFIDENTIAL_USDC_ADDRESS",
  "NEXT_PUBLIC_PASSKEY_RP_ID",
  "NEXT_PUBLIC_PASSKEY_RP_NAME",
  "NEXT_PUBLIC_PIMLICO_API_KEY",
  "NEXT_PUBLIC_RPC_URL",
  "NEXT_PUBLIC_USDC_ADDRESS",
] as const;

export type PublicRuntimeEnv = Partial<Record<(typeof PUBLIC_RUNTIME_KEYS)[number], string>>;

export function runtimeConfig(env: PublicRuntimeEnv): Record<string, string> {
  return Object.fromEntries(
    PUBLIC_RUNTIME_KEYS.map((key) => [key, env[key] ?? ""]),
  );
}

export function runtimeConfigScript(env: PublicRuntimeEnv): string {
  const serialized = JSON.stringify(runtimeConfig(env)).replaceAll("<", "\\u003c");
  return `window.__KETTIGO_CONFIG__ = ${serialized};\n`;
}
