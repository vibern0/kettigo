import { envelopeIdentity } from "./journal-values.mjs";
import { ORIGINAL_ENVELOPE } from "./original-envelope.mjs";

const hex = (value) => `0x${value.toString(16).padStart(40, "0")}`;
const hash = (value) => `0x${value.toString(16).padStart(64, "0")}`;

export function workloadDefinitionFixture() {
  return {
    version: 1,
    chainId: 11155111,
    envelopeIdentity: envelopeIdentity(ORIGINAL_ENVELOPE),
    actors: {
      eoaParticipants: Array.from({ length: 32 }, (_, index) => hex(index + 1)),
      safeParticipant: hex(40),
      sponsor: hex(41),
      bootstrapOperator: hex(42),
    },
    contracts: {
      candidatePool: hex(50),
      wrapper: hex(51),
      adapter: hex(52),
      underlying: hex(53),
      safe4337Module: hex(54),
      entryPoint: hex(55),
      multiSend: hex(56),
      factory: hex(57),
      setup: hex(58),
    },
    allowedEoaTargets: [hex(50), hex(51), hex(52), hex(53)],
    creationInputDigests: [hash(1), hash(2), hash(3)],
    deploymentCreationHashes: [hash(4), hash(5), hash(6)],
    workloadIds: ["bootstrap-eth", "bootstrap-usdc", "deploy"],
    initialFundingWorkloadIds: ["bootstrap-eth", "bootstrap-usdc"],
  };
}

export function workloadManifestFixture() {
  const sources = [
    "contracts/ConfidentialUSDC.sol:ConfidentialUSDC",
    "contracts/ConfidentialPrizePool.sol:ConfidentialPrizePool",
    "contracts/MorphoYieldAdapter.sol:MorphoYieldAdapter",
  ];
  return {
    chainId: 11155111,
    compiler: { version: "0.8.28", optimizerRuns: 200, viaIR: true, evmVersion: "cancun" },
    creations: ["wrapper", "pool", "adapter"].map((role, index) => ({
      role,
      sourceId: sources[index],
      artifactProvenance: {
        sourceId: sources[index],
        contractName: sources[index].slice(sources[index].lastIndexOf(":") + 1),
      },
      compilerBuildHash: hash(index + 10),
      creationBytecodeHash: hash(index + 4),
      inputDigest: hash(index + 1),
      constructor: {
        signature: [
          "wrapper(address)",
          "pool(address,uint256,uint256)",
          "adapter(address,address,address,address,(address,address,address,address,uint256))",
        ][index],
        args:
          index === 0
            ? [hex(53)]
            : index === 1
              ? [hex(51), "1", "2"]
              : [
                  hex(53),
                  hex(51),
                  hex(50),
                  hex(60),
                  {
                    loanToken: hex(53),
                    collateralToken: hex(61),
                    oracle: hex(62),
                    irm: hex(63),
                    lltv: "860000000000000000",
                  },
                ],
      },
    })),
  };
}
