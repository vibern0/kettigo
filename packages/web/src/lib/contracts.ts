// Contract addresses & ABIs. The active Kettigo ABIs come from the shared
// protocol package.

import { erc20Abi, getAddress } from "viem";
import { publicConfig } from "./runtime-config";

export {
  confidentialPrizePoolAbi,
  confidentialUsdcAbi,
  morphoYieldAdapterAbi,
} from "@kettigo/protocol";

const configuredAddress = (name: `NEXT_PUBLIC_${string}`) => {
  const value = publicConfig(name, process.env[name]);
  return value ? getAddress(value) : ("" as `0x${string}`);
};

export const CONTRACTS = {
  usdc: configuredAddress("NEXT_PUBLIC_USDC_ADDRESS"),
  confidentialUsdc: configuredAddress("NEXT_PUBLIC_CONFIDENTIAL_USDC_ADDRESS"),
  confidentialPrizePool: configuredAddress("NEXT_PUBLIC_CONFIDENTIAL_PRIZE_POOL_ADDRESS"),
} as const;

export const CHAIN_ID = Number(publicConfig("NEXT_PUBLIC_CHAIN_ID", process.env.NEXT_PUBLIC_CHAIN_ID) || 11155111);
export const RPC_URL = publicConfig("NEXT_PUBLIC_RPC_URL", process.env.NEXT_PUBLIC_RPC_URL);
export const PIMLICO_API_KEY = publicConfig("NEXT_PUBLIC_PIMLICO_API_KEY", process.env.NEXT_PUBLIC_PIMLICO_API_KEY);
export const PIMLICO_URL = `https://api.pimlico.io/v2/sepolia/rpc?apikey=${PIMLICO_API_KEY}`;

export { erc20Abi };
