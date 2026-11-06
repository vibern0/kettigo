import assert from "node:assert/strict";
import test from "node:test";

import { PimlicoFeeEstimator } from "@safe-global/relay-kit";

import { createPasskeyFeeEstimator } from "../src/lib/passkey-safe.ts";

test("adds passkey verification gas before paymaster sponsorship", async () => {
  let sponsoredVerificationGas;
  const estimator = createPasskeyFeeEstimator({
    async preEstimateUserOperationGas() {
      return { maxFeePerGas: 1n };
    },
    async postEstimateUserOperationGas(input) {
      sponsoredVerificationGas = input.userOperation.verificationGasLimit;
      return {
        verificationGasLimit: input.userOperation.verificationGasLimit,
        paymasterData: "0x1234",
      };
    },
  });

  assert.deepEqual(await estimator.preEstimateUserOperationGas({}), { maxFeePerGas: 1n });
  const result = await estimator.postEstimateUserOperationGas({
    userOperation: { verificationGasLimit: 613_085n },
  });

  assert.equal(sponsoredVerificationGas, 766_357n);
  assert.equal(result.verificationGasLimit, 766_357n);
  assert.equal(result.paymasterData, "0x1234");
});

test("covers real Sepolia passkey validation before paymaster sponsorship", async () => {
  let sponsoredVerificationGas;
  const estimator = createPasskeyFeeEstimator({
    async preEstimateUserOperationGas() {
      return {};
    },
    async postEstimateUserOperationGas(input) {
      sponsoredVerificationGas = input.userOperation.verificationGasLimit;
      return { verificationGasLimit: sponsoredVerificationGas };
    },
  });

  // Captured production estimate: 308,778. The same real signature failed
  // validation with 358,778 gas and succeeded with 450,000 gas on Sepolia.
  for (const verificationGasLimit of [200_000n, 308_778n, 450_000n]) {
    const result = await estimator.postEstimateUserOperationGas({
      userOperation: { verificationGasLimit },
    });

    assert.equal(sponsoredVerificationGas, 600_000n);
    assert.equal(result.verificationGasLimit, 600_000n);
  }
});

test("does not alter sponsor-signed gas fields", async () => {
  const estimator = createPasskeyFeeEstimator({
    async preEstimateUserOperationGas() {
      return {};
    },
    async postEstimateUserOperationGas() {
      return {
        verificationGasLimit: 420_000n,
        paymasterData: "0x1234",
      };
    },
  });

  await assert.rejects(
    estimator.postEstimateUserOperationGas({
      userOperation: { verificationGasLimit: 413_085n },
    }),
    /insufficient verification gas/i,
  );
});

test("preserves the full passkey margin above the verification floor", async () => {
  let sponsoredVerificationGas;
  const estimator = createPasskeyFeeEstimator({
    async preEstimateUserOperationGas() {
      return {};
    },
    async postEstimateUserOperationGas(input) {
      sponsoredVerificationGas = input.userOperation.verificationGasLimit;
      return { verificationGasLimit: sponsoredVerificationGas };
    },
  });

  const result = await estimator.postEstimateUserOperationGas({
    userOperation: { verificationGasLimit: 700_000n },
  });

  assert.equal(sponsoredVerificationGas, 875_000n);
  assert.equal(result.verificationGasLimit, 875_000n);
});

test("sponsors the observed Samsung passkey deployment estimate without a local ceiling", async () => {
  let sponsoredVerificationGas;
  const estimator = createPasskeyFeeEstimator({
    async preEstimateUserOperationGas() {
      return {};
    },
    async postEstimateUserOperationGas(input) {
      sponsoredVerificationGas = input.userOperation.verificationGasLimit;
      return { verificationGasLimit: sponsoredVerificationGas, paymasterData: "0x1234" };
    },
  });

  const result = await estimator.postEstimateUserOperationGas({
    userOperation: { verificationGasLimit: 2_968_567n },
  });
  assert.equal(sponsoredVerificationGas, 3_710_709n);
  assert.equal(result.verificationGasLimit, 3_710_709n);
  assert.equal(result.paymasterData, "0x1234");
});

test("a measured verifier cost can raise the budget above the fallback and bundler estimate", async () => {
  const diagnostics = {};
  const estimator = createPasskeyFeeEstimator(
    {
      async preEstimateUserOperationGas() {
        return {};
      },
      async postEstimateUserOperationGas(input) {
        assert.equal(input.userOperation.verificationGasLimit, 912_500n);
        return { verificationGasLimit: 950_000n };
      },
    },
    { estimateVerifierGas: async () => 650_000n, diagnostics },
  );
  await estimator.postEstimateUserOperationGas({
    userOperation: { verificationGasLimit: 308_778n },
  });
  assert.equal(diagnostics.verifierProbe, "measured");
  assert.equal(diagnostics.verifierGas, "650000");
  assert.equal(diagnostics.bundlerVerificationGas, "308778");
  assert.equal(diagnostics.requestedVerificationGas, "912500");
  assert.equal(diagnostics.sponsoredVerificationGas, "950000");
});

test("a probe outage preserves the proven fallback without blocking sponsorship", async () => {
  const diagnostics = {};
  const estimator = createPasskeyFeeEstimator(
    {
      async preEstimateUserOperationGas() {
        return {};
      },
      async postEstimateUserOperationGas(input) {
        return { verificationGasLimit: input.userOperation.verificationGasLimit };
      },
    },
    {
      estimateVerifierGas: async () => {
        throw new Error("offline https://rpc.example/?apikey=secret");
      },
      diagnostics,
    },
  );
  const result = await estimator.postEstimateUserOperationGas({
    userOperation: { verificationGasLimit: 308_778n },
  });
  assert.equal(result.verificationGasLimit, 600_000n);
  assert.equal(diagnostics.verifierProbe, "fallback");
  assert.doesNotMatch(JSON.stringify(diagnostics), /secret|https/);
});
