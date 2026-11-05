import assert from "node:assert/strict";
import test from "node:test";

import { validateSelectedPoolScope } from "../worker/selected-pool-scope.ts";
import { readSelectedPoolScope } from "../src/lib/runtime-config.ts";

const legacy = {
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
};

test("accepts an emitted complete legacy tuple", () => {
  assert.deepEqual(validateSelectedPoolScope(legacy), legacy);
});

test("rejects partial tuples and mixed legacy roles", () => {
  assert.equal(validateSelectedPoolScope({ ...legacy, rpcUrl: "" }), undefined);
  assert.equal(
    validateSelectedPoolScope({ ...legacy, wrapper: "0x3B4F71c77e288d92871Cda495891Cd42f543A3f5" }),
    undefined,
  );
});

test("rejects candidate tuples with inconsistent roles", () => {
  assert.equal(
    validateSelectedPoolScope({
      ...legacy,
      id: "candidate-v2",
      mode: "v2",
      proofServiceUrl: "https://proof.example",
      proofNamespace: "candidate",
      onboardingEnabled: true,
    }),
    undefined,
  );
});

test("does not fill a partial browser bootstrap from fallback values", () => {
  assert.equal(readSelectedPoolScope({ selectedPoolScope: { ...legacy, rpcUrl: "" } }), undefined);
  assert.equal(readSelectedPoolScope({ NEXT_PUBLIC_RPC_URL: "https://rpc.example" }), undefined);
});
