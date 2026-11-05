/// <reference types="@cloudflare/workers-types" />

declare global {
  interface KettigoPublicRuntimeEnv {
    readonly NEXT_PUBLIC_CHAIN_ID?: string;
    readonly NEXT_PUBLIC_CONFIDENTIAL_PRIZE_POOL_ADDRESS?: string;
    readonly NEXT_PUBLIC_CONFIDENTIAL_USDC_ADDRESS?: string;
    readonly NEXT_PUBLIC_PASSKEY_RP_ID?: string;
    readonly NEXT_PUBLIC_PASSKEY_RP_NAME?: string;
    readonly NEXT_PUBLIC_PIMLICO_API_KEY?: string;
    readonly NEXT_PUBLIC_POOL_VERSION?: string;
    readonly NEXT_PUBLIC_PROOF_SERVICE_URL?: string;
    readonly NEXT_PUBLIC_RPC_URL?: string;
    readonly NEXT_PUBLIC_USDC_ADDRESS?: string;
    readonly NEXT_PUBLIC_CANDIDATE_V2_RPC_URL?: string;
    readonly NEXT_PUBLIC_CANDIDATE_V2_USDC_ADDRESS?: string;
    readonly NEXT_PUBLIC_CANDIDATE_V2_CONFIDENTIAL_USDC_ADDRESS?: string;
    readonly NEXT_PUBLIC_CANDIDATE_V2_CONFIDENTIAL_PRIZE_POOL_ADDRESS?: string;
    readonly NEXT_PUBLIC_CANDIDATE_V2_PROOF_SERVICE_URL?: string;
    readonly NEXT_PUBLIC_CANDIDATE_V2_PROOF_NAMESPACE?: string;
    readonly NEXT_PUBLIC_CANDIDATE_V2_ONBOARDING_ENABLED?: string;
  }
}

export {};
