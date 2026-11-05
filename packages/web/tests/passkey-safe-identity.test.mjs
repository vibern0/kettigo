import assert from "node:assert/strict";
import test from "node:test";

import { getAddress } from "viem";

import { getSafeUserOperationIdentity } from "../src/lib/passkey-safe.ts";

const SAFE_ADDRESS = getAddress("0x00000000000000000000000000000000000000bb");

test("derives the canonical EntryPoint v0.7 hash from all final signed operation fields", () => {
  const identity = getSafeUserOperationIdentity({
    sender: SAFE_ADDRESS,
    nonce: 7n,
    factory: getAddress("0x00000000000000000000000000000000000000f1"),
    factoryData: "0x1234",
    callData: "0x5678",
    callGasLimit: 55_555n,
    verificationGasLimit: 66_666n,
    preVerificationGas: 77_777n,
    maxFeePerGas: 88_888n,
    maxPriorityFeePerGas: 99_999n,
    paymaster: getAddress("0x00000000000000000000000000000000000000f2"),
    paymasterData: "0xabcd",
    paymasterVerificationGasLimit: 12_345n,
    paymasterPostOpGasLimit: 23_456n,
    signature: "0xdeadbeef",
  });

  assert.deepEqual(identity, {
    chainId: 11155111,
    entryPoint: getAddress("0x0000000071727De22E5E9d8BAf0edAc6f37da032"),
    sender: SAFE_ADDRESS,
    userOperationHash: "0x2384393c9cca16213837b028ad53417f4787c3a323e8d82d534f7f2151d3d77b",
  });
  assert.equal(Object.isFrozen(identity), true);
});
