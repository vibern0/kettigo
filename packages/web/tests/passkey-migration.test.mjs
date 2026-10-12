import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { test } from "node:test";

const webRoot = new URL("../", import.meta.url);
const repoRoot = new URL("../../../", import.meta.url);

function read(relative, root = webRoot) {
  return readFileSync(new URL(relative, root), "utf8");
}

function sourceFiles(directory) {
  const entries = readdirSync(directory).map((name) => new URL(name, directory));
  return entries.flatMap((entry) => statSync(entry).isDirectory() ? sourceFiles(new URL(`${entry.href}/`)) : [entry]);
}

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
  for (const config of [
    read(".env.example"),
    read("worker.ts"),
    read("wrangler.jsonc"),
    read("wrangler.toml", repoRoot),
  ]) {
    assert.match(config, /NEXT_PUBLIC_PASSKEY_RP_ID/);
    assert.match(config, /NEXT_PUBLIC_PASSKEY_RP_NAME/);
    assert.doesNotMatch(config, /WEB3AUTH/i);
  }
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
