import { expect } from "chai";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, statSync, readdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { RunState } from "../soak/RunState";

describe("Research soak exclusive run state", function () {
  let directory: string, statePath: string, lockPath: string;
  beforeEach(function () {
    directory = mkdtempSync(path.join(tmpdir(), "kettigo-run-state-"));
    statePath = path.join(directory, "runner", "state.json");
    lockPath = path.join(directory, "runner", "writer.lock");
  });
  afterEach(function () { rmSync(directory, { recursive: true, force: true }); });

  it("prevents duplicate acquisition, state overwrite, and accidental release of the active owner's lock", function () {
    const owner = new RunState(statePath, lockPath), duplicate = new RunState(statePath, lockPath);
    owner.acquire(); owner.write({ sequence: 7, pending: ["0xabc"] });
    expect(() => duplicate.acquire()).to.throw(/lock|lease|active/i);
    expect(() => duplicate.read()).to.throw(/lock|lease|own/i);
    expect(() => duplicate.write({ sequence: 0 })).to.throw(/lock|lease|own/i);
    duplicate.release();
    expect(readFileSync(lockPath, "utf8")).to.equal(String(process.pid));
    expect(owner.read()).to.deep.equal({ sequence: 7, pending: ["0xabc"] });
    owner.write({ sequence: 8 });
    expect(JSON.parse(readFileSync(statePath, "utf8"))).to.deep.equal({ sequence: 8 });
    owner.release();
  });

  it("reads the latest snapshot after acquiring even when constructed before the previous writer's changes", function () {
    const waiting = new RunState(statePath, lockPath), owner = new RunState(statePath, lockPath);
    owner.acquire(); owner.write({ sequence: 11 }); owner.write({ sequence: 12 }); owner.release();
    waiting.acquire();
    expect(waiting.read()).to.deep.equal({ sequence: 12 });
    waiting.write({ sequence: 13 }); waiting.release();
    expect(JSON.parse(readFileSync(statePath, "utf8"))).to.deep.equal({ sequence: 13 });
  });

  it("does not read or parse state during construction and reports malformed JSON only on an owned read", function () {
    const localState = path.join(directory, "bad.json"), localLock = path.join(directory, "bad.lock");
    writeFileSync(localState, "{broken");
    let state!: RunState;
    expect(() => { state = new RunState(localState, localLock); }).not.to.throw();
    expect(() => state.read()).to.throw(/lock|lease|own/i);
    state.acquire();
    expect(() => state.read()).to.throw(SyntaxError);
    state.release();
  });

  it("requires ownership for absent-state reads and writes, while unowned release is a safe no-op", function () {
    const state = new RunState(statePath, lockPath);
    expect(() => state.read()).to.throw(/lock|lease|own/i);
    expect(() => state.write({ discarded: true })).to.throw(/lock|lease|own/i);
    expect(() => state.release()).not.to.throw();
    expect(existsSync(statePath)).to.equal(false);
    expect(existsSync(lockPath)).to.equal(false);
    state.acquire(); expect(state.read()).to.equal(null); state.release();
    expect(() => state.write({ discarded: true })).to.throw(/lock|lease|own/i);
    expect(existsSync(statePath)).to.equal(false);
  });

  it("atomically replaces persisted JSON, serializes nested bigint values, and uses owner-only file modes", function () {
    const state = new RunState(statePath, lockPath);
    state.acquire(); state.write({ count: 1n, nested: { wei: 9007199254740993n } });
    const firstInode = statSync(statePath).ino;
    expect(statSync(lockPath).mode & 0o777).to.equal(0o600);
    expect(statSync(statePath).mode & 0o777).to.equal(0o600);
    expect(statSync(path.dirname(statePath)).mode & 0o777).to.equal(0o700);
    state.write({ count: 2n, nested: { wei: 0n } });
    expect(statSync(statePath).ino).not.to.equal(firstInode);
    expect(state.read()).to.deep.equal({ count: "2", nested: { wei: "0" } });
    expect(readdirSync(path.dirname(statePath)).sort()).to.deep.equal(["state.json", "writer.lock"]);
    state.release();
  });

  it("keeps the prior snapshot when serialization fails and leaves no temporary files", function () {
    const state = new RunState(statePath, lockPath);
    state.acquire(); state.write({ sequence: 4 });
    const circular: any = {}; circular.self = circular;
    expect(() => state.write(circular)).to.throw();
    expect(() => state.write(undefined)).to.throw();
    expect(state.read()).to.deep.equal({ sequence: 4 });
    expect(readdirSync(path.dirname(statePath)).sort()).to.deep.equal(["state.json", "writer.lock"]);
    state.release();
  });

  it("reads state fresh at each owned call rather than retaining an in-memory snapshot", function () {
    const state = new RunState(statePath, lockPath);
    state.acquire(); state.write({ sequence: 1 });
    expect(state.read()).to.deep.equal({ sequence: 1 });
    writeFileSync(statePath, '{"sequence":2}', { mode: 0o600 });
    expect(state.read()).to.deep.equal({ sequence: 2 }); state.release();
  });

  for (const malformed of ["", "0", "-1", "1.5", "not-a-pid", "9007199254740993"]) {
    it(`fails closed for malformed lock PID ${JSON.stringify(malformed)}`, function () {
      const localState = path.join(directory, "state.json"), localLock = path.join(directory, "writer.lock");
      writeFileSync(localLock, malformed);
      const state = new RunState(localState, localLock);
      expect(() => state.acquire()).to.throw(/lock|pid/i);
      state.release();
      expect(readFileSync(localLock, "utf8")).to.equal(malformed);
      expect(existsSync(localState)).to.equal(false);
    });
  }

  it("does not steal a live PID lease, even from another object in this same process", function () {
    const localLock = path.join(directory, "live.lock");
    writeFileSync(localLock, String(process.pid), { mode: 0o600 });
    const state = new RunState(statePath, localLock);
    expect(() => state.acquire()).to.throw(/lock|lease|active/i);
    state.release(); expect(readFileSync(localLock, "utf8")).to.equal(String(process.pid));
  });

  it("reclaims a dead PID lease only after an ESRCH response to signal zero", function () {
    const localLock = path.join(directory, "stale.lock"), deadPid = 2147483647;
    let missing = false;
    try { process.kill(deadPid, 0); } catch (error: any) { missing = error.code === "ESRCH"; }
    expect(missing, "the stale PID fixture must actually be absent").to.equal(true);
    writeFileSync(localLock, String(deadPid), { mode: 0o600 });
    const state = new RunState(statePath, localLock);
    state.acquire(); expect(readFileSync(localLock, "utf8")).to.equal(String(process.pid));
    state.write({ recovered: true }); state.release();
    expect(existsSync(localLock)).to.equal(false);
  });

  it("fails closed on EPERM instead of deleting a possibly live writer's lease", function () {
    const localLock = path.join(directory, "permission.lock");
    writeFileSync(localLock, "12345");
    const kill = process.kill;
    process.kill = ((pid: number, signal: string | number) => {
      expect(pid).to.equal(12345); expect(signal).to.equal(0);
      throw Object.assign(new Error("denied"), { code: "EPERM" });
    }) as typeof process.kill;
    try {
      const state = new RunState(statePath, localLock);
      expect(() => state.acquire()).to.throw(/lock|lease|permission/i);
      state.release(); expect(readFileSync(localLock, "utf8")).to.equal("12345");
    } finally { process.kill = kill; }
  });

  it("cannot release or overwrite a replacement lease, even if its replacement PID is the same", function () {
    const owner = new RunState(statePath, lockPath);
    owner.acquire(); owner.write({ sequence: 5 });
    // Replace the inode while preserving the PID: PID equality alone is insufficient.
    unlinkSync(lockPath); writeFileSync(lockPath, String(process.pid), { mode: 0o600 });
    expect(() => owner.write({ sequence: 0 })).to.throw(/lock|lease|own/i);
    expect(() => owner.read()).to.throw(/lock|lease|own/i);
    owner.release();
    expect(existsSync(lockPath)).to.equal(true);
    expect(JSON.parse(readFileSync(statePath, "utf8"))).to.deep.equal({ sequence: 5 });
  });
});
