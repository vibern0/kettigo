import { expect } from "chai";
import { rejects } from "node:assert/strict";
import { confirmedUserProof } from "../soak/UserProof";
describe("Confirmed user-decryption permission recovery", function () {
  const user="0x0000000000000000000000000000000000000001",contract="0x0000000000000000000000000000000000000002",handle="0x"+"ab".repeat(32);
  const error=(message:string,code="NOT_ENTITLED")=>Object.assign(new Error("Decryption failed"),{code,cause:new Error(message+"\nVersion: @fhevm/sdk@0.13.2")});
  it("recovers the exact user or contract latest-state ACL mismatch after both confirmed grants",async function(){
    for(const e of [error(`User ${user} is not authorized to decrypt handle ${handle}!`),error(`Dapp contract ${contract} is not authorized to user decrypt handle ${handle}!`,"DECRYPTION_FAILED")]){
      let calls=0;const delays:number[]=[];
      expect(await confirmedUserProof(user,contract,[handle],async()=>[true,true],async()=>{if(++calls===1)throw e;return 11n},async ms=>{delays.push(ms)},()=>{})).to.equal(11n);
      expect(calls).to.equal(2);expect(delays).to.deep.equal([1000]);
    }
  });
  it("does not attempt decryption when either confirmed grant is absent",async function(){
    for(const grants of [[false,true],[true,false],[false,false],[]]){
      let calls=0;await rejects(confirmedUserProof(user,contract,[handle],async()=>grants,async()=>{calls++},async()=>{},()=>{}),/Confirmed user\/contract decryption permission missing/);expect(calls).to.equal(0);
    }
  });
  it("does not retry a different handle, account, contract or unrelated entitlement error",async function(){
    for(const e of [error(`User ${contract} is not authorized to decrypt handle ${handle}!`),error(`User ${user} is not authorized to decrypt handle 0xdead!`),error(`Dapp contract ${user} is not authorized to user decrypt handle ${handle}!`),error("Signature invalid")]){
      let calls=0,waits=0;await rejects(confirmedUserProof(user,contract,[handle],async()=>[true,true],async()=>{calls++;throw e},async()=>{waits++},()=>{}));expect(calls).to.equal(1);expect(waits).to.equal(0);
    }
  });
  it("stops persistent mismatches after six attempts",async function(){
    const e=error(`User ${user} is not authorized to decrypt handle ${handle}!`);let calls=0;const delays:number[]=[];
    await rejects(confirmedUserProof(user,contract,[handle],async()=>[true,true],async()=>{calls++;throw e},async ms=>{delays.push(ms)},()=>{}));
    expect(calls).to.equal(6);expect(delays).to.deep.equal([1000,2000,4000,8000,16000]);
  });
});
