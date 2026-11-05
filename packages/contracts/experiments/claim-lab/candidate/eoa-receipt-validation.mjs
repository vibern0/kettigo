export function validStoredEoaReceipt(receipt, intent, validHash, uint) {
  return (
    Boolean(receipt) &&
    validHash(receipt.hash) &&
    receipt.hash === intent.signed.hash &&
    [0, 1].includes(receipt.status) &&
    receipt.from === intent.sender &&
    receipt.to === intent.to &&
    receipt.input === intent.input &&
    receipt.nonce === intent.nonce &&
    receipt.chainId === 11155111 &&
    uint.test(receipt.feeWei ?? "") &&
    BigInt(receipt.feeWei) <= BigInt(intent.maxFeeWei)
  );
}
