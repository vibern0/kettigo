export async function knownTransaction<T extends {hash:string}>(
  hash:string,lookup:()=>Promise<T|null>,rebroadcast:()=>Promise<unknown>,
  wait:(ms:number)=>Promise<void>,retry:(attempt:number,delay:number)=>void,
):Promise<T>{
  const tx=await lookup();
  if(tx){if(tx.hash!==hash)throw new Error("Saved transaction identity mismatch");return tx}
  try{await rebroadcast()}
  catch(error:any){if(String(error.code)!=="-32000"||error.message!=="already known")throw error}
  for(let attempt=1;;attempt++){
    const found=await lookup();
    if(found){if(found.hash!==hash)throw new Error("Saved transaction identity mismatch");return found}
    if(attempt>=6)throw new Error("Saved transaction remains unavailable");
    const delay=1000*2**(attempt-1);retry(attempt,delay);await wait(delay);
  }
}
