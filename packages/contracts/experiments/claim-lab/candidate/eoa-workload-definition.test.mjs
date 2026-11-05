import assert from "node:assert/strict";
import test from "node:test";

import {
  compileCandidateWorkload,
  validateCompiledCandidateWorkload,
  workloadFingerprint,
} from "./eoa-workload-definition.mjs";
import {
  workloadDefinitionFixture,
  workloadManifestFixture,
} from "./eoa-workload-test-fixture.mjs";

const definition = workloadDefinitionFixture;
const manifest = workloadManifestFixture;
const hex = (value) => `0x${value.toString(16).padStart(40, "0")}`;
const hash = (value) => `0x${value.toString(16).padStart(64, "0")}`;

test("compiles the fixed 375-action graph without putting actions in StaticA phase IDs", () => {
  const workload = compileCandidateWorkload(definition(), manifest());
  assert.equal(workload.actions.length, 375);
  assert.equal(workload.counts.eoa, 362);
  assert.equal(workload.counts.safe, 13);
  assert.equal(workload.totals.usdcMicro, "78000000");
  assert.equal(workload.totals.grossFundingWei, "1640000000000000");
  assert.equal(workload.actions[0].id, "bootstrap-eth");
  assert.equal(workload.actions[1].id, "bootstrap-usdc");
  assert.equal(new Set(workload.actions.map((action) => action.id)).size, 375);
  assert.equal(workloadFingerprint(workload), workload.fingerprint);
  const phase = (name) =>
    workload.actions.filter((action) => action.kind === "eoa" && action.phase === name).length;
  assert.equal(phase("setup"), 71);
  assert.equal(phase("deposit"), 96);
  assert.equal(phase("draw"), 88);
  assert.equal(phase("queue"), 7);
  assert.equal(phase("final"), 100);
  assert.equal(workload.actions.filter((action) => action.kind === "externalSafe").length, 13);
  assert.equal(workload.actions.filter((action) => action.actorRole === "participant").length, 206);
});

test("encodes Safe exit/reuse/rejoin as dependency edges and rejects a changed static template", () => {
  const workload = compileCandidateWorkload(definition(), manifest());
  const action = (id) => workload.actions.find((entry) => entry.id === id);
  assert.ok(action("eoa-00-approve").dependencies.includes("safe-exit-membership"));
  assert.ok(action("safe-rejoin-deposit").dependencies.includes("eoa-00-admit"));
  assert.ok(action("eoa-01-approve").dependencies.includes("safe-rejoin-admission"));
  assert.ok(action("safe-delayed-check-b").dependencies.includes("safe-rejoin-admission"));
  assert.equal(action("safe-conditional-wallet-claim").status, "PENDING");
  assert.equal(action("check-stage8-eoa-00").operation.args.length, 8);
  const changed = definition();
  changed.creationInputDigests[0] = hash(99);
  const changedManifest = manifest();
  changedManifest.creations[0].inputDigest = hash(99);
  assert.notEqual(
    compileCandidateWorkload(changed, changedManifest).fingerprint,
    workload.fingerprint,
  );
});

test("rejects incomplete registry provenance rather than compiling a hash-only workload", () => {
  const incomplete = definition();
  incomplete.creationInputDigests = [];
  assert.throws(() => compileCandidateWorkload(incomplete, manifest()), /creation/i);
});

test("rejects missing or mismatched creation manifest records", () => {
  assert.throws(() => compileCandidateWorkload(definition()), /manifest/i);
  const wrong = manifest();
  wrong.creations[0].inputDigest = hash(99);
  assert.throws(() => compileCandidateWorkload(definition(), wrong), /manifest/i);
});

test("rejects unknown manifest fields, provenance mismatches, and malformed typed constructors", () => {
  const cases = [
    (value) => (value.extra = true),
    (value) => (value.compiler.viaIR = false),
    (value) => (value.creations[0].unknown = true),
    (value) => (value.creations[1].role = "wrapper"),
    (value) => (value.creations[2].sourceId = "contracts/pool.sol:pool"),
    (value) => (value.creations[0].artifactProvenance.contractName = "pool"),
    (value) => (value.creations[0].constructor.signature = "anything(address)"),
    (value) => value.creations[0].constructor.args.push(hex(99)),
    (value) => (value.creations[0].constructor.args[0] = hex(99)),
    (value) => (value.creations[1].constructor.args[1] = "-1"),
    (value) => (value.creations[2].constructor.args[2] = hex(99)),
    (value) => (value.creations[2].constructor.args[4].loanToken = hex(99)),
    (value) => (value.creations[2].constructor.args[4].extra = true),
  ];
  for (const mutate of cases) {
    const value = manifest();
    mutate(value);
    assert.throws(
      () => compileCandidateWorkload(definition(), value),
      /manifest|constructor|wrong|invalid/i,
    );
  }
});

test("canonicalizes complete creation input without retaining mutable aliases", () => {
  const input = manifest();
  const workload = compileCandidateWorkload(definition(), input);
  input.creations[2].constructor.args[4].lltv = "1";
  assert.equal(
    workload.definition.manifest.creations[2].constructor.args[4].lltv,
    "860000000000000000",
  );
  assert.ok(Object.isFrozen(workload.definition.manifest.creations[2].constructor.args[4]));
  assert.equal(workloadFingerprint(workload), workload.fingerprint);
});

test("uses concrete native targets, nested deposits, funding tags, and ABI arities", () => {
  const workload = compileCandidateWorkload(definition(), manifest());
  const action = (id) => workload.actions.find((entry) => entry.id === id);
  assert.equal(action("bootstrap-eth").target, workload.definition.actors.sponsor);
  assert.equal(action("bootstrap-eth").operation.signature, "nativeTransfer()");
  assert.equal(action("bootstrap-eth").operation.data, "0x");
  assert.equal(action("bootstrap-eth").operation.value, "1000000000000000");
  assert.equal(action("bootstrap-eth").operation.args.length, 0);
  assert.equal(action("fund-eth-eoa-00").target, workload.definition.actors.eoaParticipants[0]);
  assert.equal(action("fund-eth-eoa-00").operation.data, "0x");
  assert.equal(action("fund-eth-eoa-00").operation.args.length, 0);
  assert.equal(
    action("eoa-00-deposit").operation.args[0][1].signature,
    "confidentialTransferAndCall(address,bytes32,bytes,bytes)",
  );
  assert.equal(action("safe-initial-deposit").operation.signature, "safeBatch(bytes[])");
  assert.equal(action("prize-fund-A").operation.args[3].encoded.value, "5000000");
  assert.equal(action("prize-fund-A").operation.args[3].tag, "0x506aab00");
  assert.equal(action("prize-fund-A").operation.args[3].length, 36);
  assert.equal(action("prize-fund-A").operation.args[3].encoded.bytes, 32);
  assert.equal(action("prize-fund-A").operation.args[3].data.length, 74);
  assert.ok(action("prize-fund-A").operation.args[3].data.startsWith("0x506aab00"));
  assert.equal(BigInt(`0x${action("prize-fund-A").operation.args[3].data.slice(10)}`), 5000000n);
  for (const [id, amount] of [
    ["A", 5000000n],
    ["B", 5000000n],
    ["8", 1000000n],
    ["33", 1000000n],
  ]) {
    const funding = action(`prize-fund-${id}`).operation.args[3].data;
    assert.equal(funding.length, 74);
    assert.ok(funding.startsWith("0x506aab00"));
    assert.equal(BigInt(`0x${funding.slice(10)}`), amount);
  }
  assert.equal(action("initial-batch-settle").operation.args.length, 4);
  assert.equal(action("initial-batch-process-safe").operation.args.length, 2);
  assert.equal(action("initial-batch-finalize-safe").operation.args.length, 3);
  assert.equal(action("check-stage33-eoa-00").operation.args.length, 8);
});

test("enforces all admission and claim barriers rather than array order", () => {
  const workload = compileCandidateWorkload(definition(), manifest());
  const action = (id) => workload.actions.find((entry) => entry.id === id);
  assert.ok(action("prize-fund-A").dependencies.includes("reserve-wrap"));
  assert.ok(action("eoa-01-approve").dependencies.includes("safe-reinvest"));
  assert.ok(action("eoa-07-approve").dependencies.includes("safe-stage-8-check"));
  assert.ok(action("check-stage8-eoa-05").dependencies.includes("check-stage8-eoa-04"));
  assert.ok(action("check-stage33-eoa-08").dependencies.includes("check-stage33-eoa-00"));
  assert.ok(action("final-request-eoa-00").dependencies.includes("claim-stage8-eoa-06"));
  assert.ok(action("final-request-eoa-31").dependencies.includes("claim-stage33-eoa-00"));
  assert.ok(action("safe-withdrawal-request").dependencies.includes("check-stage33-eoa-31"));
  assert.ok(action("final-batch-close").dependencies.includes("safe-withdrawal-request"));
  assert.equal(action("check-stage8-eoa-00").concurrency.width, 1);
  assert.equal(action("check-stage8-eoa-01").concurrency.width, 4);
  assert.equal(action("check-stage8-eoa-05").concurrency.width, 2);
  assert.equal(action("check-stage33-eoa-16").concurrency.width, 8);
});

test("pins concrete funding, receipt scopes, and immutable historical proof inputs", () => {
  const workload = compileCandidateWorkload(definition(), manifest());
  const action = (id) => workload.actions.find((entry) => entry.id === id);
  for (let index = 0; index < 32; index += 1) {
    const id = String(index).padStart(2, "0");
    const funding = action(`fund-eth-eoa-${id}`);
    assert.equal(funding.target, workload.definition.actors.eoaParticipants[index]);
    assert.equal(funding.operation.data, "0x");
    assert.equal(funding.operation.value, "20000000000000");
    if (index)
      assert.ok(
        funding.dependencies.includes(`fund-eth-eoa-${String(index - 1).padStart(2, "0")}`),
      );
  }
  const check = action("check-stage33-eoa-00").operation.args;
  assert.equal(check[0].kind, "receiptEvent");
  assert.equal(check[0].event, "DrawClosed");
  for (const ref of check.slice(2)) {
    assert.equal(ref.kind, "historicalProof");
    assert.equal(ref.event, "DrawSnapshotClosed");
    assert.ok(ref.constraints.includes("same-draw-beneficiary-proof"));
  }
  assert.equal(action("initial-batch-close").operation.args[0].event, "WithdrawalRequested");
  assert.equal(action("final-batch-close").operation.args[0].event, "WithdrawalRequested");
});

test("routes every principal and prize allocation through its immutable source", () => {
  const workload = compileCandidateWorkload(definition(), manifest());
  const action = (id) => workload.actions.find((entry) => entry.id === id);
  for (let index = 0; index < 32; index += 1) {
    const id = String(index).padStart(2, "0");
    assert.equal(
      action(`fund-usdc-eoa-${id}`).allocation.provenance,
      `bootstrap-usdc-78/principal-eoa-${id}`,
    );
  }
  assert.equal(action("safe-initial-deposit").allocation.suballocationMicro, "2000000");
  assert.equal(action("safe-rejoin-deposit").allocation.suballocationMicro, "2000000");
  assert.equal(action("safe-reinvest").allocation.suballocationMicro, "5000000");
  assert.equal(action("safe-reinvest").allocation.provenance, "bootstrap-usdc-78/prize-B");
});

test("uses whole admission barriers, a topological sponsor tail, and receipt-backed unwraps", () => {
  const workload = compileCandidateWorkload(definition(), manifest());
  const action = (id) => workload.actions.find((entry) => entry.id === id);
  for (let index = 0; index < 7; index += 1)
    assert.ok(
      action("prize-fund-8").dependencies.includes(`eoa-${String(index).padStart(2, "0")}-admit`),
    );
  for (let index = 7; index < 32; index += 1)
    assert.ok(
      action("prize-fund-33").dependencies.includes(`eoa-${String(index).padStart(2, "0")}-admit`),
    );
  const sponsorActions = workload.actions.filter((entry) => entry.actorRole === "sponsor");
  const sponsorIds = new Set(sponsorActions.map((entry) => entry.id));
  assert.equal(
    sponsorActions.filter(
      (entry) => !entry.dependencies.some((dependency) => sponsorIds.has(dependency)),
    ).length,
    1,
  );
  const morpho = action("morpho-finalize-initial").operation.args;
  assert.equal(morpho[0].kind, "receiptEvent");
  assert.equal(morpho[0].event, "MorphoPrincipalUnwrapRequested");
  assert.equal(morpho[1].receiver, workload.definition.contracts.adapter);
  assert.ok(morpho[1].constraints.includes("same-unwrap-request"));
  const finalUnwrap = action("final-finalize-eoa-00").operation.args;
  assert.equal(finalUnwrap[0].event, "WithdrawalClaimedToUsdc");
  assert.equal(finalUnwrap[1].receiver, workload.definition.actors.eoaParticipants[0]);
  assert.equal(action("check-stage8-eoa-00").operation.args[0].beneficiary, undefined);
  assert.ok(
    !action("check-stage8-eoa-00").operation.args[0].constraints.includes("indexed-beneficiary"),
  );
});

test("rejects regenerated mutations to required immutable workload fields", () => {
  const workload = compileCandidateWorkload(definition(), manifest());
  const cases = [
    (value) =>
      (value.actions.find((entry) => entry.id === "check-stage8-eoa-00").operation.args[0].event =
        "Wrong"),
    (value) =>
      (value.actions.find(
        (entry) => entry.id === "check-stage8-eoa-00",
      ).operation.args[0].contractRole = "wrapper"),
    (value) =>
      (value.actions.find((entry) => entry.id === "check-stage8-eoa-00").operation.args[0].field =
        "wrongId"),
    (value) =>
      (value.actions.find((entry) => entry.id === "check-stage8-eoa-00").operation.args[0].abiType =
        "bytes32"),
    (value) =>
      (value.actions.find(
        (entry) => entry.id === "check-stage8-eoa-00",
      ).operation.args[0].producer = "close-draw-A"),
    (value) =>
      (value.actions.find((entry) => entry.id === "prize-fund-A").operation.args[3].data = "0x"),
    (value) =>
      (value.actions.find((entry) => entry.id === "fund-eth-eoa-00").operation.value = "1"),
    (value) =>
      (value.actions.find((entry) => entry.id === "fund-eth-eoa-00").operation.data = "0x01"),
    (value) => (value.actions.find((entry) => entry.id === "fund-eth-eoa-00").target = hex(99)),
    (value) =>
      (value.actions.find((entry) => entry.id === "safe-reinvest").allocation.provenance = "wrong"),
    (value) =>
      (value.actions.find((entry) => entry.id === "check-stage8-eoa-01").concurrency.width = 99),
    (value) => value.actions.find((entry) => entry.id === "prize-fund-8").dependencies.pop(),
    (value) => (value.definition.manifest.creations[0].constructor.args[0] = hex(99)),
    (value) => (value.definition.manifest.creations[1].sourceId = "contracts/Wrong.sol:Wrong"),
    (value) => (value.definition.manifest.creations[2].role = "pool"),
    (value) =>
      (value.actions.find(
        (entry) => entry.id === "check-stage8-eoa-00",
      ).operation.args[2].beneficiary = hex(99)),
    (value) =>
      (value.actions.find((entry) => entry.id === "check-stage8-eoa-00").operation.args[2].field =
        "wrongLeaf"),
  ];
  for (const mutate of cases) {
    const changed = JSON.parse(JSON.stringify(workload));
    mutate(changed);
    changed.fingerprint = workloadFingerprint(changed);
    assert.throws(() => validateCompiledCandidateWorkload(changed), /differs|invalid|wrong/i);
  }
});

test("rejects arbitrary StaticA bootstrap IDs and a caller-recomputed fingerprint", () => {
  const changed = definition();
  changed.initialFundingWorkloadIds = ["foo", "bar"];
  changed.workloadIds = ["foo", "bar"];
  assert.throws(() => compileCandidateWorkload(changed, manifest()), /bootstrap/i);
  const tampered = JSON.parse(JSON.stringify(compileCandidateWorkload(definition(), manifest())));
  tampered.actions.find((entry) => entry.id === "prize-fund-A").operation.args[3].tag =
    "0x00000000";
  tampered.fingerprint = workloadFingerprint(tampered);
  assert.throws(() => validateCompiledCandidateWorkload(tampered), /differs|invalid/i);
});

test("deep freezes the graph and rejects a recomputed tampered compiled workload", () => {
  const workload = compileCandidateWorkload(definition(), manifest());
  assert.ok(Object.isFrozen(workload.actions[0].operation.args));
  assert.ok(
    Object.isFrozen(
      workload.actions.find((entry) => entry.id === "eoa-00-deposit").operation.args[0][1],
    ),
  );
  const tampered = JSON.parse(JSON.stringify(workload));
  tampered.actions[0].target = tampered.definition.actors.safeParticipant;
  assert.throws(() => validateCompiledCandidateWorkload(tampered), /differs|invalid/i);
  assert.equal(validateCompiledCandidateWorkload(workload).fingerprint, workload.fingerprint);
});
