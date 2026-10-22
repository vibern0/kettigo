import { existsSync, readFileSync } from "node:fs";

const KEEPERS = new Map([
  ["draw", new URL("../../web/netlify/functions/draw-keeper.ts", import.meta.url)],
  ["morpho", new URL("../../web/netlify/functions/morpho-keeper.ts", import.meta.url)],
  ["withdrawal", new URL("../../web/netlify/functions/withdrawal-keeper.ts", import.meta.url)],
]);

function loadEnvFile(fileUrl) {
  if (!existsSync(fileUrl)) return;

  for (const line of readFileSync(fileUrl, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)?\s*$/);
    if (!match || process.env[match[1]]) continue;

    const rawValue = match[2] ?? "";
    const value = rawValue.replace(/^(['"])(.*)\1$/, "$2");
    process.env[match[1]] = value;
  }
}

function applyLocalFallbacks() {
  process.env.KEEPER_PRIVATE_KEY ||= process.env.PRIVATE_KEY ?? process.env.DEPLOYER_PRIVATE_KEY ?? process.env.SEPOLIA_PRIVATE_KEY;
}

function assertLocalEnv() {
  const missing = [];
  if (!process.env.SEPOLIA_RPC_URL && !process.env.NEXT_PUBLIC_RPC_URL) missing.push("SEPOLIA_RPC_URL or NEXT_PUBLIC_RPC_URL");
  if (!process.env.CONFIDENTIAL_PRIZE_POOL_ADDRESS && !process.env.NEXT_PUBLIC_CONFIDENTIAL_PRIZE_POOL_ADDRESS) {
    missing.push("CONFIDENTIAL_PRIZE_POOL_ADDRESS or NEXT_PUBLIC_CONFIDENTIAL_PRIZE_POOL_ADDRESS");
  }
  if (!process.env.KEEPER_PRIVATE_KEY) missing.push("KEEPER_PRIVATE_KEY");

  if (missing.length > 0) {
    throw new Error(`Missing keeper env: ${missing.join(", ")}`);
  }
}

const keeperName = process.argv[2];
const keeperUrl = keeperName ? KEEPERS.get(keeperName) : undefined;

if (!keeperUrl) {
  console.error(`Usage: node packages/keeper/src/run-web-keeper.mjs <${[...KEEPERS.keys()].join("|")}> [--check]`);
  process.exit(1);
}

loadEnvFile(new URL("../../web/.env", import.meta.url));
loadEnvFile(new URL("../../web/.env.local", import.meta.url));
loadEnvFile(new URL("../../contracts/.env", import.meta.url));
applyLocalFallbacks();

const { default: run } = await import(keeperUrl.href);

if (process.argv.includes("--check")) {
  assertLocalEnv();
  console.log(`${keeperName} keeper loaded`);
} else {
  await run();
}
