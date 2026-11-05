import { getAddress, isAddress } from "ethers";

const HASH = /^0x[0-9a-fA-F]{64}$/;
const HEX = /^0x(?:[0-9a-fA-F]{2})*$/;
const fail = (message) => {
  throw new Error(`ethers v6 EOA provider: ${message}`);
};
const same = (left, right) => String(left).toLowerCase() === String(right).toLowerCase();
const address = (value, label) => {
  if (!isAddress(value)) fail(`invalid ${label}`);
  return getAddress(value);
};
function transaction(value, hash) {
  if (
    !value ||
    !same(value.hash, hash) ||
    Number(value.chainId) !== 11155111 ||
    !Number.isSafeInteger(value.nonce) ||
    value.nonce < 0 ||
    (value.to !== null && !isAddress(value.to)) ||
    typeof value.data !== "string" ||
    !HEX.test(value.data)
  )
    fail("transaction mismatch");
  return {
    hash: value.hash,
    chainId: 11155111,
    from: address(value.from, "transaction sender"),
    to: value.to === null ? null : getAddress(value.to),
    data: value.data,
    nonce: value.nonce,
    blockHash: value.blockHash,
    blockNumber: value.blockNumber,
  };
}
export class EthersV6EoaProviderAdapter {
  constructor(provider) {
    if (!provider) fail("provider required");
    this.provider = provider;
  }
  getNetwork() {
    return this.provider.getNetwork();
  }
  getTransactionCount(actor, blockTag) {
    return this.provider.getTransactionCount(actor, blockTag);
  }
  async sendRawTransaction(raw) {
    const response = await this.provider.broadcastTransaction(raw);
    if (!response || typeof response.hash !== "string" || !HASH.test(response.hash))
      fail("broadcast response mismatch");
    return response.hash;
  }
  async getTransaction(hash) {
    if (typeof hash !== "string" || !HASH.test(hash)) fail("invalid hash");
    const found = await this.provider.getTransaction(hash);
    return found === null ? null : transaction(found, hash);
  }
  getBlock(blockNumber) {
    return this.provider.getBlock(blockNumber);
  }
  async getTransactionReceipt(hash) {
    if (typeof hash !== "string" || !HASH.test(hash)) fail("invalid hash");
    const receipt = await this.provider.getTransactionReceipt(hash);
    if (receipt === null) return null;
    const tx = await this.getTransaction(hash);
    if (!tx || receipt.blockNumber == null || receipt.blockHash == null) fail("pending receipt");
    const block = await this.getBlock(receipt.blockNumber);
    if (
      !block ||
      !same(receipt.hash, hash) ||
      !same(receipt.blockHash, block.hash) ||
      tx.blockHash !== receipt.blockHash ||
      tx.blockNumber !== receipt.blockNumber ||
      address(receipt.from, "receipt sender") !== tx.from ||
      (receipt.to === null ? null : getAddress(receipt.to)) !== tx.to
    )
      fail("receipt mismatch");
    return {
      hash,
      status: receipt.status,
      gasUsed: BigInt(receipt.gasUsed),
      gasPrice: BigInt(receipt.gasPrice),
      from: tx.from,
      to: tx.to,
      nonce: tx.nonce,
      blockHash: receipt.blockHash,
      blockNumber: receipt.blockNumber,
    };
  }
}
