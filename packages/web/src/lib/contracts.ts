// Contract addresses & ABIs. The active Kettigo ABIs come from the shared
// protocol package.

import { erc20Abi, type Address } from "viem";
import { publicConfig, SELECTED_SCOPE } from "./runtime-config";

export {
  confidentialPrizePoolAbi,
  confidentialUsdcAbi,
  morphoYieldAdapterAbi,
} from "@kettigo/protocol";

const unavailableAddress = "" as Address;

export const CONTRACTS = {
  usdc: SELECTED_SCOPE?.usdc ?? unavailableAddress,
  confidentialUsdc: SELECTED_SCOPE?.wrapper ?? unavailableAddress,
  confidentialPrizePool: SELECTED_SCOPE?.pool ?? unavailableAddress,
} as const;

export const CHAIN_ID = SELECTED_SCOPE?.chainId ?? 11155111;
export const RPC_URL = SELECTED_SCOPE?.rpcUrl ?? "";
export const PIMLICO_API_KEY = publicConfig(
  "NEXT_PUBLIC_PIMLICO_API_KEY",
  process.env.NEXT_PUBLIC_PIMLICO_API_KEY,
);
export const PIMLICO_URL = `https://api.pimlico.io/v2/sepolia/rpc?apikey=${PIMLICO_API_KEY}`;

export { erc20Abi };
