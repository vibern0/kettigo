import { createConfig, createWalletAccountStore, memoryStorage, ZamaSDK } from "@zama-fhe/sdk";
import { sepolia } from "@zama-fhe/sdk/chains";
import { EthersProvider } from "@zama-fhe/sdk/ethers";
import { node } from "@zama-fhe/sdk/node";
import { type Provider } from "ethers";
import { CandidateDataSignerCore, type TypedDataSigner } from "./zama-data-signer-core.ts";

const CHAIN_ID = 11155111;

/** Narrow SDK bridge: it creates FHE data but cannot submit a transaction. */
export class CandidateDataSigner extends CandidateDataSignerCore {
  constructor(address: string, typedDataSigner: TypedDataSigner) {
    super(address, typedDataSigner, createWalletAccountStore);
  }
}

export function createCandidateDataSdk({
  address,
  typedDataSigner,
  provider,
  network,
}: {
  address: string;
  typedDataSigner: TypedDataSigner;
  provider: Provider;
  network: string;
}): ZamaSDK {
  const chain = { ...sepolia, network };
  return new ZamaSDK(
    createConfig({
      chains: [chain],
      provider: new EthersProvider({ provider }),
      signer: new CandidateDataSigner(address, typedDataSigner),
      storage: memoryStorage,
      relayers: { [sepolia.id]: node({ timeout: 120_000 }) },
    }),
  );
}
