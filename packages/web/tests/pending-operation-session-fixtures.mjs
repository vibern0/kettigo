export {
  assert,
  createLocks,
  createStorage,
  delay,
  dependencies,
  EthSafeSignature,
  entryPoint07Address,
  finalUserOperation,
  getAddress,
  relay,
  RpcRequestError,
  SAFE_ADDRESS,
  test,
  VERIFIER_ADDRESS,
  RAW_ID,
  COORDINATES,
} from "./passkey-safe-fixtures.mjs";

import { entryPoint07Address, getAddress, SAFE_ADDRESS } from "./passkey-safe-fixtures.mjs";

export const calls = [{ to: SAFE_ADDRESS, data: "0x" }];

export const operation = (hash = `0x${"11".repeat(32)}`) => ({
  chainId: 11155111,
  entryPoint: getAddress(entryPoint07Address),
  sender: SAFE_ADDRESS,
  userOperationHash: hash,
});
