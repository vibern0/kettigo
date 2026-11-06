import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const homePage = await readFile(
  new URL("../src/app/page.tsx", import.meta.url),
  "utf8",
);
const savingsStatus = await readFile(
  new URL("../src/components/savings/SavingsStatus.tsx", import.meta.url),
  "utf8",
);

test("uses the standard text color for both account balances", () => {
  assert.match(
    homePage,
    /walletUsdc\}<\/span>\s*<span className="font-semibold tabular-nums text-text">\s*\{formatUSDC\(usdcBalance\)\} USDC/,
  );
  assert.match(
    homePage,
    /savingsBalance\}<\/span>\s*<span className="font-semibold tabular-nums text-text">[\s\S]*?formatUSDC\(principal\)[\s\S]*?USDC/,
  );
});

test("uses the standard text color for the savings page balance", () => {
  assert.match(
    savingsStatus,
    /savingsBalance\}<\/span>\s*<span className="font-semibold tabular-nums text-text">[\s\S]*?formatUSDC\(principal\)[\s\S]*?USDC/,
  );
});
