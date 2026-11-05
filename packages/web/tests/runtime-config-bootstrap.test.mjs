import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { runtimeConfigScript } from "../worker/runtime-config-bootstrap.ts";
import { resolveSelectedPoolScope } from "../worker/selected-pool-scope.ts";

const layoutSource = readFileSync(new URL("../src/app/layout.tsx", import.meta.url), "utf8");
const scope = resolveSelectedPoolScope(new URL("https://app.example"), {
  NEXT_PUBLIC_RPC_URL: "https://rpc.example",
  NEXT_PUBLIC_USDC_ADDRESS: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
});

if (!scope.ok) throw new Error("test scope must resolve");

test("serializes runtime config into a parser-blocking bootstrap script", () => {
  const script = runtimeConfigScript(
    {
      NEXT_PUBLIC_PASSKEY_RP_ID: "blvieira5.workers.dev",
      NEXT_PUBLIC_PIMLICO_API_KEY: "configured",
    },
    scope.scope,
  );

  assert.match(script, /^window\.__KETTIGO_CONFIG__ = /);
  assert.match(script, /"NEXT_PUBLIC_PASSKEY_RP_ID":"blvieira5\.workers\.dev"/);
  assert.match(script, /"NEXT_PUBLIC_PIMLICO_API_KEY":"configured"/);
  assert.match(script, /;\n$/);
});

test("escapes markup before injecting runtime values into HTML", () => {
  const script = runtimeConfigScript(
    {
      NEXT_PUBLIC_PIMLICO_API_KEY: "</script><script>unexpected()</script>",
    },
    scope.scope,
  );

  assert.doesNotMatch(script, /<\/script>/);
  assert.match(script, /\\u003c\/script>/);
});

test("does not rely on a deferred Next script for runtime configuration", () => {
  assert.doesNotMatch(layoutSource, /next\/script|src="\/config\.js"/);
});

test("overrides financial config with one selected tuple", () => {
  const script = runtimeConfigScript(
    { NEXT_PUBLIC_PROOF_SERVICE_URL: "https://attacker.example", NEXT_PUBLIC_POOL_VERSION: "2" },
    scope.scope,
  );
  assert.match(script, /"NEXT_PUBLIC_PROOF_SERVICE_URL":""/);
  assert.match(script, /"NEXT_PUBLIC_POOL_VERSION":"legacy1"/);
  assert.match(script, /"selectedPoolScope":\{"id":"legacy-e65"/);
});
