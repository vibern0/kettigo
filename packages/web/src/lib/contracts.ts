// Contract addresses & ABIs. The active Kettigo ABIs come from the shared
// protocol package.

import { erc20Abi } from "viem";
import { publicConfig } from "./runtime-config";

export {
  confidentialPrizePoolAbi,
  confidentialUsdcAbi,
  morphoYieldAdapterAbi,
} from "@kettigo/protocol";

export const CONTRACTS = {
  usdc: publicConfig("NEXT_PUBLIC_USDC_ADDRESS", process.env.NEXT_PUBLIC_USDC_ADDRESS) as `0x${string}`,
  confidentialUsdc: publicConfig("NEXT_PUBLIC_CONFIDENTIAL_USDC_ADDRESS", process.env.NEXT_PUBLIC_CONFIDENTIAL_USDC_ADDRESS) as `0x${string}`,
  confidentialPrizePool: publicConfig("NEXT_PUBLIC_CONFIDENTIAL_PRIZE_POOL_ADDRESS", process.env.NEXT_PUBLIC_CONFIDENTIAL_PRIZE_POOL_ADDRESS) as `0x${string}`,
} as const;

export const CHAIN_ID = Number(publicConfig("NEXT_PUBLIC_CHAIN_ID", process.env.NEXT_PUBLIC_CHAIN_ID) || 11155111);
export const RPC_URL = publicConfig("NEXT_PUBLIC_RPC_URL", process.env.NEXT_PUBLIC_RPC_URL);
export const PIMLICO_API_KEY = publicConfig("NEXT_PUBLIC_PIMLICO_API_KEY", process.env.NEXT_PUBLIC_PIMLICO_API_KEY);
export const PIMLICO_URL = `https://api.pimlico.io/v2/sepolia/rpc?apikey=${PIMLICO_API_KEY}`;

export { erc20Abi };
