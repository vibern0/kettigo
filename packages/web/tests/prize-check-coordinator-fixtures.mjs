import { createPrizeCheckCoordinator } from "../src/lib/prize-check-coordinator.ts";

export const ACCOUNT = "0x1111111111111111111111111111111111111111";
export const POOL = "0x2222222222222222222222222222222222222222";
export const HASH = `0x${"aa".repeat(32)}`;
export const OP_HASH = `0x${"bb".repeat(32)}`;
export const ENTRY_POINT = "0x0000000071727De22E5E9d8BAf0edAc6f37da032";
export const identity = () => ({
  chainId: 11155111,
  entryPoint: ENTRY_POINT,
  sender: ACCOUNT,
  userOperationHash: OP_HASH,
});
export const proof = () => ({
  drawId: 4n,
  rootHash: HASH,
  rootSum: HASH,
  ticket: HASH,
  upperBound: 2n,
  closeBlockNumber: 10n,
  closeLogIndex: 1,
  chainId: 11155111n,
  pool: POOL,
  blockHash: HASH,
  account: ACCOUNT,
  index: 1n,
  generation: 3n,
  balance: HASH,
  siblingHashes: Array(32).fill(HASH),
  siblingSums: Array(32).fill(HASH),
  parentSums: Array(32).fill(HASH),
});
export function fixture(overrides = {}) {
  let checked = false,
    award = HASH,
    proofs = 0,
    sends = 0,
    saved = null;
  const prepared = {
    cancel() {},
    send: (options) => {
      sends += 1;
      return Promise.resolve().then(async () => {
        await options?.onOperationPrepared?.(identity());
        checked = true;
        return HASH;
      });
    },
  };
  const coordinator = createPrizeCheckCoordinator({
    chainId: 11155111,
    pool: POOL,
    account: ACCOUNT,
    session: {
      address: ACCOUNT,
      prepareTransaction: async () => prepared,
      lookupUserOperation: async () => ({
        state: "confirmed",
        operation: identity(),
        transactionHash: HASH,
        blockNumber: 20n,
        blockHash: HASH,
      }),
    },
    readChecked: async () => checked,
    readAward: async () => award,
    readBlockHash: async () => HASH,
    getProofClient: () => ({
      getProof: async () => {
        proofs += 1;
        return { kind: "proof", proof: proof() };
      },
    }),
    prepareReadSessionCalls: async () => [],
    intentStore: {
      save: async (value) => {
        saved = value;
      },
      read: () => saved,
      clear: async () => {
        saved = null;
      },
    },
    ...overrides,
  });
  return {
    coordinator,
    prepared,
    setChecked: (value) => {
      checked = value;
    },
    setAward: (value) => {
      award = value;
    },
    getProofs: () => proofs,
    getSends: () => sends,
  };
}
export function memoryStorage(initial = null) {
  let value = initial;
  return {
    getItem: () => value,
    setItem: (_key, next) => {
      value = next;
    },
    removeItem: () => {
      value = null;
    },
    raw: () => value,
  };
}
