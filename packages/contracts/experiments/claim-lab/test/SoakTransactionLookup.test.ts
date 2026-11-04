import { expect } from "chai";
import { rejects } from "node:assert/strict";
import { knownTransaction } from "../soak/TransactionLookup";
describe("Exact signed transaction lookup recovery",function(){
  const hash="0x"+"ab".repeat(32),tx={hash,nonce:53};
  it("returns a visible transaction without rebroadcasting",async function(){
    let broadcasts=0;expect(await knownTransaction(hash,async()=>tx,async()=>{broadcasts++},async()=>{},()=>{})).to.equal(tx);expect(broadcasts).to.equal(0);
  });
  it("tolerates already-known only while finding and validating the same saved hash",async function(){
    let lookups=0,broadcasts=0;const waits:number[]=[];
    expect(await knownTransaction(hash,async()=>++lookups<3?null:tx,async()=>{broadcasts++;throw Object.assign(new Error("already known"),{code:-32000})},async ms=>{waits.push(ms)},()=>{})).to.equal(tx);
    expect(lookups).to.equal(3);expect(broadcasts).to.equal(1);expect(waits).to.deep.equal([1000]);
  });
  it("also waits for a successfully rebroadcast transaction to become visible",async function(){
    let lookups=0;expect(await knownTransaction(hash,async()=>++lookups<3?null:tx,async()=>{},async()=>{},()=>{})).to.equal(tx);
  });
  it("never treats unrelated send failures or a different hash as success",async function(){
    const e=Object.assign(new Error("nonce too low"),{code:-32000});
    await rejects(knownTransaction(hash,async()=>null,async()=>{throw e},async()=>{},()=>{}),/nonce too low/);
    await rejects(knownTransaction(hash,async()=>({hash:"0xdead"}),async()=>{},async()=>{},()=>{}),/identity mismatch/);
  });
  it("bounds missing lookups without signing or broadcasting another transaction",async function(){
    let lookups=0,broadcasts=0;const waits:number[]=[];
    await rejects(knownTransaction(hash,async()=>{lookups++;return null},async()=>{broadcasts++;throw Object.assign(new Error("already known"),{code:-32000})},async ms=>{waits.push(ms)},()=>{}),/Saved transaction remains unavailable/);
    expect(lookups).to.equal(7);expect(broadcasts).to.equal(1);expect(waits).to.deep.equal([1000,2000,4000,8000,16000]);
  });
});
