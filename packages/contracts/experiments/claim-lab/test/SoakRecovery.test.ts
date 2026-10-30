import { expect } from "chai";
import { Wallet, Transaction, keccak256 } from "ethers";
import { recoverSignedRecord } from "../soak/Recovery";

describe("Soak orphan signed transaction recovery", function () {
  const signer = Wallet.createRandom(), recipient = Wallet.createRandom().address;
  const allowed = { contracts: [], wallets: [recipient], maxGasPrice: 100000n };
  const request = { to: recipient, chainId: 11155111n, value: 9n, gasPrice: 100000n, gasLimit: 21000n, nonce: 17, type: 0 };
  it("recovers the original hash, nonce and full fee reservation without another signature", async function () {
    const raw = await signer.signTransaction(request), r = recoverSignedRecord(raw, [signer.address], allowed);
    expect(r).to.deep.equal({ hash: keccak256(raw), sender: signer.address, nonce: 17, status: "signed", quotedFeeWei: "2100000000", valueWei: "9" });
  });
  it("rejects unsigned or unknown-signer files", async function () {
    const unsigned = Transaction.from(request).unsignedSerialized;
    expect(() => recoverSignedRecord(unsigned, [signer.address], allowed)).to.throw();
    const raw = await signer.signTransaction(request);
    expect(() => recoverSignedRecord(raw, [], allowed)).to.throw(/signer/i);
  });
  it("applies Sepolia, gas and recipient policy to orphan files", async function () {
    for (const changes of [{ chainId: 1n }, { gasPrice: 100001n }, { to: Wallet.createRandom().address }]) {
      const raw = await signer.signTransaction({ ...request, ...changes });
      expect(() => recoverSignedRecord(raw, [signer.address], allowed)).to.throw();
    }
  });
});
