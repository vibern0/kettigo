import { expect } from "chai";
import { assertBudget, assertResearchRequest, TxBudgetRecord } from "../soak/Policy";

describe("Research soak transaction budget", function () {
  const records: TxBudgetRecord[] = [
    { status: "signed", quotedFeeWei: "12", valueWei: "3" },
    { status: "pending", quotedFeeWei: "20", valueWei: "5" },
    { status: "confirmed", quotedFeeWei: "100", feeWei: "7", valueWei: "11" },
    { status: "reverted", quotedFeeWei: "100", feeWei: "9", valueWei: "13" },
  ];

  it("reserves unsigned receipt costs and uses actual terminal fees at the exact cap", function () {
    // Fees: 12 + 20 + 7 + 9 + 2 = 50; all values: 3 + 5 + 11 + 13 + 1 = 33.
    expect(() => assertBudget(records, { feeWei: 2n, valueWei: 1n },
      { feeWei: 50n, fundingWei: 33n, maxTransactions: 5 })).not.to.throw();
  });

  it("rejects a one-wei fee overshoot including pending reservations and reverted fees", function () {
    expect(() => assertBudget(records, { feeWei: 3n, valueWei: 0n },
      { feeWei: 50n, fundingWei: 33n, maxTransactions: 5 })).to.throw(/fee budget/i);
  });

  it("conservatively counts reverted and unconfirmed value toward the funding ceiling", function () {
    expect(() => assertBudget(records, { feeWei: 0n, valueWei: 2n },
      { feeWei: 50n, fundingWei: 33n, maxTransactions: 5 })).to.throw(/funding budget/i);
  });

  it("rejects the next transaction when every historical status has consumed capacity", function () {
    expect(() => assertBudget(records, { feeWei: 0n, valueWei: 0n },
      { feeWei: 1000n, fundingWei: 1000n, maxTransactions: 4 })).to.throw(/transaction budget/i);
  });

  it("keeps integer arithmetic exact above JavaScript's safe-integer range", function () {
    const large: TxBudgetRecord[] = [{ status: "pending", quotedFeeWei: "9007199254740993", valueWei: "0" }];
    expect(() => assertBudget(large, { feeWei: 1n, valueWei: 0n },
      { feeWei: 9007199254740994n, fundingWei: 0n, maxTransactions: 2 })).not.to.throw();
    expect(() => assertBudget(large, { feeWei: 2n, valueWei: 0n },
      { feeWei: 9007199254740994n, fundingWei: 0n, maxTransactions: 2 })).to.throw(/fee budget/i);
  });

  for (const malformed of ["-1", "+1", "1.5", "1e3", "0x10", "", " 1", "1 ", "01", "NaN", "1\n", "1\r\n"]) {
    it(`rejects malformed monetary record ${JSON.stringify(malformed)} in every field`, function () {
      for (const field of ["quotedFeeWei", "valueWei", "feeWei"]) {
        const record = { status: "confirmed", quotedFeeWei: "1", valueWei: "0", feeWei: "1", [field]: malformed };
        expect(() => assertBudget([record as TxBudgetRecord], { feeWei: 0n, valueWei: 0n },
          { feeWei: 100n, fundingWei: 100n, maxTransactions: 2 })).to.throw(/invalid.*wei/i);
      }
    });
  }

  it("rejects missing actual fees for both confirmed and reverted transactions", function () {
    for (const status of ["confirmed", "reverted"] as const) {
      expect(() => assertBudget([{ status, quotedFeeWei: "2", valueWei: "0" }], { feeWei: 0n, valueWei: 0n },
        { feeWei: 100n, fundingWei: 100n, maxTransactions: 2 })).to.throw(/actual fee/i);
    }
  });

  it("rejects unknown statuses and non-string record amounts", function () {
    for (const record of [
      { status: "dropped", quotedFeeWei: "1", valueWei: "0" },
      { status: "signed", quotedFeeWei: 1, valueWei: "0" },
      { status: "pending", quotedFeeWei: "1", valueWei: -1n },
      { status: "signed", quotedFeeWei: "1", valueWei: "0", feeWei: null },
    ]) {
      expect(() => assertBudget([record as unknown as TxBudgetRecord], { feeWei: 0n, valueWei: 0n },
        { feeWei: 100n, fundingWei: 100n, maxTransactions: 2 })).to.throw(/invalid/i);
    }
  });

  it("rejects negative or wrongly typed next costs, limits, and invalid capacities", function () {
    const next = { feeWei: 1n, valueWei: 0n }, limits = { feeWei: 10n, fundingWei: 10n, maxTransactions: 2 };
    for (const invalid of [{ feeWei: -1n }, { valueWei: -1n }, { feeWei: 1 as unknown as bigint }]) {
      expect(() => assertBudget([], { ...next, ...invalid }, limits)).to.throw(/invalid/i);
    }
    for (const invalid of [{ feeWei: -1n }, { fundingWei: -1n }, { maxTransactions: -1 },
      { maxTransactions: 1.5 }, { maxTransactions: Number.NaN }, { maxTransactions: Number.MAX_SAFE_INTEGER + 1 }]) {
      expect(() => assertBudget([], next, { ...limits, ...invalid })).to.throw(/invalid/i);
    }
    expect(() => assertBudget([], next, { ...limits, maxTransactions: 0 })).to.throw(/transaction budget/i);
  });
});

describe("Research soak Sepolia request allowlist", function () {
  const contract = "0x52908400098527886E0F7030069857D2E4169EE7";
  const wallet = "0x5Aeda56215b167893e80B4fE645BA6d5Bab767DE";
  // This second fixture is intentionally lowercase, a valid equivalent address.
  const allowed = { contracts: [contract], wallets: [wallet.toLowerCase()], maxGasPrice: 100n };
  const request = { chainId: 11155111n, to: contract, value: 0n, gasPrice: 100n, gasLimit: 21_000n };

  it("permits zero-value known contracts and funded known wallets with equivalent address casing", function () {
    expect(() => assertResearchRequest({ ...request, to: contract.toLowerCase() }, allowed)).not.to.throw();
    expect(() => assertResearchRequest({ ...request, to: wallet.toLowerCase(), value: 9n }, allowed)).not.to.throw();
    expect(() => assertResearchRequest({ ...request, to: wallet.toLowerCase() }, allowed)).not.to.throw();
  });

  it("rejects every chain other than Sepolia", function () {
    for (const chainId of [1n, 31337n, 84532n, 0n]) {
      expect(() => assertResearchRequest({ ...request, chainId }, allowed)).to.throw(/Sepolia/i);
    }
  });

  it("rejects contract creation and missing recipients", function () {
    for (const to of [undefined, null, ""]) {
      expect(() => assertResearchRequest({ ...request, to }, allowed)).to.throw(/recipient|creation/i);
    }
  });

  it("rejects unknown recipients for zero-value calls and funded transfers", function () {
    for (const value of [0n, 5n]) {
      expect(() => assertResearchRequest({ ...request, to: "0x0000000000000000000000000000000000001234", value }, allowed)).to.throw(/recipient/i);
    }
  });

  it("rejects value transfers to known contracts", function () {
    expect(() => assertResearchRequest({ ...request, value: 1n }, allowed)).to.throw(/value|wallet/i);
  });

  it("rejects malformed and invalid mixed-checksum addresses, including allowlists", function () {
    for (const to of ["0x1234", "0x52908400098527886e0F7030069857D2E4169EE7"]) {
      expect(() => assertResearchRequest({ ...request, to }, allowed)).to.throw(/address/i);
    }
    expect(() => assertResearchRequest(request, { ...allowed, wallets: ["bad-wallet"] })).to.throw(/address/i);
    expect(() => assertResearchRequest(request, { ...allowed, contracts: ["bad-contract"] })).to.throw(/address/i);
  });

  it("rejects gas above the price ceiling and nonpositive gas parameters", function () {
    expect(() => assertResearchRequest({ ...request, gasPrice: 101n }, allowed)).to.throw(/gas/i);
    for (const invalid of [{ gasPrice: 0n }, { gasPrice: -1n }, { gasLimit: 0n }, { gasLimit: -1n }]) {
      expect(() => assertResearchRequest({ ...request, ...invalid }, allowed)).to.throw(/gas/i);
    }
  });

  it("rejects negative or wrongly typed request amounts and gas ceilings", function () {
    expect(() => assertResearchRequest({ ...request, value: -1n }, allowed)).to.throw(/value/i);
    expect(() => assertResearchRequest({ ...request, gasPrice: 1 as unknown as bigint }, allowed)).to.throw(/gas/i);
    expect(() => assertResearchRequest(request, { ...allowed, maxGasPrice: -1n })).to.throw(/gas/i);
  });
});
