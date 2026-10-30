import path from "node:path";
// Keep unrelated promotional dotenv messages out of security experiment output.
process.env.DOTENV_CONFIG_QUIET = "true";
const base = require("../../hardhat.config").default;

export default {
  ...base,
  networks: {
    ...base.networks,
    sepolia: { ...base.networks.sepolia, gasPrice: Number(process.env.RESEARCH_GAS_PRICE_WEI ?? "100000") },
  },
  paths: {
    root: path.resolve(__dirname, "../.."),
    sources: path.join(__dirname, "contracts"),
    tests: path.join(__dirname, "test"),
    cache: path.join(__dirname, "cache"),
    artifacts: path.join(__dirname, "artifacts"),
  },
  typechain: { outDir: path.join(__dirname, "typechain-types") },
  mocha: { timeout: 240_000 },
};
