import { expect } from "chai";
import { Interface, ZeroHash } from "ethers";
import { admissionFromReceipt } from "../soak/Admission";
describe("Admission from confirmed deposit receipts", function () {
  const pool="0x0000000000000000000000000000000000000001",user="0x0000000000000000000000000000000000000002";
  const iface=new Interface(["event AdmissionRequested(address indexed account,uint256 nonce,bytes32 marker)"]);
  const marker="0x"+"ab".repeat(32);
  const log=(account=user,handle=marker,address=pool)=>({address,...iface.encodeEventLog(iface.getEvent("AdmissionRequested")!,[account,17,handle])});
  it("uses the receipt marker and nonce without consulting a lagging latest-state getter", function () {
    expect(admissionFromReceipt([log()],pool,user)).to.deep.equal({nonce:17n,marker});
  });
  it("ignores another emitter or beneficiary and rejects an absent request", function () {
    expect(()=>admissionFromReceipt([log(user,marker,user)],pool,user)).to.throw(/request/i);
    expect(()=>admissionFromReceipt([log(pool)],pool,user)).to.throw(/request/i);
    expect(()=>admissionFromReceipt([],pool,user)).to.throw(/request/i);
  });
  it("rejects an uninitialized marker before calling the FHE service", function () {
    expect(()=>admissionFromReceipt([log(user,ZeroHash)],pool,user)).to.throw(/marker/i);
  });
});
