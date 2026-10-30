import { expect } from "chai";
import { confirmedPublicProof } from "../soak/PublicProof";
describe("Confirmed public-proof permission recovery", function () {
  const handle = "0x" + "ab".repeat(32);
  const denied = (h = handle) => Object.assign(new Error("Public decryption failed"), {
    code: "DECRYPTION_FAILED", cause: new Error(`Handle ${h} is not allowed for public decryption`),
  });
  async function rejects(fn: () => Promise<unknown>, message: string) {
    try { await fn(); throw new Error("Expected rejection"); } catch (e: any) { expect(e.message).to.equal(message); }
  }
  it("retries the exact SDK ACL mismatch only after a confirmed-block permission check", async function () {
    let calls = 0, checks = 0; const delays: number[] = [], retries: number[] = [];
    expect(await confirmedPublicProof(handle, async () => { checks++; return true; }, async () => {
      if (++calls < 3) throw denied(); return "proof";
    }, async ms => { delays.push(ms); }, attempt => { retries.push(attempt); })).to.equal("proof");
    expect(checks).to.equal(1); expect(calls).to.equal(3);
    expect(delays).to.deep.equal([1000, 2000]); expect(retries).to.deep.equal([1, 2]);
  });
  it("stops before contacting the SDK when confirmed permission is absent", async function () {
    let calls = 0;
    await rejects(() => confirmedPublicProof(handle, async () => false, async () => { calls++; }, async () => {}, () => {}), "Confirmed admission marker is not publicly decryptable");
    expect(calls).to.equal(0);
  });
  it("does not retry unrelated decryption errors or a different handle", async function () {
    for (const error of [new Error("Bad decryption signature"), denied("0x" + "cd".repeat(32))]) {
      let calls = 0, waits = 0;
      await rejects(() => confirmedPublicProof(handle, async () => true, async () => { calls++; throw error; }, async () => { waits++; }, () => {}), error.message);
      expect(calls).to.equal(1); expect(waits).to.equal(0);
    }
  });
  it("bounds persistent mismatches to six attempts and preserves the original error", async function () {
    const error = denied(); let calls = 0; const delays: number[] = [];
    await rejects(() => confirmedPublicProof(handle, async () => true, async () => { calls++; throw error; }, async ms => { delays.push(ms); }, () => {}), error.message);
    expect(calls).to.equal(6); expect(delays).to.deep.equal([1000, 2000, 4000, 8000, 16000]);
  });
});
