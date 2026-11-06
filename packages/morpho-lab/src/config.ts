import { getAddress, isHex } from "viem";
import type { Address, Hex } from "viem";

const DEFAULTS = {
  chainId: 11155111,
  rpcUrl: "https://ethereum-sepolia-rpc.publicnode.com",
  usdc: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
  weth: "0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9",
  wrapper: "0xe64c1836b96253104a753E60188f691173Ded624",
  pool: "0x30530991e296a663a32567C170b290fB88578408",
  adapter: "0x6c180a345F6eA433AfE59c35c2a611B0d15d1c09",
  morpho: "0xd011EE229E7459ba1ddd22631eF7bF528d424A14",
  marketId: "0x8c561f0929c3a3e2b20fba99c2ae15fc57b4d0599e4371b67c9a58388a27b9d2",
} as const;

export type LabConfig = {
  chainId: 11155111;
  rpcUrl: string;
  usdc: Address;
  weth: Address;
  wrapper: Address;
  pool: Address;
  adapter: Address;
  morpho: Address;
  marketId: Hex;
};

type LabConfigCandidate = Omit<LabConfig, "chainId"> & { chainId: number };

export function loadLabConfig(env: Record<string, string | undefined>): LabConfig {
  const config: LabConfig = {
    chainId: 11155111,
    rpcUrl: env.VITE_SEPOLIA_RPC_URL ?? DEFAULTS.rpcUrl,
    usdc: loadAddress("USDC address", env.VITE_USDC_ADDRESS, DEFAULTS.usdc),
    weth: loadAddress("WETH address", env.VITE_WETH_ADDRESS, DEFAULTS.weth),
    wrapper: loadAddress(
      "Wrapper address",
      env.VITE_WRAPPER_ADDRESS,
      DEFAULTS.wrapper,
    ),
    pool: loadAddress("Pool address", env.VITE_POOL_ADDRESS, DEFAULTS.pool),
    adapter: loadAddress(
      "Adapter address",
      env.VITE_ADAPTER_ADDRESS,
      DEFAULTS.adapter,
    ),
    morpho: loadAddress(
      "Morpho address",
      env.VITE_MORPHO_ADDRESS,
      DEFAULTS.morpho,
    ),
    marketId: loadMarketId(env),
  };

  validateLabConfig(config);
  return config;
}

export function validateLabConfig(
  config: LabConfigCandidate,
): asserts config is LabConfig {
  if (config.chainId !== 11155111) {
    throw new Error("Chain ID must be 11155111");
  }

  if (config.rpcUrl.trim().length === 0) {
    throw new Error("RPC URL is required");
  }
  try {
    if (!["http:", "https:"].includes(new URL(config.rpcUrl).protocol)) throw new Error();
  } catch {
    throw new Error("RPC URL must be a valid HTTP or HTTPS URL");
  }

  validateAddress("USDC address", config.usdc);
  validateAddress("WETH address", config.weth);
  validateAddress("Wrapper address", config.wrapper);
  validateAddress("Pool address", config.pool);
  validateAddress("Adapter address", config.adapter);
  validateAddress("Morpho address", config.morpho);

  if (!isMarketId(config.marketId)) {
    throw new Error("Market ID must be exactly 32 bytes");
  }
}

function loadAddress(
  label: string,
  override: string | undefined,
  fallback: string,
): Address {
  const rawAddress = override === undefined ? fallback : override.toLowerCase();

  try {
    return getAddress(rawAddress);
  } catch {
    throw new Error(`${label} is invalid`);
  }
}

function validateAddress(label: string, address: Address): void {
  try {
    getAddress(address);
  } catch {
    throw new Error(`${label} is invalid`);
  }
}

function loadMarketId(env: Record<string, string | undefined>): Hex {
  const marketId = env.VITE_MORPHO_MARKET_ID ?? DEFAULTS.marketId;

  if (!isMarketId(marketId)) {
    throw new Error("Market ID must be exactly 32 bytes");
  }

  return marketId;
}

function isMarketId(value: string): value is Hex {
  return isHex(value, { strict: true }) && value.length === 66;
}
