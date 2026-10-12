import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const webWrangler = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
const rootWrangler = readFileSync(new URL("../../../wrangler.toml", import.meta.url), "utf8");
const rootWorker = readFileSync(new URL("../worker.ts", import.meta.url), "utf8");
const webConfig = JSON.parse(webWrangler);
const publicRuntimeVars = [
  ["NEXT_PUBLIC_CHAIN_ID", "11155111"],
  ["NEXT_PUBLIC_RPC_URL", "https://ethereum-sepolia-rpc.publicnode.com"],
  ["NEXT_PUBLIC_CONFIDENTIAL_PRIZE_POOL_ADDRESS", "0xe65D6459a7Ce01315FbB0998C37233c6FeE3aB8b"],
  ["NEXT_PUBLIC_CONFIDENTIAL_USDC_ADDRESS", "0x6B26B258436bcCE719Be8F9B30F87FDFD9BdFA8a"],
  ["NEXT_PUBLIC_PASSKEY_RP_NAME", "Kettigo"],
  ["NEXT_PUBLIC_USDC_ADDRESS", "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238"],
];

test("web Worker config binds the shared waitlist D1 database", () => {
  assert.match(webWrangler, /"d1_databases"\s*:/);
  assert.match(webWrangler, /"binding": "DB"/);
  assert.match(webWrangler, /"database_name": "kettigo"/);
  assert.match(webWrangler, /"database_id": "d6cfede8-60bb-45dc-b342-60e6da48f1e4"/);
  assert.match(webWrangler, /"migrations_dir": "\.\.\/landing\/migrations"/);
  assert.match(webWrangler, /"previews"\s*:/);
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

test("root app Worker config binds the shared waitlist D1 database", () => {
  assert.match(rootWrangler, /\[\[d1_databases\]\]/);
  assert.match(rootWrangler, /binding = "DB"/);
  assert.match(rootWrangler, /database_name = "kettigo"/);
  assert.match(rootWrangler, /database_id = "d6cfede8-60bb-45dc-b342-60e6da48f1e4"/);
  assert.match(rootWrangler, /migrations_dir = "packages\/landing\/migrations"/);
  assert.match(rootWrangler, /\[\[previews\.d1_databases\]\]/);
  assert.match(rootWrangler, /run_worker_first = \["\/", "\/draw", "\/draw\/", "\/profile", "\/profile\/", "\/savings", "\/savings\/"\]/);
});

test("web Worker config preserves public runtime variables across deploys", () => {
  assert.match(webWrangler, /"vars"\s*:/);
  assert.match(webWrangler, /"previews"\s*:/);
  for (const [name, value] of publicRuntimeVars) {
    const assignment = `"${name}": "${value}"`;
    assert.equal(webWrangler.split(assignment).length, 3, `${name} should be set for production and previews`);
  }
});

test("root app Worker config preserves public runtime variables across deploys", () => {
  assert.match(rootWrangler, /\[vars\]/);
  assert.match(rootWrangler, /\[previews\.vars\]/);
  for (const [name, value] of publicRuntimeVars) {
    const assignment = `${name} = "${value}"`;
    assert.equal(rootWrangler.split(assignment).length, 3, `${name} should be set for production and previews`);
  }
});

test("Worker previews use their workers.dev account domain as the passkey relying party", () => {
  const rootProductionVars = rootWrangler.slice(
    rootWrangler.indexOf("[vars]"),
    rootWrangler.indexOf("[[d1_databases]]"),
  );
  const rootPreviewVars = rootWrangler.slice(
    rootWrangler.indexOf("[previews.vars]"),
    rootWrangler.indexOf("[[previews.d1_databases]]"),
  );

  assert.equal(webConfig.vars.NEXT_PUBLIC_PASSKEY_RP_ID, "kettigo.xyz");
  assert.equal(webConfig.previews.vars.NEXT_PUBLIC_PASSKEY_RP_ID, "blvieira5.workers.dev");
  assert.match(rootProductionVars, /NEXT_PUBLIC_PASSKEY_RP_ID = "kettigo\.xyz"/);
  assert.match(rootPreviewVars, /NEXT_PUBLIC_PASSKEY_RP_ID = "blvieira5\.workers\.dev"/);
});

test("web Worker configs run the keeper every minute", () => {
  assert.match(webWrangler, /"triggers"\s*:/);
  assert.match(webWrangler, /"crons": \["\* \* \* \* \*"\]/);
  assert.equal(webWrangler.split('"DRAW_KEEPER_MINIMUM_PRIZE": "1000000"').length, 3);
  assert.equal(webWrangler.split('"MORPHO_KEEPER_START_BLOCK": "11864127"').length, 3);

  assert.match(rootWrangler, /\[triggers\]/);
  assert.match(rootWrangler, /crons = \["\* \* \* \* \*"\]/);
  assert.equal(rootWrangler.split('DRAW_KEEPER_MINIMUM_PRIZE = "1000000"').length, 3);
  assert.equal(rootWrangler.split('MORPHO_KEEPER_START_BLOCK = "11864127"').length, 3);
});

test("root app Worker cron runs every keeper lane", () => {
  assert.match(rootWorker, /runKeeperAll\(env, "cron"\)/);
  assert.match(rootWorker, /runMorphoKeeper/);
  assert.match(rootWorker, /runWithdrawalKeeper/);
  assert.match(rootWorker, /runDrawKeeper/);
  assert.doesNotMatch(rootWorker, /ctx\.waitUntil\(runDrawKeeper\(env, "cron"\)\)/);
});
