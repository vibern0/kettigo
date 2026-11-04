import { Interface, getAddress, ZeroHash } from "ethers";
const abi=new Interface(["event AdmissionRequested(address indexed account,uint256 nonce,bytes32 marker)"]);
export function admissionFromReceipt(logs: readonly {address:string;topics:readonly string[];data:string}[], pool:string, account:string): {nonce:bigint;marker:`0x${string}`} {
  const emitter=getAddress(pool),owner=getAddress(account);
  let found:{nonce:bigint;marker:`0x${string}`}|undefined;
  for(const log of logs){
    if(getAddress(log.address)!==emitter)continue;
    let parsed;try{parsed=abi.parseLog(log)}catch{continue}
    if(parsed?.name!=="AdmissionRequested"||parsed.args.account!==owner)continue;
    if(parsed.args.marker===ZeroHash)throw new Error("Uninitialized admission marker");
    found={nonce:parsed.args.nonce,marker:parsed.args.marker};
  }
  if(!found)throw new Error("Confirmed receipt has no admission request for account");
  return found;
}
