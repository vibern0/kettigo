import { PimlicoFeeEstimator } from "@safe-global/relay-kit";

import type { PasskeyGasDiagnostics } from "./passkey-gas.ts";

const PASSKEY_VERIFICATION_GAS_MARGIN = 50_000n;
const PASSKEY_DISPATCH_GAS = 100_000n;
const PASSKEY_MIN_VERIFICATION_GAS = 600_000n;

type PimlicoFeeEstimatorLike = Pick<
  PimlicoFeeEstimator,
  "preEstimateUserOperationGas" | "postEstimateUserOperationGas"
>;

export function createPasskeyFeeEstimator(
  baseEstimator: PimlicoFeeEstimatorLike = new PimlicoFeeEstimator(),
  options: {
    estimateVerifierGas?: () => Promise<bigint>;
    diagnostics?: PasskeyGasDiagnostics;
  } = {},
) {
  const diagnostics = options.diagnostics ?? {};
  return {
    preEstimateUserOperationGas: (
      input: Parameters<PimlicoFeeEstimator["preEstimateUserOperationGas"]>[0],
    ) => baseEstimator.preEstimateUserOperationGas(input),
    async postEstimateUserOperationGas(
      input: Parameters<PimlicoFeeEstimator["postEstimateUserOperationGas"]>[0],
    ) {
      const bundlerGas = BigInt(input.userOperation.verificationGasLimit);
      diagnostics.bundlerVerificationGas = bundlerGas.toString();
      const proportionalMargin = (bundlerGas + 3n) / 4n;
      const estimatedVerificationGas =
        bundlerGas +
        (proportionalMargin > PASSKEY_VERIFICATION_GAS_MARGIN
          ? proportionalMargin
          : PASSKEY_VERIFICATION_GAS_MARGIN);
      let measuredVerificationGas = 0n;
      diagnostics.verifierProbe = "fallback";
      if (options.estimateVerifierGas) {
        try {
          const verifierGas = await options.estimateVerifierGas();
          if (verifierGas <= 0n) throw new Error("Invalid verifier gas estimate.");
          diagnostics.verifierGas = verifierGas.toString();
          diagnostics.verifierProbe = "measured";
          measuredVerificationGas = verifierGas + (verifierGas + 3n) / 4n + PASSKEY_DISPATCH_GAS;
        } catch {
          // Probe availability must not prevent the proven fallback from working.
        }
      }
      const minimumVerificationGas = [
        PASSKEY_MIN_VERIFICATION_GAS,
        estimatedVerificationGas,
        measuredVerificationGas,
      ].reduce((maximum, value) => (value > maximum ? value : maximum));
      diagnostics.requestedVerificationGas = minimumVerificationGas.toString();
      diagnostics.phase = "sponsorship";
      const sponsored = await baseEstimator.postEstimateUserOperationGas({
        ...input,
        userOperation: { ...input.userOperation, verificationGasLimit: minimumVerificationGas },
      });
      const sponsoredVerificationGas =
        sponsored.verificationGasLimit == null ? 0n : BigInt(sponsored.verificationGasLimit);
      diagnostics.sponsoredVerificationGas = sponsoredVerificationGas.toString();
      if (sponsoredVerificationGas < minimumVerificationGas) {
        throw new Error("The paymaster returned insufficient verification gas for the passkey.");
      }
      return sponsored;
    },
  };
}
