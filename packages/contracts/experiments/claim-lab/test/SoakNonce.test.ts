import { expect } from "chai";
import { nextResearchNonce } from "../soak/Nonce";
describe("Soak nonce allocation under lagging RPC responses", function () {
  const sender = "0x0000000000000000000000000000000000000001";
  it("never reuses a locally signed nonce when pending RPC state lags broadcast", function () {
    expect(nextResearchNonce([{sender,nonce:785}],sender,785)).to.equal(786);
    expect(nextResearchNonce([{sender,nonce:785},{sender,nonce:786}],sender,785)).to.equal(787);
  });
  it("honors a newer RPC nonce and keeps different signers independent", function () {
    expect(nextResearchNonce([{sender,nonce:785}],sender,790)).to.equal(790);
    expect(nextResearchNonce([{sender,nonce:785}],"0x0000000000000000000000000000000000000002",3)).to.equal(3);
  });
});
