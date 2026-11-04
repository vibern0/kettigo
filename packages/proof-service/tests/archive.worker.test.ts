import { env as workerEnv } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { D1Archive } from "../src/archive.ts";
import { branchHash, leafHash, type Namespace } from "../src/domain.ts";
const zero="0x"+"00".repeat(32), account="0x1111111111111111111111111111111111111111";
const env = workerEnv as unknown as { PROOF_DB: D1Database };
function ns():Namespace { const leaf=leafHash("0x0000000000000000000000000000000000000000","0",zero); const root=branchHash({hash:leaf,sum:zero},{hash:leaf,sum:zero}); return {chainId:"11155111",pool:"0x2222222222222222222222222222222222222222",depth:1,zero,emptyHashes:[leaf,root],deploymentBlock:1}; }
describe("D1 proof archive",()=>{
  it("rejects a namespace whose immutable parameters differ",async()=>{const a=new D1Archive(env.PROOF_DB);const n=ns();await a.initialize(n);await expect(a.initialize({...n,deploymentBlock:2})).rejects.toThrow("namespace mismatch");});
  it("uses the revision commit as an atomic stale writer guard",async()=>{const a=new D1Archive(env.PROOF_DB);const n=ns();await a.initialize(n);const state=await a.status(n);await a.ingest(n,state,[],1,"0x"+"11".repeat(32));await expect(a.ingest(n,state,[],1,"0x"+"11".repeat(32))).rejects.toThrow("checkpoint conflict");});
});
