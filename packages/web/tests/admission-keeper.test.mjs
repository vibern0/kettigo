import assert from "node:assert/strict";
import test from "node:test";
import { admissionStartBlock, runAdmissionPass } from "../scripts/admission-keeper.mjs";

const alice = "0x1111111111111111111111111111111111111111";
const bob = "0x2222222222222222222222222222222222222222";
const marker = "0x" + "ab".repeat(32);
const pending = { requested: true, nonce: 2n, marker };
function fixture(overrides = {}) {
  return {
    startBlock: 50n, state: { next: "50", accounts: [] }, latest: 10_000n, finalized: 9900n,
    discover: async () => [alice, alice],
    readPending: async () => pending,
    decrypt: async handles => {
      assert.deepEqual(handles, [marker]);
      return { clearValues: { [marker]: true }, decryptionProof: "0x12" };
    },
    finalize: async () => assert.fail("unexpected transaction"),
    ...overrides,
  };
}

test("the manifest activates the candidate by default and leaves legacy pools alone", () => {
  assert.equal(admissionStartBlock("0x30530991e296a663a32567C170b290fB88578408"), 12078643n);
  assert.equal(admissionStartBlock("0xe65D6459a7Ce01315FbB0998C37233c6FeE3aB8b"), undefined);
  assert.equal(admissionStartBlock(alice, "42"), 42n);
  assert.throws(() => admissionStartBlock(alice, "-1"));
});

for (const positive of [true, false]) {
  test(`submits the latest marker's ${positive} proof once despite duplicate and repeated logs`, async () => {
    let requested = true;
    const writes = [];
    const operations = fixture({
      readPending: async () => ({ ...pending, requested }),
      decrypt: async () => ({ clearValues: { [marker]: positive }, decryptionProof: "0x12" }),
      finalize: async (...args) => { writes.push(args); requested = false; return "0x34"; },
    });
    const first = await runAdmissionPass(operations);
    const second = await runAdmissionPass({ ...operations, state: first.state });
    assert.deepEqual(writes, [[alice, 2n, positive, "0x12"]]);
    assert.deepEqual(first.transactions, ["0x34"]);
    assert.deepEqual(second.transactions, []);
  });
}

test("retains a changed request and an invalid proof for retry while advancing historical discovery", async () => {
  let reads = 0;
  const windows = [];
  const result = await runAdmissionPass(fixture({
    discover: async (from, to) => { windows.push([from,to]); return [alice, bob]; },
    readPending: async beneficiary => beneficiary === alice ? { ...pending, nonce: BigInt(++reads) } : pending,
    decrypt: async () => ({ clearValues: { [marker]: reads === 1 ? true : "false" }, decryptionProof: "0x12" }),
  }));
  assert.deepEqual(windows, [[9873n, 10000n], [7901n, 9900n], [5901n, 7900n], [3901n, 5900n], [1901n, 3900n], [50n, 1900n]]);
  assert.deepEqual(result.transactions, []);
  assert.deepEqual(result.state, { next: "9901", accounts: [alice, bob] });
  assert.equal(result.retrying.length, 2);
  const next = await runAdmissionPass(fixture({
    state: result.state, discover: async () => [], readPending: async () => ({ requested: false }),
  }));
  assert.deepEqual(next.state, { next: "9901", accounts: [] });
});

test("limits checked accounts per pass while retaining the tail of a large page", async () => {
  const addresses = Array.from({ length: 15 }, (_, i) => "0x" + String(i + 1).padStart(40, "0"));
  const operations = fixture({ discover: async () => addresses, readPending: async () => ({ requested: false }) });
  const first = await runAdmissionPass(operations);
  assert.deepEqual(first.state.accounts, addresses.slice(12));
  const second = await runAdmissionPass({ ...operations, state: first.state, discover: async () => [] });
  assert.deepEqual(second.state.accounts, []);
});

test("historical catch-up has a fixed query budget and resumes at the next block", async () => {
  const ranges = [];
  const operations = fixture({ latest: 500_000n, finalized: 499_980n, discover: async (from, to) => { ranges.push([from, to]); return []; } });
  const first = await runAdmissionPass(operations);
  assert.equal(ranges.length, 65);
  assert.equal(first.state.next, "128050");
  assert.ok(ranges.every(([from, to]) => to - from < 2000n));
  const second = await runAdmissionPass({ ...operations, state: first.state });
  assert.equal(second.state.next, "256050");
});
