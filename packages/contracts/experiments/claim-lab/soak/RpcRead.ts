export async function indexedRead<T>(read:()=>Promise<T>,wait:(ms:number)=>Promise<void>,retry:(attempt:number,delay:number)=>void):Promise<T>{
  for(let attempt=1;;attempt++){
    try{return await read()}
    catch(error:any){
      const message=String(error.message??"");
      const lag=(String(error.code)==="-32602"&&message.includes("block range extends beyond current head block"))
        ||(String(error.code)==="-32000"&&message.includes("header not found"))
        ||(String(error.code)==="-32001"&&/^block not found: 0x[0-9a-f]+$/i.test(message));
      if(!lag||attempt>=6)throw error;
      const delay=1000*2**(attempt-1);retry(attempt,delay);await wait(delay);
    }
  }
}
