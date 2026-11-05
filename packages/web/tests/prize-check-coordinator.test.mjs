import assert from "node:assert/strict";
import test from "node:test";

import {
  createPrizeCheckIntentStore,
  createPrizeCheckCoordinator,
  createViemPrizeChainReader,
} from "../src/lib/prize-check-coordinator.ts";
import { decodeFunctionData, encodeAbiParameters } from "viem";
import { confidentialPrizePoolAbi } from "@kettigo/protocol";
import {
  SafeUserOperationNotSubmittedError,
  SafeUserOperationRejectedError,
} from "../src/lib/passkey-operation.ts";
import {
  ACCOUNT,
  HASH,
  OP_HASH,
  POOL,
  identity,
  fixture,
  memoryStorage,
} from "./prize-check-coordinator-fixtures.mjs";

test("rejects corrupt saved intent rather than overwriting it", async () => {
  const storage = memoryStorage("{bad");
  const store = createPrizeCheckIntentStore(storage);
  assert.throws(() => store.read(), /corrupt/i);
  await assert.rejects(
    store.save({
      chainId: 11155111,
      pool: POOL,
      account: ACCOUNT,
      drawId: 4n,
      action: "checkPrize",
      operation: identity(),
    }),
    /corrupt/i,
  );
  assert.equal(storage.raw(), "{bad");
});

test("retains an E65 prize-check intent when a 9c coordinator opens it", async () => {
  const storage = memoryStorage();
  const store = createPrizeCheckIntentStore(storage);
  const e65Pool = "0xe65D6459a7Ce01315FbB0998C37233c6FeE3aB8b";
  const nineCPool = "0x9c23E5f7143612dc1232FC643A57300291e0d719";
  const saved = {
    chainId: 11155111,
    pool: e65Pool,
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
    pool: nineCPool,
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

test("rejects unknown identity fields and a non-EntryPoint-0.7 saved identity", async () => {
  const base = {
    chainId: 11155111,
    pool: POOL,
    account: ACCOUNT,
    drawId: "4",
    action: "checkPrize",
    operation: { ...identity() },
  };
  for (const operation of [
    { ...base.operation, signature: "0x1234" },
    { ...base.operation, entryPoint: POOL },
  ]) {
    const storage = memoryStorage(JSON.stringify({ ...base, operation }));
    assert.throws(() => createPrizeCheckIntentStore(storage).read(), /corrupt/i);
  }
});

test("fails closed when durable save or exact clear readback fails", async () => {
  const noWrite = { getItem: () => null, setItem() {}, removeItem() {} };
  const store = createPrizeCheckIntentStore(noWrite);
  const saved = {
    chainId: 11155111,
    pool: POOL,
    account: ACCOUNT,
    drawId: 4n,
    action: "checkPrize",
    operation: identity(),
  };
  await assert.rejects(store.save(saved), /could not save/i);
  const stuck = memoryStorage(JSON.stringify({ ...saved, drawId: "4" }));
  stuck.removeItem = () => {};
  await assert.rejects(createPrizeCheckIntentStore(stuck).clear(saved), /could not clear/i);
});

test("uses one canonical initial snapshot for checked history", async () => {
  const calls = [];
  const { coordinator, setChecked } = fixture({
    readBlockHash: async () => HASH,
    readChecked: async (_draw, options) => {
      calls.push(["checked", options.blockHash]);
      return true;
    },
    readAward: async (_draw, options) => {
      calls.push(["award", options.blockHash]);
      return HASH;
    },
  });
  setChecked(true);
  await coordinator.review(4n);
  assert.deepEqual(calls, [
    ["checked", HASH],
    ["checked", HASH],
    ["award", HASH],
  ]);
});

test("does not prepare after another checker wins during read-session setup", async () => {
  let reads = 0,
    preparations = 0;
  const { coordinator } = fixture({
    readChecked: async () => ++reads > 1,
    prepareReadSessionCalls: async () => [],
    session: {
      address: ACCOUNT,
      prepareTransaction: async () => {
        preparations += 1;
        throw new Error("must not prepare");
      },
    },
  });
  const reviewed = await coordinator.review(4n);
  await assert.rejects(coordinator.prepare(reviewed), /already been checked/i);
  assert.equal(preparations, 0);
});

test("encodes the fixed beneficiary and all eight canonical check arguments", async () => {
  let call;
  const { coordinator } = fixture({
    session: {
      address: ACCOUNT,
      prepareTransaction: async (calls) => {
        call = calls.at(-1);
        return { cancel() {}, send: async () => HASH };
      },
    },
  });
  const ready = await coordinator.prepare(await coordinator.review(4n));
  assert.ok(ready);
  const decoded = decodeFunctionData({ abi: confidentialPrizePoolAbi, data: call.data });
  assert.equal(call.to, POOL);
  assert.equal(decoded.functionName, "checkPrize");
  assert.equal(decoded.args[0], 4n);
  assert.equal(decoded.args[1], ACCOUNT);
  assert.equal(decoded.args[5].length, 32);
});

test("keeps pending intent for a pending exact identity and rejects foreign scopes before lookup", async () => {
  let lookedUp = 0;
  const pending = {
    chainId: 11155111,
    pool: POOL,
    account: ACCOUNT,
    drawId: 4n,
    action: "checkPrize",
    operation: identity(),
  };
  const { coordinator } = fixture({
    intentStore: { read: () => pending, save: async () => {}, clear: async () => {} },
    session: {
      address: ACCOUNT,
      prepareTransaction: async () => {
        throw new Error("unused");
      },
      lookupUserOperation: async () => {
        lookedUp += 1;
        return { state: "pending", operation: identity() };
      },
    },
  });
  assert.equal((await coordinator.reconcile(4n, pending)).state, "pending");
  await assert.rejects(
    coordinator.reconcile(4n, { ...pending, pool: "0x3333333333333333333333333333333333333333" }),
    /different account or draw/i,
  );
  assert.equal(lookedUp, 1);
});

test("clears exactly observed metadata on known non-submission and rejection", async () => {
  for (const failure of [
    new SafeUserOperationNotSubmittedError(identity()),
    new SafeUserOperationRejectedError(identity(), 4001),
  ]) {
    let saved = null,
      clears = 0;
    const { coordinator } = fixture({
      intentStore: {
        save: async (value) => {
          saved = value;
        },
        read: () => saved,
        clear: async (value) => {
          assert.equal(value.operation.userOperationHash, OP_HASH);
          clears += 1;
          saved = null;
        },
      },
      session: {
        address: ACCOUNT,
        prepareTransaction: async () => ({
          cancel() {},
          send: async (options) => {
            await options.onOperationPrepared(identity());
            throw failure;
          },
        }),
      },
    });
    const ready = await coordinator.prepare(await coordinator.review(4n));
    await assert.rejects(ready.confirm(), failure);
    assert.equal(clears, 1);
  }
});

test("aborting a ready review cancels it without invoking send", async () => {
  let cancelled = 0,
    sent = 0;
  const { coordinator } = fixture({
    session: {
      address: ACCOUNT,
      prepareTransaction: async () => ({
        cancel: () => {
          cancelled += 1;
        },
        send: async () => {
          sent += 1;
          return HASH;
        },
      }),
    },
  });
  const controller = new AbortController();
  const ready = await coordinator.prepare(
    await coordinator.review(4n, controller.signal),
    controller.signal,
  );
  controller.abort(new Error("account switched"));
  await assert.rejects(ready.confirm(), /account switched/);
  assert.equal(cancelled, 1);
  assert.equal(sent, 0);
});

test("cancels a late prepared transaction when its scope aborts", async () => {
  let resolve,
    cancelled = 0,
    started;
  const delayed = new Promise((next) => {
    resolve = next;
  });
  const began = new Promise((next) => {
    started = next;
  });
  const { coordinator } = fixture({
    session: {
      address: ACCOUNT,
      prepareTransaction: async () => {
        started();
        return delayed;
      },
    },
  });
  const controller = new AbortController();
  const preparing = coordinator.prepare(
    await coordinator.review(4n, controller.signal),
    controller.signal,
  );
  await began;
  controller.abort(new Error("scope changed"));
  resolve({
    cancel: () => {
      cancelled += 1;
    },
    send: async () => HASH,
  });
  await assert.rejects(preparing, /scope changed/);
  assert.equal(cancelled, 1);
});

test("retains checked immutable award when unrelated global winnings are consumed", async () => {
  const { coordinator, setChecked, setAward } = fixture({
    getProofClient: () => {
      throw new Error("archive unavailable");
    },
  });
  setChecked(true);
  setAward(HASH);
  assert.deepEqual(await coordinator.review(4n), { state: "checked", drawId: 4n, award: HASH });
});

test("archive negatives, outage, and malformed proof outcomes never prepare or send", async () => {
  for (const outcome of [
    { kind: "not-eligible" },
    { kind: "indexing", reason: "catching up" },
    { kind: "history-unavailable", reason: "archive" },
    { kind: "unavailable", reason: "tampered" },
  ]) {
    let prepared = 0;
    const { coordinator } = fixture({
      getProofClient: () => ({ getProof: async () => outcome }),
      session: {
        address: ACCOUNT,
        prepareTransaction: async () => {
          prepared += 1;
          throw new Error("must not prepare");
        },
      },
    });
    assert.equal((await coordinator.review(4n)).state, outcome.kind);
    assert.equal(prepared, 0);
  }
});

test("rejects mismatched lookup sender or hash without clearing the retained intent", async () => {
  for (const changed of [{ sender: POOL }, { userOperationHash: HASH }]) {
    let cleared = 0;
    const saved = {
      chainId: 11155111,
      pool: POOL,
      account: ACCOUNT,
      drawId: 4n,
      action: "checkPrize",
      operation: identity(),
    };
    const { coordinator } = fixture({
      intentStore: {
        read: () => saved,
        save: async () => {},
        clear: async () => {
          cleared += 1;
        },
      },
      session: {
        address: ACCOUNT,
        prepareTransaction: async () => {
          throw new Error("unused");
        },
        lookupUserOperation: async () => ({
          state: "pending",
          operation: { ...identity(), ...changed },
        }),
      },
    });
    await assert.rejects(coordinator.reconcile(4n, saved), /different operation/i);
    assert.equal(cleared, 0);
  }
});

test("inner failed and confirmed-but-unchecked receipts do not report a checked award", async () => {
  for (const receipt of [
    {
      state: "failed",
      operation: identity(),
      transactionHash: HASH,
      blockNumber: 10n,
      blockHash: HASH,
    },
    {
      state: "confirmed",
      operation: identity(),
      transactionHash: HASH,
      blockNumber: 10n,
      blockHash: HASH,
    },
  ]) {
    let checkedReads = 0;
    const saved = {
      chainId: 11155111,
      pool: POOL,
      account: ACCOUNT,
      drawId: 4n,
      action: "checkPrize",
      operation: identity(),
    };
    const { coordinator } = fixture({
      readChecked: async () => {
        checkedReads += 1;
        return false;
      },
      intentStore: { read: () => saved, save: async () => {}, clear: async () => {} },
      session: {
        address: ACCOUNT,
        prepareTransaction: async () => {
          throw new Error("unused");
        },
        lookupUserOperation: async () => receipt,
      },
    });
    if (receipt.state === "failed")
      assert.equal((await coordinator.reconcile(4n, saved)).state, "failed");
    else await assert.rejects(coordinator.reconcile(4n, saved), /not confirmed/i);
    assert.equal(checkedReads, receipt.state === "confirmed" ? 1 : 0);
  }
});

test("rejects a valid stored intent for a different requested draw before lookup", async () => {
  let lookup = 0;
  const saved = {
    chainId: 11155111,
    pool: POOL,
    account: ACCOUNT,
    drawId: 5n,
    action: "checkPrize",
    operation: identity(),
  };
  const { coordinator } = fixture({
    session: {
      address: ACCOUNT,
      prepareTransaction: async () => {
        throw new Error("unused");
      },
      lookupUserOperation: async () => {
        lookup += 1;
        return { state: "pending", operation: identity() };
      },
    },
  });
  await assert.rejects(coordinator.reconcile(4n, saved), /different account or draw/i);
  assert.equal(lookup, 0);
});

test("pinned checked and award adapter calls reject once without latest fallback", async () => {
  let calls = 0;
  const reader = createViemPrizeChainReader(
    {
      request: async () => {
        calls += 1;
        throw new Error("canonical reorg");
      },
    },
    POOL,
  );
  await assert.rejects(reader.readChecked(4n, ACCOUNT, { blockHash: HASH }), /canonical reorg/);
  await assert.rejects(reader.readAward(4n, ACCOUNT, { blockHash: HASH }), /canonical reorg/);
  assert.equal(calls, 2);
});

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

test("forwards the prepared public operation before confirmation settles", async () => {
  const { coordinator } = fixture();
  const review = await coordinator.review(4n);
  const ready = await coordinator.prepare(review);
  let observed;
  await ready.confirm({
    onOperationPrepared: (operation) => {
      observed = operation;
    },
  });
  assert.equal(observed.sender, ACCOUNT);
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
