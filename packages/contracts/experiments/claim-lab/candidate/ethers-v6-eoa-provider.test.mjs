import assert from "node:assert/strict";
import test from "node:test";
import { getAddress } from "ethers";

import { EthersV6EoaProviderAdapter } from "./ethers-v6-eoa-provider.mjs";

const HASH = `0x${"ab".repeat(32)}`;
const BLOCK = `0x${"cd".repeat(32)}`;
const FROM = getAddress("0x1111111111111111111111111111111111111111");
const TO = getAddress("0x2222222222222222222222222222222222222222");
function provider(overrides = {}) {
  const tx = {
    hash: HASH,
    chainId: 11155111n,
    from: FROM,
    to: TO,
    data: "0x1234",
    nonce: 7,
    blockHash: BLOCK,
    blockNumber: 9,
  };
  const receipt = {
    hash: HASH,
    status: 1,
    gasUsed: 21_000n,
    gasPrice: 3n,
    from: FROM,
    to: TO,
    blockHash: BLOCK,
    blockNumber: 9,
  };
  return {
    getNetwork: async () => ({ chainId: 11155111n }),
    getTransactionCount: async () => 0,
    broadcastTransaction: async () => ({ hash: HASH }),
    getTransaction: async () => tx,
    getTransactionReceipt: async () => receipt,
    getBlock: async () => ({ hash: BLOCK, number: 9 }),
    ...overrides,
  };
}
test("normalizes an ethers receipt nonce from the exact canonical transaction", async () => {
  const adapter = new EthersV6EoaProviderAdapter(provider());
  const receipt = await adapter.getTransactionReceipt(HASH);
  assert.equal(receipt.nonce, 7);
  assert.equal(receipt.gasUsed * receipt.gasPrice, 63_000n);
});
test("adapts the ethers v6 broadcast response to the durable sender hash", async () => {
  const adapter = new EthersV6EoaProviderAdapter(provider());
  assert.equal(await adapter.sendRawTransaction("0x1234"), HASH);
  await assert.rejects(
    new EthersV6EoaProviderAdapter(
      provider({ broadcastTransaction: async () => ({}) }),
    ).sendRawTransaction("0x"),
  );
});
test("keeps null receipt unresolved and rejects mismatched transaction or canonical block", async () => {
  assert.equal(
    await new EthersV6EoaProviderAdapter(
      provider({ getTransactionReceipt: async () => null }),
    ).getTransactionReceipt(HASH),
    null,
  );
  await assert.rejects(
    new EthersV6EoaProviderAdapter(
      provider({
        getTransaction: async () => ({
          hash: `0x${"ef".repeat(32)}`,
          chainId: 11155111n,
          from: FROM,
          to: TO,
          data: "0x1234",
          nonce: 7,
          blockHash: BLOCK,
          blockNumber: 9,
        }),
      }),
    ).getTransactionReceipt(HASH),
  );
  await assert.rejects(
    new EthersV6EoaProviderAdapter(
      provider({ getBlock: async () => ({ hash: `0x${"ef".repeat(32)}` }) }),
    ).getTransactionReceipt(HASH),
  );
  await assert.rejects(
    new EthersV6EoaProviderAdapter(
      provider({ getBlock: async () => ({ hash: BLOCK, number: 10 }) }),
    ).getTransactionReceipt(HASH),
  );
});
