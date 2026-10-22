import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = path.join(import.meta.dirname, "..");

async function source(file) {
  return readFile(path.join(root, file), "utf8");
}

test("wallet and transaction consumers use the provider-neutral passkey session", async () => {
  const files = await Promise.all([
    "src/lib/wallet-context.tsx",
    "src/lib/zama.ts",
    "src/lib/confidential-balances.ts",
    "src/app/savings/page.tsx",
    "src/app/draw/page.tsx",
  ].map(source));
  const combined = files.join("\n");

  assert.doesNotMatch(combined, /\.\/web3auth|@\/lib\/web3auth|type SmartSession\b|currentSession: SmartSession\b/);
  assert.doesNotMatch(combined, /ownerAddress|OwnerZamaSigner|createOwnerZamaSDK|signOwnerTypedData/);
  assert.doesNotMatch(await source("src/app/savings/page.tsx"), /encodeAbiParameters/);
});

test("wallet copy offers passkey onboarding without social-login fallbacks", async () => {
  const files = await Promise.all([
    "src/components/ConnectButton.tsx",
    "src/components/Header.tsx",
    "src/app/page.tsx",
    "src/app/profile/page.tsx",
  ].map(source));
  const combined = files.join("\n");

  assert.match(combined, /Create account|Open account/);
  assert.doesNotMatch(combined, /Google|Apple|Social login/i);
});

test("sign-out clears in-memory balances without deleting passkey metadata", async () => {
  const wallet = await source("src/lib/wallet-context.tsx");
  const disconnect = wallet.slice(
    wallet.indexOf("const disconnect = useCallback"),
    wallet.indexOf("useEffect(() =>", wallet.indexOf("const disconnect = useCallback")),
  );
  assert.match(disconnect, /setConfidentialBalance\(undefined\)/);
  assert.match(disconnect, /setPrincipal\(undefined\)/);
  assert.doesNotMatch(disconnect, /removeItem|clearPasskey|forgetPasskey/);
});

test("the replacement action preserves old metadata until the new passkey succeeds", async () => {
  const wallet = await source("src/lib/wallet-context.tsx");
  assert.match(wallet, /state\.status === "invalid-metadata"/);
  assert.doesNotMatch(wallet, /clearPasskeyMetadata\(\)/);
  assert.match(wallet, /replacingInvalidAccount \? \{ status: "missing" as const \}/);
  assert.match(wallet, /createPasskeyAccount\(passkeyConfig\(\)\)/);
});
