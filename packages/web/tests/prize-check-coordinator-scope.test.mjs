import assert from "node:assert/strict";
import test from "node:test";

import {
  createPrizeCheckCoordinator,
  createPrizeCheckIntentStore,
} from "../src/lib/prize-check-coordinator.ts";
import { ACCOUNT, HASH, identity, memoryStorage } from "./prize-check-coordinator-fixtures.mjs";

test("retains an E65 prize-check intent when a 9c coordinator opens it", async () => {
  const storage = memoryStorage();
  const store = createPrizeCheckIntentStore(storage);
  const saved = {
    chainId: 11155111,
    pool: "0xe65D6459a7Ce01315FbB0998C37233c6FeE3aB8b",
    account: ACCOUNT,
    drawId: 4n,
    action: "checkPrize",
    operation: identity(),
  };
  await store.save(saved);
  const before = storage.raw();
  let lookups = 0;
  let preparations = 0;
  const coordinator = createPrizeCheckCoordinator({
    chainId: 11155111,
    pool: "0x9c23E5f7143612dc1232FC643A57300291e0d719",
    account: ACCOUNT,
    session: {
      address: ACCOUNT,
      prepareTransaction: async () => {
        preparations += 1;
        throw new Error("must not prepare");
      },
      lookupUserOperation: async () => {
        lookups += 1;
        throw new Error("must not lookup");
      },
    },
    readChecked: async () => false,
    readAward: async () => HASH,
    readBlockHash: async () => HASH,
    getProofClient: () => ({ getProof: async () => ({ kind: "not-eligible" }) }),
    intentStore: store,
  });

  assert.throws(() => coordinator.pending(4n), /different account or draw/i);
  await assert.rejects(coordinator.reconcile(4n, store.read()), /different account or draw/i);
  assert.equal(storage.raw(), before);
  assert.equal(lookups, 0);
  assert.equal(preparations, 0);
});
