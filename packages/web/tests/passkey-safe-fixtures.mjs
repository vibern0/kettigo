import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { EthSafeSignature } from "@safe-global/protocol-kit";
import { PimlicoFeeEstimator } from "@safe-global/relay-kit";
import {
  encodeAbiParameters,
  encodeEventTopics,
  getAddress,
  hashTypedData,
  RpcRequestError,
} from "viem";
import { entryPoint07Abi, entryPoint07Address } from "viem/account-abstraction";

export {
  assert,
  test,
  delay,
  EthSafeSignature,
  PimlicoFeeEstimator,
  encodeAbiParameters,
  encodeEventTopics,
  getAddress,
  hashTypedData,
  RpcRequestError,
  entryPoint07Abi,
  entryPoint07Address,
};

export const SAFE_ADDRESS = getAddress("0x00000000000000000000000000000000000000bb");
export const VERIFIER_ADDRESS = getAddress("0x00000000000000000000000000000000000000aa");
export const SHARED_SIGNER_ADDRESS = getAddress("0x94a4F6affBd8975951142c3999aEAB7ecee555c2");
export const RAW_ID = "aabbccdd";
export const COORDINATES = {
  x: `0x${"11".repeat(32)}`,
  y: `0x${"22".repeat(32)}`,
};

export function createStorage() {
  const values = new Map();
  return {
    getItem(key) {
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
    removeItem(key) {
      values.delete(key);
    },
  };
}

export function createLocks() {
  const held = new Set();
  return {
    async request(name, options, callback) {
      assert.deepEqual(options, { mode: "exclusive", ifAvailable: true });
      if (held.has(name)) return callback(null);
      held.add(name);
      try {
        return await callback({ name });
      } finally {
        held.delete(name);
      }
    },
  };
}

export function finalUserOperation(sender = SAFE_ADDRESS) {
  return {
    sender,
    nonce: 0n,
    callData: "0x",
    callGasLimit: 1n,
    verificationGasLimit: 2n,
    preVerificationGas: 3n,
    maxFeePerGas: 4n,
    maxPriorityFeePerGas: 5n,
    signature: "0x",
  };
}

export function relay(address = SAFE_ADDRESS, safeProvider) {
  const signatures = new Map();
  const operation = {
    signatures,
    addSignature(signature) {
      signatures.set(signature.signer, signature);
    },
    getUserOperation() {
      return finalUserOperation(address);
    },
  };
  return {
    protocolKit: {
      async getAddress() {
        return address;
      },
      ...(safeProvider
        ? {
            getSafeProvider() {
              return safeProvider;
            },
          }
        : {}),
    },
    async createTransaction() {
      return operation;
    },
    async signSafeOperation(operation) {
      operation.addSignature(new EthSafeSignature(SHARED_SIGNER_ADDRESS, "0x1234"));
      return operation;
    },
    async executeTransaction() {
      return "0x60a9c26f9c932173953974fad9377bd05b94e7af3f01dfdb93482ac70b4265a5";
    },
    async getUserOperationReceipt() {
      return {
        success: true,
        userOpHash: "0x60a9c26f9c932173953974fad9377bd05b94e7af3f01dfdb93482ac70b4265a5",
        sender: address,
        receipt: { transactionHash: `0x${"44".repeat(32)}` },
      };
    },
  };
}

export function dependencies(overrides = {}) {
  return {
    pendingOperationStorage: createStorage(),
    pendingOperationLocks: createLocks(),
    async createCredential() {
      return { id: "credential" };
    },
    async extractPasskeyData() {
      return { rawId: RAW_ID, coordinates: COORDINATES };
    },
    getVerifierAddress(chainId) {
      assert.equal(chainId, "11155111");
      return VERIFIER_ADDRESS;
    },
    async initRelay() {
      return relay();
    },
    async getCode() {
      return "0x";
    },
    async getTransactionReceipt() {
      const userOperationHash =
        "0x60a9c26f9c932173953974fad9377bd05b94e7af3f01dfdb93482ac70b4265a5";
      const topics = encodeEventTopics({
        abi: entryPoint07Abi,
        eventName: "UserOperationEvent",
        args: {
          userOpHash: userOperationHash,
          sender: SAFE_ADDRESS,
          paymaster: "0x0000000000000000000000000000000000000000",
          nonce: 0n,
          success: true,
          actualGasCost: 1n,
          actualGasUsed: 1n,
        },
      });
      const blockHash = `0x${"55".repeat(32)}`;
      return {
        transactionHash: `0x${"44".repeat(32)}`,
        status: "success",
        blockHash,
        blockNumber: 42n,
        logs: [
          {
            address: getAddress(entryPoint07Address),
            topics,
            data: encodeAbiParameters(
              [{ type: "uint256" }, { type: "bool" }, { type: "uint256" }, { type: "uint256" }],
              [0n, true, 1n, 1n],
            ),
            blockHash,
            blockNumber: 42n,
          },
        ],
      };
    },
    async getBlock() {
      return { hash: `0x${"55".repeat(32)}`, number: 42n };
    },
    async getCredential() {
      return { id: "credential" };
    },
    async sleep() {},
    ...overrides,
  };
}
