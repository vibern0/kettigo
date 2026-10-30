import { expect } from "chai";
import { rejects } from "node:assert/strict";
import { indexedRead } from "../soak/RpcRead";
describe("Confirmed-block RPC index readiness",function(){
  it("retries the observed confirmed-block-not-found RPC response",async function(){
    let calls=0;const waits:number[]=[];const retries:number[]=[];
    const result=await indexedRead(async()=>{
      if(++calls===1)throw Object.assign(new Error("block not found: 0xb7507f"),{code:-32001});
      return true;
    },async ms=>{waits.push(ms)},attempt=>{retries.push(attempt)});
    expect(result).to.equal(true);expect(calls).to.equal(2);expect(waits).to.deep.equal([1000]);expect(retries).to.deep.equal([1]);
  });
  it("retries the observed one-block log index lag without changing the requested snapshot",async function(){
    let calls=0;const waits:number[]=[];const value=await indexedRead(async()=>{if(++calls<3)throw Object.assign(new Error("block range extends beyond current head block: requested 9, head 8"),{code:-32602});return 9},async ms=>{waits.push(ms)},()=>{});
    expect(value).to.equal(9);expect(calls).to.equal(3);expect(waits).to.deep.equal([1000,2000]);
  });
  it("does not retry unrelated invalid arguments or integrity errors",async function(){
    for(const error of[Object.assign(new Error("invalid filter"),{code:-32602}),Object.assign(new Error("resource unavailable"),{code:-32001}),new Error("Canonical receipt changed")]){
      let calls=0;await rejects(indexedRead(async()=>{calls++;throw error},async()=>{},()=>{}));expect(calls).to.equal(1);
    }
  });
  it("stops persistent index lag after six attempts",async function(){
    let calls=0;const waits:number[]=[];await rejects(indexedRead(async()=>{calls++;throw Object.assign(new Error("header not found"),{code:-32000})},async ms=>{waits.push(ms)},()=>{}),/header not found/);
    expect(calls).to.equal(6);expect(waits).to.deep.equal([1000,2000,4000,8000,16000]);
  });
});
