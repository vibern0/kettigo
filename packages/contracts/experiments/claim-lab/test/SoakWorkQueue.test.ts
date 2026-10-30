import { expect } from "chai";
import { nextCycle } from "../soak/WorkQueue";

describe("Soak deadline recovery", function () {
  it("drains an unfinished deposited cycle after the launch deadline", function () {
    expect(nextCycle({ "cycle-0": { status: "completed" }, "cycle-1": { status: "running" } }, 200, 100, 3))
      .to.deep.equal({ index: 1, resume: true });
  });
  it("rechecks settled payouts after deadline instead of declaring conservation complete", function () {
    expect(nextCycle({ "cycle-0": { status: "settled" } }, 200, 100, 3)).to.deep.equal({ index: 0, resume: true });
  });
  it("does not launch a new cycle after deadline or after the cycle cap", function () {
    expect(nextCycle({ "cycle-0": { status: "completed" } }, 200, 100, 3)).to.equal(null);
    expect(nextCycle({ "cycle-0": { status: "completed" } }, 1, 100, 1)).to.equal(null);
  });
  it("prioritizes persisted work over an uncreated earlier index", function () {
    expect(nextCycle({ "cycle-1": { status: "running" } }, 1, 100, 3)).to.deep.equal({ index: 1, resume: true });
    expect(nextCycle({ retention: { status: "completed" }, "cycle-0": { status: "completed" } }, 1, 100, 3))
      .to.deep.equal({ index: 1, resume: false });
  });
});
