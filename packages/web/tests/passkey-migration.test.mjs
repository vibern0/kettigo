import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { test } from "node:test";
import { runtimeConfig } from "../worker/runtime-config-bootstrap.ts";
import { resolveSelectedPoolScope } from "../worker/selected-pool-scope.ts";

const webRoot = new URL("../", import.meta.url);
const repoRoot = new URL("../../../", import.meta.url);

function read(relative, root = webRoot) {
  return readFileSync(new URL(relative, root), "utf8");
}

function sourceFiles(directory) {
  const entries = readdirSync(directory).map((name) => new URL(name, directory));
  return entries.flatMap((entry) =>
    statSync(entry).isDirectory() ? sourceFiles(new URL(`${entry.href}/`)) : [entry],
  );
}

const selection = resolveSelectedPoolScope(new URL("https://app.example"), {
  NEXT_PUBLIC_RPC_URL: "https://rpc.example",
  NEXT_PUBLIC_USDC_ADDRESS: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
});
if (!selection.ok) throw new Error("test scope must resolve");

test("production source and direct dependencies contain no Web3Auth path", () => {
  const productionSource = sourceFiles(new URL("src/", webRoot))
    .map((file) => readFileSync(file, "utf8"))
    .join("\n");
  const packageJson = read("package.json");

  assert.equal(existsSync(new URL("src/lib/web3auth.ts", webRoot)), false);
  assert.doesNotMatch(productionSource, /web3auth/i);
  assert.doesNotMatch(packageJson, /@web3auth|permissionless/);
  assert.doesNotMatch(read("next.config.js"), /web3auth/i);
});

test("runtime config exposes passkey relying-party values", () => {
  const config = runtimeConfig(
    {
      NEXT_PUBLIC_PASSKEY_RP_ID: "kettigo.xyz",
      NEXT_PUBLIC_PASSKEY_RP_NAME: "Kettigo",
    },
    selection.scope,
  );

  assert.equal(config.NEXT_PUBLIC_PASSKEY_RP_ID, "kettigo.xyz");
  assert.equal(config.NEXT_PUBLIC_PASSKEY_RP_NAME, "Kettigo");
  assert.equal(
    Object.keys(config).some((key) => /WEB3AUTH/i.test(key)),
    false,
  );
});

test("deployments use the repository's pinned package manager", () => {
  assert.match(read("package.json", repoRoot), /"packageManager": "pnpm@10\.11\.1"/);
  assert.match(read("netlify.toml", repoRoot), /PNPM_VERSION = "10\.11\.1"/);
});

test("operator docs cover the passkey Safe acceptance lifecycle and recovery limit", () => {
  const docs = `${read("README.md")}\n${read("README.md", repoRoot)}`;

  assert.match(docs, /create a passkey/i);
  assert.match(docs, /Safe 1\.4\.1/i);
  assert.match(docs, /sponsored transaction/i);
  assert.match(docs, /Zama.+decryption/is);
  assert.match(docs, /reload.+same.+Safe address/is);
  assert.match(docs, /recovery.+not supported/is);
  assert.doesNotMatch(docs, /Web3Auth/i);
});
