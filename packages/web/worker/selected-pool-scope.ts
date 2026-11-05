import { getAddress, type Address } from "viem";

export type PoolScopeId = "legacy-e65" | "legacy-9c" | "candidate-v2";
export type PoolMode = "legacy1" | "v2";

export type SelectedPoolScope = Readonly<{
  id: PoolScopeId;
  chainId: 11155111;
  usdc: Address;
  wrapper: Address;
  pool: Address;
  rpcUrl: string;
  mode: PoolMode;
  proofServiceUrl: string;
  proofNamespace: string;
  onboardingEnabled: boolean;
}>;

export type ScopeSelection =
  | Readonly<{ ok: true; scope: SelectedPoolScope }>
  | Readonly<{
      ok: false;
      status: 400;
      code: "invalid_savings_scope" | "unavailable_savings_scope";
    }>;

type ScopeInput = Readonly<Record<string, unknown>>;

type ScopeEnv = Pick<
  KettigoPublicRuntimeEnv,
  | "NEXT_PUBLIC_RPC_URL"
  | "NEXT_PUBLIC_USDC_ADDRESS"
  | "NEXT_PUBLIC_CANDIDATE_V2_RPC_URL"
  | "NEXT_PUBLIC_CANDIDATE_V2_USDC_ADDRESS"
  | "NEXT_PUBLIC_CANDIDATE_V2_CONFIDENTIAL_USDC_ADDRESS"
  | "NEXT_PUBLIC_CANDIDATE_V2_CONFIDENTIAL_PRIZE_POOL_ADDRESS"
  | "NEXT_PUBLIC_CANDIDATE_V2_PROOF_SERVICE_URL"
  | "NEXT_PUBLIC_CANDIDATE_V2_PROOF_NAMESPACE"
  | "NEXT_PUBLIC_CANDIDATE_V2_ONBOARDING_ENABLED"
>;

const LEGACY_SCOPES = {
  "legacy-e65": {
    pool: "0xe65D6459a7Ce01315FbB0998C37233c6FeE3aB8b",
    wrapper: "0x6B26B258436bcCE719Be8F9B30F87FDFD9BdFA8a",
  },
  "legacy-9c": {
    pool: "0x9c23E5f7143612dc1232FC643A57300291e0d719",
    wrapper: "0x3B4F71c77e288d92871Cda495891Cd42f543A3f5",
  },
} as const;

export function resolveSelectedPoolScope(url: URL, env: ScopeEnv): ScopeSelection {
  const requested = selectScopeId(url);
  if (!requested.ok) return requested;

  const scope =
    requested.id === "candidate-v2" ? candidateScope(env) : legacyScope(requested.id, env);
  return scope
    ? { ok: true, scope }
    : { ok: false, status: 400, code: "unavailable_savings_scope" };
}

function selectScopeId(
  url: URL,
):
  | Readonly<{ ok: true; id: PoolScopeId }>
  | Readonly<{ ok: false; status: 400; code: "invalid_savings_scope" }> {
  const values = url.searchParams.getAll("savings");
  if (values.length === 0) return { ok: true, id: "legacy-e65" };
  if (values.length !== 1 || !isPoolScopeId(values[0])) {
    return { ok: false, status: 400, code: "invalid_savings_scope" };
  }
  return { ok: true, id: values[0] };
}

function legacyScope(id: "legacy-e65" | "legacy-9c", env: ScopeEnv): SelectedPoolScope | undefined {
  const legacy = id === "legacy-e65" ? LEGACY_SCOPES["legacy-e65"] : LEGACY_SCOPES["legacy-9c"];
  return buildScope({
    id,
    usdc: env.NEXT_PUBLIC_USDC_ADDRESS,
    wrapper: legacy.wrapper,
    pool: legacy.pool,
    rpcUrl: env.NEXT_PUBLIC_RPC_URL,
    mode: "legacy1",
    proofServiceUrl: "",
    proofNamespace: "",
    onboardingEnabled: false,
  });
}

function candidateScope(env: ScopeEnv): SelectedPoolScope | undefined {
  const onboardingEnabled = parseBoolean(env.NEXT_PUBLIC_CANDIDATE_V2_ONBOARDING_ENABLED);
  if (onboardingEnabled === undefined) return undefined;
  return buildScope({
    id: "candidate-v2",
    usdc: env.NEXT_PUBLIC_CANDIDATE_V2_USDC_ADDRESS,
    wrapper: env.NEXT_PUBLIC_CANDIDATE_V2_CONFIDENTIAL_USDC_ADDRESS,
    pool: env.NEXT_PUBLIC_CANDIDATE_V2_CONFIDENTIAL_PRIZE_POOL_ADDRESS,
    rpcUrl: env.NEXT_PUBLIC_CANDIDATE_V2_RPC_URL,
    mode: "v2",
    proofServiceUrl: env.NEXT_PUBLIC_CANDIDATE_V2_PROOF_SERVICE_URL,
    proofNamespace: env.NEXT_PUBLIC_CANDIDATE_V2_PROOF_NAMESPACE,
    onboardingEnabled,
  });
}

function buildScope(value: {
  id: PoolScopeId;
  usdc: string | undefined;
  wrapper: string | undefined;
  pool: string | undefined;
  rpcUrl: string | undefined;
  mode: PoolMode;
  proofServiceUrl: string | undefined;
  proofNamespace: string | undefined;
  onboardingEnabled: boolean;
}): SelectedPoolScope | undefined {
  const usdc = checksumAddress(value.usdc);
  const wrapper = checksumAddress(value.wrapper);
  const pool = checksumAddress(value.pool);
  const rpcUrl = trustedUrl(value.rpcUrl);
  if (!usdc || !wrapper || !pool || !rpcUrl || !hasDistinctRoles(usdc, wrapper, pool))
    return undefined;
  if (value.mode === "v2") {
    const proofServiceUrl = trustedUrl(value.proofServiceUrl);
    const proofNamespace = nonEmpty(value.proofNamespace);
    if (!proofServiceUrl || !proofNamespace) return undefined;
    return Object.freeze({
      id: value.id,
      chainId: 11155111,
      usdc,
      wrapper,
      pool,
      rpcUrl,
      mode: value.mode,
      proofServiceUrl,
      proofNamespace,
      onboardingEnabled: value.onboardingEnabled,
    });
  }
  return Object.freeze({
    id: value.id,
    chainId: 11155111,
    usdc,
    wrapper,
    pool,
    rpcUrl,
    mode: value.mode,
    proofServiceUrl: "",
    proofNamespace: "",
    onboardingEnabled: false,
  });
}

/**
 * Validates a complete tuple emitted by the Worker before a browser uses it.
 * This deliberately accepts no partial configuration: a document has one
 * immutable scope or no available financial surface at all.
 */
export function validateSelectedPoolScope(value: unknown): SelectedPoolScope | undefined {
  if (!isScopeInput(value)) return undefined;
  const id = stringValue(value.id);
  if (value.chainId !== 11155111 || !id || !isPoolScopeId(id) || !isPoolMode(value.mode)) {
    return undefined;
  }
  if (typeof value.onboardingEnabled !== "boolean") return undefined;
  const scope = buildScope({
    id,
    usdc: stringValue(value.usdc),
    wrapper: stringValue(value.wrapper),
    pool: stringValue(value.pool),
    rpcUrl: stringValue(value.rpcUrl),
    mode: value.mode,
    proofServiceUrl: stringValue(value.proofServiceUrl),
    proofNamespace: stringValue(value.proofNamespace),
    onboardingEnabled: value.onboardingEnabled,
  });
  return scope && hasExpectedScopeRoles(scope) ? scope : undefined;
}

function hasExpectedScopeRoles(scope: SelectedPoolScope): boolean {
  if (scope.id === "candidate-v2") {
    return (
      scope.mode === "v2" &&
      !Object.values(LEGACY_SCOPES).some(
        (legacy) => scope.wrapper === legacy.wrapper && scope.pool === legacy.pool,
      )
    );
  }
  const expected = LEGACY_SCOPES[scope.id];
  return (
    scope.mode === "legacy1" &&
    scope.wrapper === expected.wrapper &&
    scope.pool === expected.pool &&
    scope.proofServiceUrl === "" &&
    scope.proofNamespace === "" &&
    !scope.onboardingEnabled
  );
}

function hasDistinctRoles(...addresses: Address[]): boolean {
  const zero = "0x0000000000000000000000000000000000000000";
  return (
    addresses.every((address) => address.toLowerCase() !== zero) &&
    new Set(addresses.map((address) => address.toLowerCase())).size === addresses.length
  );
}

function isScopeInput(value: unknown): value is ScopeInput {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function checksumAddress(value: string | undefined): Address | undefined {
  if (!value) return undefined;
  try {
    return getAddress(value);
  } catch {
    return undefined;
  }
}

function trustedUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? value : undefined;
  } catch {
    return undefined;
  }
}

function nonEmpty(value: string | undefined): string | undefined {
  return value?.trim() || undefined;
}

function parseBoolean(value: string | undefined): boolean | undefined {
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

function isPoolScopeId(value: string): value is PoolScopeId {
  return value === "legacy-e65" || value === "legacy-9c" || value === "candidate-v2";
}

function isPoolMode(value: unknown): value is PoolMode {
  return value === "legacy1" || value === "v2";
}
