const { expect } = require("chai");
const { ethers, fhevm, network } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { createPublicClient, createWalletClient, custom } = require("viem");
const { hardhat } = require("viem/chains");
const { createLocalPasskeySafe } = require("./helpers/local-passkey-safe");
const {
  principal,
  prize,
  deploySavings,
  fundDraw,
  runAdmission,
  createReadSession,
} = require("./helpers/local-savings");

describe("Savings and Draw pages on a local chain", function () {
  this.timeout(180_000);
  let passkey, page, archive;

  before(async function () {
    if (process.env.LOCAL_SAVER_UI !== "1") this.skip();
    expect(network.name).to.equal("hardhat");
    expect(fhevm.isMock).to.equal(true);
    const { createVirtualPasskey } =
      await import("../../web/scripts/test-support/virtual-passkey.mjs");
    passkey = await createVirtualPasskey();
  });
  afterEach(async function () {
    if (page && this.currentTest.state === "failed")
      console.error("Last page:", await page.locator("body").innerText());
  });
  after(async () => {
    archive?.close();
    await passkey?.close();
  });

  it("lets a saver deposit, see enrollment, check and claim a prize, and withdraw everything", async function () {
    const [sponsor, relay, keeper, delegate] = await ethers.getSigners();
    const saver = await createLocalPasskeySafe(passkey, relay);
    const { usdc, wrapper, pool } = await deploySavings(sponsor);
    await fundDraw({ usdc, wrapper, pool }, sponsor);
    await usdc.faucet(saver.address, principal);
    const read = await createReadSession(saver, delegate, pool, wrapper);
    const transport = custom(network.provider);
    const publicClient = createPublicClient({ chain: hardhat, transport, cacheTime: 0 });
    const writer = createWalletClient({ chain: hardhat, transport, account: keeper.address });
    const clients = {
      pool: pool.target,
      account: keeper.address,
      publicClient,
      walletClient: {
        writeContract: (request) => writer.writeContract({ ...request, chain: hardhat }),
      },
    };
    const receipts = new Map();
    const bindings = {
      async submitLocalSafe(calls) {
        let digest;
        const receipt = await saver.send(calls, async (signedDigest) => {
          digest = signedDigest;
          await page.evaluate((value) => window.onLocalSafeSignature(value), signedDigest);
        });
        receipts.set(digest, {
          transactionHash: receipt.hash,
          blockHash: receipt.blockHash,
          blockNumber: BigInt(receipt.blockNumber),
        });
        return receipt.hash;
      },
      localReceipt: (digest) => receipts.get(digest),
      localReadCalls: () => (receipts.size ? [] : read.calls),
      localDecrypt: (handle) => read.decrypt(handle),
      async localPrincipal() {
        const handle = await pool.encryptedPrincipalOf(saver.address);
        return handle === ethers.ZeroHash ? 0n : read.decrypt(handle);
      },
      async localEncrypt(contract, user, amount) {
        expect(user).to.equal(saver.address);
        expect([pool.target, wrapper.target]).to.include(contract);
        const encrypted = await fhevm.createEncryptedInput(contract, user).add64(amount).encrypt();
        return {
          handle: ethers.hexlify(encrypted.handles[0]),
          inputProof: ethers.hexlify(encrypted.inputProof),
        };
      },
      localPublicDecrypt: (handle) => fhevm.publicDecrypt([handle]),
    };
    const { openLocalProofArchive } =
      await import("../scripts/test-support/local-proof-archive.mjs");
    archive = await openLocalProofArchive(pool, network.provider);
    const { openSaverPage } = await import("../../web/scripts/test-support/saver/browser.mjs");
    const app = await openSaverPage(passkey, {
      config: {
        account: saver.address,
        usdc: usdc.target,
        wrapper: wrapper.target,
        pool: pool.target,
      },
      rpc: (request) => network.provider.request(request),
      bindings,
      archive: (url) => archive.fetch(url),
    });
    page = app.page;
    const click = (name) => page.getByRole("button", { name, exact: true }).click();
    const visible = (text) => page.getByText(text, { exact: true }).waitFor();
    const balance = (label, value) =>
      page
        .getByText(label, { exact: true })
        .locator("..")
        .getByText(value, { exact: true })
        .waitFor();

    await page.goto(app.origin + "/savings");
    await balance("Wallet USDC", "3.00 USDC");
    await click("Deposit");
    let sheet = page.getByRole("dialog", { name: "Add to savings" });
    await sheet.getByRole("textbox").fill("3");
    await click("Review deposit");
    await balance("Pool after", "3.00 USDC");
    expect(await saver.nonce()).to.equal(0n);
    await sheet.getByRole("button", { name: "Confirm", exact: true }).click();
    await balance("Savings balance", "3.00 USDC");
    await balance("Wallet USDC", "0.00 USDC");
    await visible("Your savings are being added to future draws automatically.");
    expect(await saver.nonce()).to.equal(1n);
    await runAdmission(pool, clients);
    await visible(
      "Your savings are participating. Eligibility is determined at the end of each draw.",
    );
    await time.increaseTo(await pool.nextDrawAt());
    const { runDrawKeeper } = await import("../../web/netlify/functions/draw-keeper.ts");
    const draw = await runDrawKeeper({ ...clients, minimumPrize: prize });
    expect(draw.status).to.equal("submitted");
    const receipt = await ethers.provider.getTransactionReceipt(draw.hash);
    await archive.indexThrough(receipt.blockNumber);
    expect(await saver.nonce()).to.equal(1n);

    await page.getByRole("link", { name: "Results" }).click();
    await click("Round #1");
    await click("Review check");
    await click("Confirm");
    await visible("Result checked");
    await visible("1.000000 USDC");
    expect(await pool.checked(1n, saver.address)).to.equal(true);
    await click("Check prize");
    await click("Add prize to savings");
    await click("Confirm");
    await visible("Nothing ready to claim");
    expect(await saver.nonce()).to.equal(3n);
    expect(await read.decrypt(pool.encryptedWinningsOf(saver.address))).to.equal(0n);

    await page.getByRole("link", { name: "Save", exact: true }).click();
    await balance("Savings balance", "4.00 USDC");
    await click("Withdraw");
    sheet = page.getByRole("dialog", { name: "Move savings to USDC" });
    await sheet.getByRole("button", { name: /Use maximum/ }).click();
    await click("Review withdrawal");
    await balance("Savings after", "0.00 USDC");
    await sheet.getByRole("button", { name: "Confirm", exact: true }).click();
    await balance("Savings balance", "0.00 USDC");
    await visible("USDC will arrive in your wallet automatically.");
    const batch = await pool.currentWithdrawalBatchId();
    await time.increaseTo(await pool.withdrawalBatchClosesAt(batch));
    const { runWithdrawalKeeper } =
      await import("../../web/netlify/functions/withdrawal-keeper.ts");
    const delivery = await runWithdrawalKeeper({
      ...clients,
      decrypt: (handles) => fhevm.publicDecrypt(handles),
    });
    expect((await delivery.json()).transactions.map((tx) => tx.action)).to.deep.equal([
      "close",
      "settle",
      "payout",
      "deliver",
    ]);
    await page.reload();
    await balance("Wallet USDC", "4.00 USDC");
    await balance("Savings balance", "0.00 USDC");
    await balance("Pending withdrawals", "0.00 USDC");
    await page.waitForFunction(
      (key) => localStorage.getItem(key) === "[]",
      `kettigo:pending-withdrawals:${pool.target}:${saver.address}`,
    );
    expect(await usdc.balanceOf(saver.address)).to.equal(principal + prize);
    expect(await saver.nonce()).to.equal(4n);
    expect(app.pageErrors).to.deep.equal([]);
  });
});
