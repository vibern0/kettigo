import { expect } from "chai";
import { FailureLatch } from "../soak/Failure";
describe("First research failure preservation",function(){
  it("permits work before failure and throws the original failure after stopping",function(){
    const latch=new FailureLatch(),root=Object.assign(new Error("RPC broadcast interrupted"),{code:"NETWORK_ERROR"});
    expect(latch.stopped).to.equal(false);latch.throwIfStopped();
    expect(latch.capture(root)).to.equal(root);expect(latch.stopped).to.equal(true);
    try{latch.throwIfStopped();throw new Error("Expected stop")}catch(e){expect(e).to.equal(root)}
  });
  it("keeps the first failure when later queued operations also fail",function(){
    const latch=new FailureLatch(),root=new Error("original broadcast failure");latch.capture(root);
    expect(latch.capture(new Error("Runner stopped after a failed operation"))).to.equal(root);
  });
  it("reports the original send error even when an earlier-index batch task observes the stop later",async function(){
    const latch=new FailureLatch(),root=new Error("original send failure");
    const queue=Promise.resolve().then(()=>{throw latch.capture(root)});
    const blocked=queue.catch(()=>{}).then(()=>{latch.throwIfStopped()});
    const results=await Promise.allSettled([blocked,queue]);
    expect(results.every(r=>r.status==="rejected"&&r.reason===root)).to.equal(true);
  });
});
