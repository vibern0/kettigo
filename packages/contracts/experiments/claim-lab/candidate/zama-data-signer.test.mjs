import assert from "node:assert/strict";
import test from "node:test";

import { CandidateDataSigner, createCandidateDataSdk } from "./zama-data-signer.ts";

test("data signer checksums its fixed Sepolia account and delegates only typed-data signing", async () => {
  const calls = [];
  const signer = new CandidateDataSigner(
    "0x1111111111111111111111111111111111111111",
    async (data) => {
      calls.push(data);
      return "0x" + "2".repeat(130);
    },
  );
  const account = signer.requireWalletAccount("encrypt");
  assert.equal(account.address, "0x1111111111111111111111111111111111111111");
  assert.equal(account.chainId, 11155111);
  const typedData = { domain: {}, types: {}, primaryType: "Permit", message: {} };
  assert.equal(await signer.signTypedData(typedData), "0x" + "2".repeat(130));
  assert.deepEqual(calls, [typedData]);
});

test("data signer rejects every SDK write route", async () => {
  const signer = new CandidateDataSigner(
    "0x1111111111111111111111111111111111111111",
    async () => "0x",
  );
  await assert.rejects(signer.writeContract({}), /cannot submit transactions/);
});

test("SDK factory accepts an injected ethers provider without sending or encrypting", () => {
  const sdk = createCandidateDataSdk({
    address: "0x1111111111111111111111111111111111111111",
    typedDataSigner: async () => "0x",
    provider: {},
    network: "http://offline.invalid",
  });
  assert.equal(sdk.signer?.requireWalletAccount("test").chainId, 11155111);
});
