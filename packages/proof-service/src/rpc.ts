import { decodeEventLog, type Log } from "viem";
import { confidentialPrizePoolAbi } from "@kettigo/protocol";
import { checksum, hash32, type ArchiveLog, type Namespace } from "./domain.ts";
import type { RpcSource } from "./ingest.ts";

type JsonRpc = { result?: unknown; error?: { message?: string } };
export class EthereumRpc implements RpcSource {
  constructor(private readonly url:string, private readonly namespace:Namespace, private readonly confirmations:number) {}
  private async call(method:string, params:unknown[]=[]):Promise<unknown>{const r=await fetch(this.url,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:1,method,params})}); const j=await r.json() as JsonRpc;if(!r.ok||j.error||j.result===undefined)throw new Error(`rpc ${method} failed`);return j.result}
  private n(v:string|number|bigint){return Number(BigInt(v));}
  async finalizedHead(){const latest=this.n(await this.call("eth_blockNumber") as string);const n=Math.max(this.namespace.deploymentBlock-1,latest-this.confirmations);return this.block(n)}
  async block(number:number){const b=await this.call("eth_getBlockByNumber",[`0x${number.toString(16)}`,false]) as {number:string;hash:string}|null;if(!b)throw new Error("missing canonical block");return{number:this.n(b.number),hash:hash32(b.hash)}}
  private decode(log:Log):ArchiveLog|null{try{const d=decodeEventLog({abi:confidentialPrizePoolAbi,data:log.data,topics:log.topics,strict:true});if(!["NodeUpdated","SlotAssigned","SlotReleased","DrawSnapshotClosed"].includes(d.eventName))return null;const a=d.args as Record<string,unknown>;const args:Record<string,string>={};for(const [k,v] of Object.entries(a))args[k]=typeof v==="bigint"?v.toString():String(v);return{blockNumber:this.n(log.blockNumber!),blockHash:hash32(log.blockHash!),logIndex:this.n(log.logIndex!),name:d.eventName as ArchiveLog["name"],args}}catch{return null}}
  async logs(from:number,to:number){const r=await this.call("eth_getLogs",[{address:checksum(this.namespace.pool),fromBlock:`0x${from.toString(16)}`,toBlock:`0x${to.toString(16)}`}]) as Log[];return r.map(x=>this.decode(x)).filter((x):x is ArchiveLog=>x!==null)}
  async receiptLogs(block:number){const raw=await this.call("eth_getBlockReceipts",[`0x${block.toString(16)}`]) as Array<{logs:Log[]}>;return raw.flatMap(x=>x.logs).filter(x=>x.address.toLowerCase()===this.namespace.pool.toLowerCase()).map(x=>this.decode(x)).filter((x):x is ArchiveLog=>x!==null)}
}
export class FallbackRpc implements RpcSource { constructor(private primary:RpcSource,private fallback:RpcSource){} private async use<T>(f:(x:RpcSource)=>Promise<T>){try{return await f(this.primary)}catch{return f(this.fallback)}} finalizedHead(){return this.use(x=>x.finalizedHead())} block(n:number){return this.use(x=>x.block(n))} logs(a:number,b:number){return this.use(x=>x.logs(a,b))} receiptLogs(n:number){return this.use(x=>x.receiptLogs(n))} }
