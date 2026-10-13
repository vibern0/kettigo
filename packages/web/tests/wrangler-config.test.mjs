import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const webWrangler = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
const webConfig = JSON.parse(webWrangler);
const publicRuntimeVars = [
  ["NEXT_PUBLIC_CHAIN_ID", "11155111"],
  ["NEXT_PUBLIC_RPC_URL", "https://ethereum-sepolia-rpc.publicnode.com"],
  ["NEXT_PUBLIC_CONFIDENTIAL_PRIZE_POOL_ADDRESS", "0xe65D6459a7Ce01315FbB0998C37233c6FeE3aB8b"],
  ["NEXT_PUBLIC_CONFIDENTIAL_USDC_ADDRESS", "0x6B26B258436bcCE719Be8F9B30F87FDFD9BdFA8a"],
  ["NEXT_PUBLIC_PASSKEY_RP_NAME", "Kettigo"],
  ["NEXT_PUBLIC_USDC_ADDRESS", "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238"],
];
const expectedD1Binding = {
  binding: "DB",
  database_name: "kettigo",
  database_id: "d6cfede8-60bb-45dc-b342-60e6da48f1e4",
  migrations_dir: "../landing/migrations",
};

test("web Worker config binds the shared waitlist D1 database", () => {
  assert.deepEqual(webConfig.d1_databases, [expectedD1Binding]);
  assert.deepEqual(webConfig.previews.d1_databases, [expectedD1Binding]);
  assert.deepEqual(webConfig.assets.run_worker_first, [
    "/",
    "/draw",
    "/draw/",
    "/profile",
    "/profile/",
    "/savings",
    "/savings/",
  ]);
});

test("web Worker config preserves public runtime variables across deploys", () => {
  assert.match(webWrangler, /"vars"\s*:/);
  assert.match(webWrangler, /"previews"\s*:/);
  for (const [name, value] of publicRuntimeVars) {
    const assignment = `"${name}": "${value}"`;
    assert.equal(webWrangler.split(assignment).length, 3, `${name} should be set for production and previews`);
  }
});

test("Worker previews use their workers.dev account domain as the passkey relying party", () => {
  assert.equal(webConfig.vars.NEXT_PUBLIC_PASSKEY_RP_ID, "kettigo.xyz");
  assert.equal(webConfig.previews.vars.NEXT_PUBLIC_PASSKEY_RP_ID, "blvieira5.workers.dev");
});

test("web Worker leaves keeper scheduling to the external runner", () => {
  assert.deepEqual(webConfig.triggers?.crons, []);
  assert.equal(webWrangler.split('"DRAW_KEEPER_MINIMUM_PRIZE": "1000000"').length, 3);
  assert.equal(webWrangler.split('"MORPHO_KEEPER_START_BLOCK": "11864127"').length, 3);
});
