import { createPublicClient, http, type Address } from "viem";
import { deploymentChain } from "@/lib/deployment-chain.ts";
import { RPC_URL, confidentialPrizePoolAbi } from "@/lib/contracts";

export type DrawSnapshot = Readonly<{
  blockNumber: bigint;
  drawId: bigint;
  drawInterval: bigint;
  nextDrawAt: bigint;
  participantCount: bigint;
  publicPrizeReserve: bigint;
}>;

const client = createPublicClient({ chain: deploymentChain, transport: http(RPC_URL) });

export async function readDrawSnapshot(
  pool: Address,
  requestedBlockNumber?: bigint,
): Promise<DrawSnapshot> {
  const blockNumber = requestedBlockNumber ?? (await client.getBlockNumber());
  const [drawId, drawInterval, nextDrawAt, participantCount, publicPrizeReserve] =
    await Promise.all([
      client.readContract({
        address: pool,
        abi: confidentialPrizePoolAbi,
        functionName: "drawId",
        blockNumber,
      }),
      client.readContract({
        address: pool,
        abi: confidentialPrizePoolAbi,
        functionName: "drawInterval",
        blockNumber,
      }),
      client.readContract({
        address: pool,
        abi: confidentialPrizePoolAbi,
        functionName: "nextDrawAt",
        blockNumber,
      }),
      client.readContract({
        address: pool,
        abi: confidentialPrizePoolAbi,
        functionName: "participantCount",
        blockNumber,
      }),
      client.readContract({
        address: pool,
        abi: confidentialPrizePoolAbi,
        functionName: "publicPrizeReserve",
        blockNumber,
      }),
    ]);
  return { blockNumber, drawId, drawInterval, nextDrawAt, participantCount, publicPrizeReserve };
}
