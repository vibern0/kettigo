const { expect } = require("chai");
const { ethers, fhevm, network } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { createPublicClient, createWalletClient, custom } = require("viem");
const { hardhat } = require("viem/chains");
const { captureMembershipProof } = require("./proofHelper");
const { createLocalPasskeySafe } = require("./helpers/local-passkey-safe");

const {
  principal,
  prize,
  deploySavings,
  fundDraw,
  runAdmission,
  createReadSession,
} = require("./helpers/local-savings");

describe("Candidate savings with background keepers", function () {
  this.timeout(120_000);
  let passkey;

  before(async function () {
    if (network.name !== "hardhat" || !fhevm.isMock) this.skip();
    if (process.env.LOCAL_VIRTUAL_PASSKEY === "1") {
      const { createVirtualPasskey } =
        await import("../../web/scripts/test-support/virtual-passkey.mjs");
      passkey = await createVirtualPasskey();
    }
  });
  after(async function () {
    await passkey?.close();
  });

  it("admits a deposit in the background, closes a funded draw and delivers the claimed savings to USDC", async function () {
    const [sponsor, localSigner, keeper, readDelegate] = await ethers.getSigners();
    const saver = passkey
      ? await createLocalPasskeySafe(passkey, localSigner)
      : {
          address: localSigner.address,
          nonce: () => ethers.provider.getTransactionCount(localSigner.address),
          async send(calls) {
            for (const call of calls)
              expect((await (await localSigner.sendTransaction(call)).wait()).status).to.equal(1);
          },
        };
    const { usdc, wrapper, pool } = await deploySavings(sponsor);
    const transport = custom(network.provider);
    const publicClient = createPublicClient({ chain: hardhat, transport, cacheTime: 0 });
    const writer = createWalletClient({ chain: hardhat, transport, account: keeper.address });
    // The deployed keepers select Sepolia on each write. Only the in-process chain can receive these calls.
    const walletClient = {
      writeContract: (request) => writer.writeContract({ ...request, chain: hardhat }),
    };
    const clients = { pool: pool.target, account: keeper.address, publicClient, walletClient };
    function call(contract, method, args) {
      return { to: contract.target, data: contract.interface.encodeFunctionData(method, args) };
    }
    const { calls: readCalls, decrypt: decryptAmount } = await createReadSession(
      saver,
      readDelegate,
      pool,
      wrapper,
    );

    await fundDraw({ usdc, wrapper, pool }, sponsor);
    await usdc.faucet(saver.address, principal);
    const encrypted = await fhevm
      .createEncryptedInput(wrapper.target, saver.address)
      .add64(principal)
      .encrypt();
    const wrap = wrapper.interface.encodeFunctionData("wrap", [saver.address, principal]);
    const transfer = wrapper.interface.encodeFunctionData(
      "confidentialTransferAndCall(address,bytes32,bytes,bytes)",
      [pool.target, encrypted.handles[0], encrypted.inputProof, "0x"],
    );
    await saver.send([
      ...readCalls,
      call(usdc, "approve", [wrapper.target, principal]),
      call(wrapper, "multicall", [[wrap, transfer]]),
    ]);
    expect(await usdc.balanceOf(saver.address)).to.equal(0n);
    expect(await decryptAmount(pool.encryptedPrincipalOf(saver.address))).to.equal(principal);
    expect((await pool.pendingAdmissionOf(saver.address)).requested).to.equal(true);
    expect(await pool.membershipIndexOf(saver.address)).to.equal(0n);

    const nonceBeforeKeeper = await saver.nonce();
    const admissionHash = await runAdmission(pool, clients);
    expect(
      (await publicClient.getTransaction({ hash: admissionHash })).from.toLowerCase(),
    ).to.equal(keeper.address.toLowerCase());
    expect((await pool.pendingAdmissionOf(saver.address)).requested).to.equal(false);
    expect(await pool.membershipIndexOf(saver.address)).to.equal(1n);
    const proof = await captureMembershipProof(pool, saver.address);
    await time.increaseTo(await pool.nextDrawAt());
    const { runDrawKeeper } = await import("../../web/netlify/functions/draw-keeper.ts");
    const draw = await runDrawKeeper({ ...clients, minimumPrize: prize });
    expect(draw.status).to.equal("submitted");
    expect((await publicClient.waitForTransactionReceipt({ hash: draw.hash })).status).to.equal(
      "success",
    );
    expect(await saver.nonce()).to.equal(nonceBeforeKeeper);
    const drawId = await pool.drawId();
    expect(await pool.checked(drawId, saver.address)).to.equal(false);
    await saver.send([
      call(pool, "checkPrize", [
        drawId,
        saver.address,
        proof.index,
        proof.generation,
        proof.balance,
        proof.siblingHashes,
        proof.siblingSums,
        proof.parentSums,
      ]),
    ]);
    expect(await pool.checked(drawId, saver.address)).to.equal(true);
    expect(await decryptAmount(pool.encryptedAwardOf(drawId, saver.address))).to.equal(prize);
    await saver.send([call(pool, "claimPrizeToSavings", [])]);
    expect(await decryptAmount(pool.encryptedWinningsOf(saver.address))).to.equal(0n);
    expect(await decryptAmount(pool.encryptedPrincipalOf(saver.address))).to.equal(
      principal + prize,
    );

    const withdrawal = await fhevm
      .createEncryptedInput(pool.target, saver.address)
      .add64(principal + prize)
      .encrypt();
    await saver.send([
      call(pool, "requestWithdrawal", [withdrawal.handles[0], withdrawal.inputProof]),
    ]);
    const batch = await pool.currentWithdrawalBatchId();
    expect(await decryptAmount(pool.encryptedPrincipalOf(saver.address))).to.equal(0n);
    const nonceBeforeDelivery = await saver.nonce();
    await time.increaseTo(await pool.withdrawalBatchClosesAt(batch));
    const { runWithdrawalKeeper } =
      await import("../../web/netlify/functions/withdrawal-keeper.ts");
    const response = await runWithdrawalKeeper({
      ...clients,
      decrypt: (handles) => fhevm.publicDecrypt(handles),
    });
    const { transactions, pending } = await response.json();
    expect(pending).to.deep.equal([]);
    expect(transactions.map((tx) => tx.action)).to.deep.equal([
      "close",
      "settle",
      "payout",
      "deliver",
    ]);
    expect(await usdc.balanceOf(saver.address)).to.equal(principal + prize);
    expect(await saver.nonce()).to.equal(nonceBeforeDelivery);
    if (passkey) expect(await saver.nonce()).to.equal(4n);
  });
});
