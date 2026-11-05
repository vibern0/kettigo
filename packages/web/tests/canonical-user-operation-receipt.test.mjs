import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { encodeAbiParameters, encodeEventTopics, getAddress } from "viem";
import { entryPoint07Abi, entryPoint07Address } from "viem/account-abstraction";

import {
  SafeUserOperationIntegrityError,
  lookupCanonicalUserOperationReceipt,
} from "../src/lib/canonical-user-operation-receipt.ts";

const ENTRY_POINT = getAddress(entryPoint07Address);
const SENDER = getAddress("0x00000000000000000000000000000000000000bb");
const OTHER = getAddress("0x00000000000000000000000000000000000000cc");
const OPERATION_HASH = `0x${"11".repeat(32)}`;
const TRANSACTION_HASH = `0x${"22".repeat(32)}`;
const BLOCK_HASH = `0x${"33".repeat(32)}`;
const operation = Object.freeze({
  chainId: 11155111,
  entryPoint: ENTRY_POINT,
  sender: SENDER,
  userOperationHash: OPERATION_HASH,
});

function userOperationLog({
  address = ENTRY_POINT,
  sender = SENDER,
  hash = OPERATION_HASH,
  success = true,
  transactionHash = TRANSACTION_HASH,
  blockHash = BLOCK_HASH,
  blockNumber = 42n,
} = {}) {
  return {
    address,
    topics: encodeEventTopics({
      abi: entryPoint07Abi,
      eventName: "UserOperationEvent",
      args: {
        userOpHash: hash,
        sender,
        paymaster: "0x0000000000000000000000000000000000000000",
        nonce: 0n,
        success,
        actualGasCost: 1n,
        actualGasUsed: 1n,
      },
    }),
    data: encodeAbiParameters(
      [{ type: "uint256" }, { type: "bool" }, { type: "uint256" }, { type: "uint256" }],
      [0n, success, 1n, 1n],
    ),
    transactionHash,
    blockHash,
    blockNumber,
  };
}

function dependencies(overrides = {}) {
  const calls = { bundler: 0, receipt: 0, block: 0 };
  return {
    calls,
    dependencies: {
      async getUserOperationReceipt() {
        calls.bundler += 1;
        return {
          success: true,
          userOpHash: OPERATION_HASH,
          sender: SENDER,
          receipt: { transactionHash: TRANSACTION_HASH },
        };
      },
      async getTransactionReceipt() {
        calls.receipt += 1;
        return {
          transactionHash: TRANSACTION_HASH,
          status: "success",
          blockHash: BLOCK_HASH,
          blockNumber: 42n,
          logs: [userOperationLog()],
        };
      },
      async getBlock() {
        calls.block += 1;
        return { hash: BLOCK_HASH, number: 42n };
      },
      ...overrides,
    },
  };
}

async function outcome(task) {
  try {
    return { value: await task() };
  } catch (error) {
    return { error };
  }
}

test("confirms its real EntryPoint event while ignoring malformed lookalikes from another emitter", async () => {
  const { dependencies: rpc } = dependencies({
    async getTransactionReceipt() {
      return {
        transactionHash: TRANSACTION_HASH,
        status: "success",
        blockHash: BLOCK_HASH,
        blockNumber: 42n,
        logs: [
          userOperationLog({ hash: `0x${"44".repeat(32)}`, sender: OTHER }),
          { address: OTHER, topics: userOperationLog().topics, data: "0xdeadbeef" },
          userOperationLog(),
        ],
      };
    },
  });
  assert.deepEqual(await lookupCanonicalUserOperationReceipt(rpc, operation), {
    state: "confirmed",
    operation,
    transactionHash: TRANSACTION_HASH,
    blockNumber: 42n,
    blockHash: BLOCK_HASH,
  });
});

test("marks a canonical event with inner false as failed despite outer receipt success", async () => {
  const { dependencies: rpc } = dependencies({
    async getUserOperationReceipt() {
      return {
        success: false,
        userOpHash: OPERATION_HASH,
        sender: SENDER,
        receipt: { transactionHash: TRANSACTION_HASH },
      };
    },
    async getTransactionReceipt() {
      return {
        transactionHash: TRANSACTION_HASH,
        status: "success",
        blockHash: BLOCK_HASH,
        blockNumber: 42n,
        logs: [userOperationLog({ success: false })],
      };
    },
  });
  assert.equal((await lookupCanonicalUserOperationReceipt(rpc, operation)).state, "failed");
});

test("rejects malformed identity before any RPC read", async () => {
  const { dependencies: rpc, calls } = dependencies();
  const result = await outcome(() =>
    lookupCanonicalUserOperationReceipt(rpc, { ...operation, chainId: 1 }),
  );
  assert.ok(result.error instanceof SafeUserOperationIntegrityError);
  assert.deepEqual(calls, { bundler: 0, receipt: 0, block: 0 });
});

test("classifies untrusted wire variants as integrity errors", async () => {
  const variants = [
    { success: "false" },
    { userOpHash: `0x${"aa".repeat(32)}` },
    { sender: OTHER },
    { receipt: { transactionHash: "0x1234" } },
  ];
  for (const change of variants) {
    const { dependencies: rpc } = dependencies({
      async getUserOperationReceipt() {
        return {
          success: true,
          userOpHash: OPERATION_HASH,
          sender: SENDER,
          receipt: { transactionHash: TRANSACTION_HASH },
          ...change,
        };
      },
    });
    const result = await outcome(() => lookupCanonicalUserOperationReceipt(rpc, operation));
    assert.ok(result.error instanceof SafeUserOperationIntegrityError, JSON.stringify(change));
  }
});

test("returns pending for unavailable canonical evidence", async () => {
  const variants = [
    { name: "missing receipt", getTransactionReceipt: async () => null },
    {
      name: "reverted outer receipt",
      getTransactionReceipt: async () => ({
        transactionHash: TRANSACTION_HASH,
        status: "reverted",
        blockHash: BLOCK_HASH,
        blockNumber: 42n,
        logs: [],
      }),
    },
    {
      name: "wrong-emitter-only",
      getTransactionReceipt: async () => ({
        transactionHash: TRANSACTION_HASH,
        status: "success",
        blockHash: BLOCK_HASH,
        blockNumber: 42n,
        logs: [userOperationLog({ address: OTHER })],
      }),
    },
    { name: "orphan block", getBlock: async () => ({ hash: `0x${"99".repeat(32)}`, number: 42n }) },
  ];
  for (const variant of variants) {
    const { dependencies: rpc } = dependencies(variant);
    const receipt = await lookupCanonicalUserOperationReceipt(rpc, operation);
    assert.equal(receipt.state, "pending", variant.name);
  }
});

test("rejects authoritative contradictory or malformed EntryPoint events", async () => {
  const variants = [
    userOperationLog({ sender: OTHER }),
    [userOperationLog(), userOperationLog()],
    { ...userOperationLog(), data: "0xdeadbeef" },
    userOperationLog({ transactionHash: `0x${"77".repeat(32)}` }),
  ];
  for (const logs of variants) {
    const { dependencies: rpc } = dependencies({
      async getTransactionReceipt() {
        return {
          transactionHash: TRANSACTION_HASH,
          status: "success",
          blockHash: BLOCK_HASH,
          blockNumber: 42n,
          logs: Array.isArray(logs) ? logs : [logs],
        };
      },
    });
    const result = await outcome(() => lookupCanonicalUserOperationReceipt(rpc, operation));
    assert.ok(result.error instanceof SafeUserOperationIntegrityError);
  }
});

test("rejects supplied malformed location metadata on an authoritative event", async () => {
  for (const location of [{ transactionHash: "" }, { blockHash: "0x1234" }]) {
    const { dependencies: rpc } = dependencies({
      async getTransactionReceipt() {
        return {
          transactionHash: TRANSACTION_HASH,
          status: "success",
          blockHash: BLOCK_HASH,
          blockNumber: 42n,
          logs: [{ ...userOperationLog(), ...location }],
        };
      },
    });
    const result = await outcome(() => lookupCanonicalUserOperationReceipt(rpc, operation));
    assert.ok(result.error instanceof SafeUserOperationIntegrityError, JSON.stringify(location));
  }
});

test("rejects malformed outer receipt status and canonical block shapes", async () => {
  const cases = [
    {
      name: "unknown receipt status",
      getTransactionReceipt: async () => ({
        transactionHash: TRANSACTION_HASH,
        status: "unknown",
        blockHash: BLOCK_HASH,
        blockNumber: 42n,
        logs: [],
      }),
    },
    {
      name: "block number has the wrong type",
      getBlock: async () => ({ hash: BLOCK_HASH, number: "42" }),
    },
    { name: "block hash is missing", getBlock: async () => ({ number: 42n }) },
  ];
  for (const testCase of cases) {
    const { dependencies: rpc } = dependencies(testCase);
    const result = await outcome(() => lookupCanonicalUserOperationReceipt(rpc, operation));
    assert.ok(result.error instanceof SafeUserOperationIntegrityError, testCase.name);
  }
});

test("returns pending after the shared deadline without advancing to later RPC stages", async () => {
  const never = () => new Promise(() => {});
  const { dependencies: rpc, calls } = dependencies({ getUserOperationReceipt: never });
  const receipt = await lookupCanonicalUserOperationReceipt(rpc, operation, { timeoutMs: 20 });
  assert.equal(receipt.state, "pending");
  assert.deepEqual(calls, { bundler: 0, receipt: 0, block: 0 });
});

test("contains provider exceptions and timeouts at every evidence stage", async () => {
  const stages = ["getUserOperationReceipt", "getTransactionReceipt", "getBlock"];
  for (const stage of stages) {
    const exceptional = dependencies({
      async [stage]() {
        throw new Error("provider unavailable");
      },
    });
    assert.equal(
      (await lookupCanonicalUserOperationReceipt(exceptional.dependencies, operation)).state,
      "pending",
      `${stage} exception`,
    );

    const stalled = dependencies({
      [stage]: () => new Promise(() => {}),
    });
    assert.equal(
      (
        await lookupCanonicalUserOperationReceipt(stalled.dependencies, operation, {
          timeoutMs: 20,
        })
      ).state,
      "pending",
      `${stage} timeout`,
    );
  }
});

test("propagates caller abort during every evidence stage without making later calls", async () => {
  const stages = ["getUserOperationReceipt", "getTransactionReceipt", "getBlock"];
  for (const stage of stages) {
    const controller = new globalThis.AbortController();
    let started = 0;
    const { dependencies: rpc, calls } = dependencies({
      [stage]: () => {
        started += 1;
        return new Promise(() => {});
      },
    });
    const lookup = lookupCanonicalUserOperationReceipt(rpc, operation, {
      signal: controller.signal,
    });
    await delay(0);
    controller.abort();
    await assert.rejects(lookup, (error) => error?.name === "AbortError", stage);
    assert.equal(started, 1, `${stage} started`);
    assert.equal(
      calls.bundler + calls.receipt + calls.block,
      stages.indexOf(stage),
      `${stage} later calls`,
    );
  }
});

test("preserves caller cancellation as AbortError and makes no calls when already aborted", async () => {
  const controller = new globalThis.AbortController();
  controller.abort();
  const { dependencies: rpc, calls } = dependencies();
  await assert.rejects(
    lookupCanonicalUserOperationReceipt(rpc, operation, { signal: controller.signal }),
    (error) => error?.name === "AbortError",
  );
  assert.deepEqual(calls, { bundler: 0, receipt: 0, block: 0 });
});
