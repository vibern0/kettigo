import { getAddress } from "viem";

import type {
  ContractAbi,
  EIP712TypedData,
  GenericSigner,
  Hex as ZamaHex,
  WalletAccount,
  WalletAccountStore,
  WriteContractArgs,
  WriteContractConfig,
  WriteFunctionName,
} from "@zama-fhe/sdk";

const CHAIN_ID = 11155111;

export type TypedDataSigner = (typedData: EIP712TypedData) => Promise<ZamaHex>;
export type AccountStoreFactory = (account: WalletAccount) => WalletAccountStore;

/** Runtime-isolated signing boundary used by the SDK-facing adapter. */
export class CandidateDataSignerCore implements GenericSigner {
  readonly walletAccount: WalletAccountStore;
  readonly account: WalletAccount;
  readonly typedDataSigner: TypedDataSigner;

  constructor(address: string, typedDataSigner: TypedDataSigner, createStore: AccountStoreFactory) {
    this.account = { address: getAddress(address), chainId: CHAIN_ID };
    this.typedDataSigner = typedDataSigner;
    this.walletAccount = createStore(this.account);
  }

  requireWalletAccount(_operation: string): WalletAccount {
    return this.account;
  }
  signTypedData(typedData: EIP712TypedData): Promise<ZamaHex> {
    return this.typedDataSigner(typedData);
  }
  async writeContract<
    TAbi extends ContractAbi,
    TFunctionName extends WriteFunctionName<TAbi>,
    TArgs extends WriteContractArgs<TAbi, TFunctionName>,
  >(_config: WriteContractConfig<TAbi, TFunctionName, TArgs>): Promise<ZamaHex> {
    throw new Error("candidate SDK data signer cannot submit transactions");
  }
}
