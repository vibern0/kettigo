import assert from "node:assert/strict";
import test from "node:test";

import {
  createPrizeCheckCoordinator,
  createViemPrizeChainReader,
} from "../src/lib/prize-check-coordinator.ts";
import { encodeAbiParameters } from "viem";

const ACCOUNT = "0x1111111111111111111111111111111111111111";
const POOL = "0x2222222222222222222222222222222222222222";
const HASH = `0x${"aa".repeat(32)}`;
const OP_HASH = `0x${"bb".repeat(32)}`;
const ENTRY_POINT = "0x0000000071727De22E5E9d8BAf0edAc6f37da032";

function identity() {
  return {
    chainId: 11155111,
    entryPoint: ENTRY_POINT,
    sender: ACCOUNT,
    userOperationHash: OP_HASH,
  };
}

function proof() {
  return {
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
  };
}

function fixture(overrides = {}) {
  let checked = false;
  let award = HASH;
  let proofs = 0;
  let sends = 0;
  let saved = null;
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

test("already checked reads immutable historical award without a proof client or a send", async () => {
  const { coordinator, setChecked, getProofs, getSends } = fixture({
    getProofClient: () => {
      throw new Error("must not build proof client");
    },
  });
  setChecked(true);
  const result = await coordinator.review(4n);
  assert.deepEqual(result, { state: "checked", drawId: 4n, award: HASH });
  assert.equal(getProofs(), 0);
  assert.equal(getSends(), 0);
});

test("prepares only the accepted proof and sends once from confirm", async () => {
  const { coordinator, getSends } = fixture();
  const review = await coordinator.review(4n);
  assert.equal(review.state, "ready");
  const ready = await coordinator.prepare(review);
  const first = ready.confirm();
  assert.equal(ready.confirm(), first);
  assert.equal(getSends(), 1);
  await first;
});

test("viem reader pins calls to canonical EIP-1898 block hashes", async () => {
  const requests = [];
  const reader = createViemPrizeChainReader(
    {
      request: async (args) => {
        requests.push(args);
        return args.method === "eth_getBlockByNumber"
          ? { hash: HASH }
          : encodeAbiParameters(
              Array(7)
                .fill({ type: "bytes32" })
                .map((item, index) =>
                  index === 5 ? { type: "uint64" } : index === 6 ? { type: "uint256" } : item,
                ),
              [HASH, HASH, HASH, HASH, HASH, 2n, 10n],
            );
      },
    },
    POOL,
  );
  await reader.getBlockHash(10n);
  await reader.readDraw(4n, { blockHash: HASH });
  assert.equal(requests[1].params[1].blockHash, HASH);
  assert.equal(requests[1].params[1].requireCanonical, true);
});
