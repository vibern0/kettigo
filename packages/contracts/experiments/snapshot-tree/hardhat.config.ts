import path from "node:path";
import base from "../../hardhat.config";

// Throwaway feasibility workspace. No production sources or deployment settings change.
export default {
  ...base,
  paths: {
    root: path.resolve(__dirname, "../.."),
    sources: path.join(__dirname, "contracts"),
    tests: path.join(__dirname, "test"),
    cache: path.join(__dirname, "cache"),
    artifacts: path.join(__dirname, "artifacts"),
  },
  typechain: { outDir: path.join(__dirname, "typechain-types") },
  mocha: { timeout: 120_000 },
};
