import { getAddress, zeroHash } from "viem";

// All ciphertexts, proofs and reads go through the in-process FHEVM plugin.
export const asChecksumAddress = (address) => getAddress(address);
export const isZeroEncryptedHandle = (handle) => handle === zeroHash;
export const prepareSmartReadSessionCalls = () => window.localReadCalls();
export const withSmartZamaSDK = (_session, action) => action({});
export const encryptUint64 = (_sdk, token, user, value) => window.localEncrypt(token, user, value);
export const decryptExistingSmartUint64 = (_session, handle) => window.localDecrypt(handle);
export const createPublicZamaSDK = () => ({ terminate() {} });
export const decryptPublicUint64 = (_sdk, handle) => window.localPublicDecrypt(handle);
