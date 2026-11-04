import { expect } from "chai";
import { ethers, fhevm } from "hardhat";
import { FhevmType } from "@fhevm/hardhat-plugin";
import { rejects } from "node:assert/strict";
import { fixture, deposit, withdraw, snapshot, merkleClaim, clear } from "./helpers";

describe("Stripped Sepolia research candidate", function () {
  it("has no deterministic/sparse/ZK entrypoints and completes a funded random draw locally", async function () {
    const f = await fixture(2, 32), [alice, bob] = f.users;
    f.pool = await (await ethers.getContractFactory("SepoliaMerkleProbe")).deploy(await f.token.getAddress(), 32);
    f.address = await f.pool.getAddress();
    for (const name of ["closeAtForTest", "assignSparseIndexForTest", "claimRange", "claimZk", "publishRangeInputs"]) expect(f.pool.interface.getFunction(name)).to.equal(null);
    await deposit(f, alice, 3n); await deposit(f, bob, 7n);
    await deposit(f, f.admin, 11n, undefined, true);
    await expect(f.pool.connect(alice).closeDraw()).to.be.revertedWithCustomError(f.pool, "OnlyOwner");
    await f.pool.closeDraw();
    await withdraw(f, alice, 3n); await deposit(f, bob, 2n);
    const old = await snapshot(f, 1), d = await f.pool.draws(1);
    await merkleClaim(f, old, alice, 1, f.admin); await merkleClaim(f, old, bob, 1, f.admin);
    const a = await fhevm.userDecryptEuint(FhevmType.euint64, await f.pool.awardOf(1, alice.address), f.address, alice);
    const b = await fhevm.userDecryptEuint(FhevmType.euint64, await f.pool.awardOf(1, bob.address), f.address, bob);
    expect(a + b).to.equal(11n);
    await rejects(fhevm.userDecryptEuint(FhevmType.euint64, d.ticket, f.address, alice));
    await expect(merkleClaim(f, old, bob, 1)).to.be.revertedWithCustomError(f.pool, "AlreadyChecked");
    await withdraw(f, bob, 9n);
    expect(await clear(await f.token.confidentialBalanceOf(f.address))).to.equal(0n);
  });
});
