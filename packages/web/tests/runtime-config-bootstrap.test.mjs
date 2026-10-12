import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { runtimeConfigScript } from "../worker/runtime-config-bootstrap.ts";

const layoutSource = readFileSync(new URL("../src/app/layout.tsx", import.meta.url), "utf8");

test("serializes runtime config into a parser-blocking bootstrap script", () => {
  const script = runtimeConfigScript({
    NEXT_PUBLIC_PASSKEY_RP_ID: "blvieira5.workers.dev",
    NEXT_PUBLIC_PIMLICO_API_KEY: "configured",
  });

  assert.match(script, /^window\.__KETTIGO_CONFIG__ = /);
  assert.match(script, /"NEXT_PUBLIC_PASSKEY_RP_ID":"blvieira5\.workers\.dev"/);
  assert.match(script, /"NEXT_PUBLIC_PIMLICO_API_KEY":"configured"/);
  assert.match(script, /;\n$/);
});

test("escapes markup before injecting runtime values into HTML", () => {
  const script = runtimeConfigScript({
    NEXT_PUBLIC_PIMLICO_API_KEY: "</script><script>unexpected()</script>",
  });

  assert.doesNotMatch(script, /<\/script>/);
  assert.match(script, /\\u003c\/script>/);
});

test("does not rely on a deferred Next script for runtime configuration", () => {
  assert.doesNotMatch(layoutSource, /next\/script|src="\/config\.js"/);
});
