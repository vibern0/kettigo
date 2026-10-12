import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const runtimeFiles = [
  "src/lib/zama.ts",
  "src/lib/confidential-balances.ts",
  "src/app/draw/page.tsx",
  "src/app/savings/page.tsx",
  "netlify/functions/withdrawal-keeper.ts",
  "netlify/functions/morpho-keeper.ts",
];

async function readRuntimeSources() {
  return Promise.all(
    runtimeFiles.map(async (file) => ({
      file,
      source: await readFile(path.join(import.meta.dirname, "..", file), "utf8"),
    })),
  );
}

test("runtime code uses the v3 Zama SDK instead of legacy relayer imports", async () => {
  const sources = await readRuntimeSources();
  const offenders = sources
    .filter(({ source }) => source.includes("@zama-fhe/relayer-sdk"))
    .map(({ file }) => file);

  assert.deepEqual(offenders, []);
});

test("runtime code delegates decryption instead of raw EIP-712 userDecrypt orchestration", async () => {
  const forbidden = /\b(createEIP712|userDecrypt|eth_signTypedData_v4|stringifyTypedData|userDecryptTimestamp)\b/;
  const offenders = (await readRuntimeSources())
    .filter(({ source }) => forbidden.test(source))
    .map(({ file }) => file);

  assert.deepEqual(offenders, []);
});

test("browser decryption persists one seven-day permit for the token and pool", async () => {
  const zama = await readFile(path.join(import.meta.dirname, "..", "src/lib/zama.ts"), "utf8");
  const balances = await readFile(path.join(import.meta.dirname, "..", "src/lib/confidential-balances.ts"), "utf8");

  assert.doesNotMatch(zama, /\bmemoryStorage\b/);
  assert.match(zama, /createPersistentCredentialOptions\(indexedDBStorage\)/);
  assert.match(balances, /grantSmartZamaPermit\(currentSession, \[token, pool\]\)/);
  assert.match(balances, /withSmartZamaSDK\(currentSession/);
  assert.doesNotMatch(balances, /getSmartZamaSDK/);
  assert.equal((balances.match(/decryptValues\(/g) ?? []).length, 1);
});

test("explicit sign-out clears the session's stored Zama credentials", async () => {
  const wallet = await readFile(path.join(import.meta.dirname, "..", "src/lib/wallet-context.tsx"), "utf8");
  const disconnect = wallet.slice(
    wallet.indexOf("const disconnect = useCallback"),
    wallet.indexOf("useEffect(() =>", wallet.indexOf("const disconnect = useCallback")),
  );

  assert.match(disconnect, /clearSmartZamaSession\(state\.session\)/);
  assert.ok(
    disconnect.indexOf("balanceLoadId.current += 1")
      < disconnect.indexOf("clearSmartZamaSession(state.session)"),
  );
});
