import assert from "node:assert/strict";
import test from "node:test";

import { resolveSelectedPoolScope } from "../worker/selected-pool-scope.ts";

const env = {
  NEXT_PUBLIC_RPC_URL: "https://rpc.example",
  NEXT_PUBLIC_USDC_ADDRESS: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
};

test("defaults to the E65 legacy tuple with its configured wrapper", () => {
  const result = resolveSelectedPoolScope(new URL("https://app.example/savings"), env);

  assert.deepEqual(result, {
    ok: true,
    scope: {
      id: "legacy-e65",
      chainId: 11155111,
      usdc: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
      wrapper: "0x6B26B258436bcCE719Be8F9B30F87FDFD9BdFA8a",
      pool: "0xe65D6459a7Ce01315FbB0998C37233c6FeE3aB8b",
      rpcUrl: "https://rpc.example",
      mode: "legacy1",
      proofServiceUrl: "",
      proofNamespace: "",
      onboardingEnabled: false,
    },
  });
});

test("keeps the 9c legacy pool paired with its own wrapper", () => {
  const result = resolveSelectedPoolScope(
    new URL("https://app.example/savings?savings=legacy-9c"),
    env,
  );

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.scope.pool, "0x9c23E5f7143612dc1232FC643A57300291e0d719");
  assert.equal(result.scope.wrapper, "0x3B4F71c77e288d92871Cda495891Cd42f543A3f5");
  assert.equal(result.scope.mode, "legacy1");
  assert.equal(result.scope.proofServiceUrl, "");
});

test("rejects malformed, duplicate, unknown, and incomplete-candidate selectors", () => {
  for (const query of [
    "?savings=",
    "?savings=unknown",
    "?savings=legacy-e65&savings=legacy-9c",
    "?savings=candidate-v2",
  ]) {
    const result = resolveSelectedPoolScope(new URL(`https://app.example/savings${query}`), env);
    assert.equal(result.ok, false, query);
    if (!result.ok) assert.equal(result.status, 400);
  }
});

test("does not accept tuple fields from the selector URL", () => {
  const result = resolveSelectedPoolScope(
    new URL(
      "https://app.example/savings?savings=legacy-e65&pool=0x0000000000000000000000000000000000000001&rpcUrl=https://attacker.example&proofNamespace=attacker&onboardingEnabled=true",
    ),
    env,
  );

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.scope.pool, "0xe65D6459a7Ce01315FbB0998C37233c6FeE3aB8b");
  assert.equal(result.scope.rpcUrl, "https://rpc.example");
  assert.equal(result.scope.onboardingEnabled, false);
});

test("keeps candidate unavailable when it reuses a retained legacy role", () => {
  const result = resolveSelectedPoolScope(
    new URL("https://app.example/savings?savings=candidate-v2"),
    {
      ...env,
      NEXT_PUBLIC_CANDIDATE_V2_RPC_URL: "https://candidate-rpc.example",
      NEXT_PUBLIC_CANDIDATE_V2_USDC_ADDRESS: "0x1111111111111111111111111111111111111111",
      NEXT_PUBLIC_CANDIDATE_V2_CONFIDENTIAL_USDC_ADDRESS:
        "0x6B26B258436bcCE719Be8F9B30F87FDFD9BdFA8a",
      NEXT_PUBLIC_CANDIDATE_V2_CONFIDENTIAL_PRIZE_POOL_ADDRESS:
        "0x3333333333333333333333333333333333333333",
      NEXT_PUBLIC_CANDIDATE_V2_PROOF_SERVICE_URL: "https://proof.example",
      NEXT_PUBLIC_CANDIDATE_V2_PROOF_NAMESPACE: "candidate",
      NEXT_PUBLIC_CANDIDATE_V2_ONBOARDING_ENABLED: "true",
    },
  );

  assert.deepEqual(result, { ok: false, status: 400, code: "unavailable_savings_scope" });
});
