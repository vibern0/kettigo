import {
  decodeFunctionResult,
  encodeFunctionData,
  getAddress,
  isHex,
  type Address,
  type Hex,
} from "viem";

import { confidentialPrizePoolAbi } from "./contracts.ts";
import type { PrizeProofClientOptions } from "./prize-proof-client.ts";
import { createPrizeProofClient } from "./prize-proof-client.ts";

type ViemRequestClient = Readonly<{
  request(args: { method: string; params: readonly unknown[] }): Promise<unknown>;
}>;
type ReaderOptions = Readonly<{ signal?: AbortSignal; blockHash?: Hex }>;
const active = (signal?: AbortSignal) => {
  if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted.", "AbortError");
};
const blockHash = (block: unknown): Hex => {
  if (!block || typeof block !== "object" || !isHex((block as { hash?: unknown }).hash))
    throw new Error("Invalid block response.");
  return (block as { hash: Hex }).hash;
};

/** Raw EIP-1898 reads; canonical-hash failures deliberately have no fallback. */
export function createViemPrizeChainReader(client: ViemRequestClient, pool: Address) {
  const target = getAddress(pool);
  const call = async (data: Hex, options: ReaderOptions = {}): Promise<Hex> => {
    active(options.signal);
    const result = await client.request({
      method: "eth_call",
      params: [
        { to: target, data },
        options.blockHash ? { blockHash: options.blockHash, requireCanonical: true } : "latest",
      ],
    });
    active(options.signal);
    if (!isHex(result)) throw new Error("Invalid chain read response.");
    return result;
  };
  const readBlock = async (tag: string, options: ReaderOptions = {}) => {
    active(options.signal);
    const block = await client.request({ method: "eth_getBlockByNumber", params: [tag, false] });
    active(options.signal);
    return blockHash(block);
  };
  return Object.freeze({
    readBlockHash: (options: ReaderOptions = {}) => readBlock("latest", options),
    getBlockHash: (number: bigint, options: ReaderOptions = {}) =>
      readBlock(`0x${number.toString(16)}`, options),
    async readDraw(drawId: bigint, options: ReaderOptions = {}) {
      const raw = await call(
        encodeFunctionData({
          abi: confidentialPrizePoolAbi,
          functionName: "draws",
          args: [drawId],
        }),
        options,
      );
      const value = decodeFunctionResult({
        abi: confidentialPrizePoolAbi,
        functionName: "draws",
        data: raw,
      }) as readonly [Hex, Hex, Hex, Hex, Hex, bigint, bigint];
      return Object.freeze({
        rootHash: value[0],
        rootSum: value[1],
        ticket: value[2],
        upperBound: value[5],
        closeBlockNumber: value[6],
      });
    },
    async readChecked(drawId: bigint, account: Address, options: ReaderOptions = {}) {
      const raw = await call(
        encodeFunctionData({
          abi: confidentialPrizePoolAbi,
          functionName: "checked",
          args: [drawId, getAddress(account)],
        }),
        options,
      );
      return decodeFunctionResult({
        abi: confidentialPrizePoolAbi,
        functionName: "checked",
        data: raw,
      }) as boolean;
    },
    async readAward(drawId: bigint, account: Address, options: ReaderOptions = {}) {
      const raw = await call(
        encodeFunctionData({
          abi: confidentialPrizePoolAbi,
          functionName: "encryptedAwardOf",
          args: [drawId, getAddress(account)],
        }),
        options,
      );
      return decodeFunctionResult({
        abi: confidentialPrizePoolAbi,
        functionName: "encryptedAwardOf",
        data: raw,
      }) as Hex;
    },
  });
}

export function createViemPrizeProofClient(
  options: Omit<PrizeProofClientOptions, "chainReader"> & { client: ViemRequestClient },
) {
  return createPrizeProofClient({
    ...options,
    chainReader: createViemPrizeChainReader(options.client, options.pool),
  });
}
