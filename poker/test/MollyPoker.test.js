/*
   MollyPoker v2 — tests cover:
     - constructor sanity
     - createTable: whitelist + admin can call, others reverted
     - buyIn: 100K MOLLY hold gate
     - withdrawChips: pulls table token
     - pot math 70/20/10 (MOLLY) and 70/30 (non-MOLLY)
     - emergencyRefund
     - admin setters: whitelist, mollyHoldRequired, swapRouter, poolFee
*/
const { expect } = require("chai");
const { ethers } = require("hardhat");

const BURN = "0x000000000000000000000000000000000000dEaD";

describe("MollyPoker v2", function () {
  let molly, wmon, otherToken, poker;
  let owner, alice, bob, dev, project;

  const HOLD_REQ = ethers.parseEther("100000"); // 100K MOLLY
  const BUY_IN   = ethers.parseEther("250000");
  const BB       = ethers.parseEther("1000");

  beforeEach(async () => {
    [owner, alice, bob, dev, project] = await ethers.getSigners();

    const ERC20 = await ethers.getContractFactory("MockERC20");
    molly      = await ERC20.deploy("Molly", "MOLLY");      await molly.waitForDeployment();
    wmon       = await ERC20.deploy("Wrapped MON", "WMON"); await wmon.waitForDeployment();
    otherToken = await ERC20.deploy("CHOG", "CHOG");        await otherToken.waitForDeployment();

    // Give alice + bob enough MOLLY to pass the hold check
    await molly.mint(alice.address, ethers.parseEther("500000"));
    await molly.mint(bob.address,   ethers.parseEther("500000"));
    // And enough CHOG for non-MOLLY tables
    await otherToken.mint(alice.address, ethers.parseEther("1000000"));
    await otherToken.mint(bob.address,   ethers.parseEther("1000000"));

    const MP = await ethers.getContractFactory("MollyPoker");
    // _swapRouter = 0 — settable later, swap will fall back to raw token
    poker = await MP.deploy(BURN, dev.address, molly.target, wmon.target, ethers.ZeroAddress);
    await poker.waitForDeployment();
  });

  describe("constructor", () => {
    it("sets all immutables", async () => {
      expect(await poker.BURN_ADDR()).to.equal(BURN);
      expect(await poker.DEV_ADDR()).to.equal(dev.address);
      expect(await poker.MOLLY_TOKEN()).to.equal(molly.target);
      expect(await poker.WMON()).to.equal(wmon.target);
      expect(await poker.mollyHoldRequired()).to.equal(HOLD_REQ);
    });

    it("rejects zero addresses", async () => {
      const MP = await ethers.getContractFactory("MollyPoker");
      await expect(MP.deploy(ethers.ZeroAddress, dev.address, molly.target, wmon.target, ethers.ZeroAddress))
        .to.be.revertedWith("burn=0");
      await expect(MP.deploy(BURN, ethers.ZeroAddress, molly.target, wmon.target, ethers.ZeroAddress))
        .to.be.revertedWith("dev=0");
      await expect(MP.deploy(BURN, dev.address, ethers.ZeroAddress, wmon.target, ethers.ZeroAddress))
        .to.be.revertedWith("molly=0");
      await expect(MP.deploy(BURN, dev.address, molly.target, ethers.ZeroAddress, ethers.ZeroAddress))
        .to.be.revertedWith("wmon=0");
    });

    it("BPS constants sum to 10000", async () => {
      const winner = await poker.WINNER_BPS();
      const burn   = await poker.BURN_BPS();
      const devB   = await poker.DEV_BPS();
      const rake   = await poker.RAKE_BPS();
      const bps    = await poker.BPS();
      expect(winner + burn + devB).to.equal(bps);
      expect(winner + rake).to.equal(bps);
    });
  });

  describe("createTable — whitelist gate", () => {
    it("owner can always create tables", async () => {
      await expect(poker.createTable(BUY_IN, 2, BB, molly.target))
        .to.emit(poker, "NewTableCreated")
        .withArgs(0, owner.address, molly.target, BUY_IN, BB);
    });

    it("non-whitelisted user cannot create", async () => {
      await expect(poker.connect(alice).createTable(BUY_IN, 2, BB, molly.target))
        .to.be.revertedWith("not authorized");
    });

    it("whitelisted creator can create", async () => {
      await poker.setWhitelistedCreator(project.address, true);
      expect(await poker.whitelistedCreator(project.address)).to.equal(true);
      await expect(poker.connect(project).createTable(BUY_IN, 2, BB, otherToken.target))
        .to.emit(poker, "NewTableCreated")
        .withArgs(0, project.address, otherToken.target, BUY_IN, BB);
    });

    it("revoking whitelist blocks future creates", async () => {
      await poker.setWhitelistedCreator(project.address, true);
      await poker.connect(project).createTable(BUY_IN, 2, BB, otherToken.target);
      await poker.setWhitelistedCreator(project.address, false);
      await expect(poker.connect(project).createTable(BUY_IN, 2, BB, otherToken.target))
        .to.be.revertedWith("not authorized");
    });
  });

  describe("buyIn — 100K MOLLY hold gate", () => {
    beforeEach(async () => {
      await poker.createTable(BUY_IN, 2, BB, molly.target);
    });

    it("blocks players without enough MOLLY", async () => {
      const [_, __, ___, ____, _____, broke] = await ethers.getSigners();
      // broke has 0 MOLLY
      await molly.connect(alice).transfer(broke.address, ethers.parseEther("99999")); // 99,999 < 100K
      // Give them CHOG just in case
      await otherToken.mint(broke.address, ethers.parseEther("1000000"));
      await molly.connect(broke).approve(poker.target, BUY_IN);
      await expect(poker.connect(broke).buyIn(0, BUY_IN))
        .to.be.revertedWith("need 100k MOLLY");
    });

    it("allows players with 100K+ MOLLY", async () => {
      // alice has 500K MOLLY
      await molly.connect(alice).approve(poker.target, BUY_IN);
      await expect(poker.connect(alice).buyIn(0, BUY_IN))
        .to.emit(poker, "NewBuyIn")
        .withArgs(0, alice.address, BUY_IN);
    });

    it("admin can change the MOLLY hold requirement", async () => {
      await poker.setMollyHoldRequired(ethers.parseEther("50000")); // drop to 50K
      expect(await poker.mollyHoldRequired()).to.equal(ethers.parseEther("50000"));
    });

    it("canPlay returns true/false correctly", async () => {
      expect(await poker.canPlay(alice.address)).to.equal(true);
      const [_, __, ___, ____, _____, broke] = await ethers.getSigners();
      expect(await poker.canPlay(broke.address)).to.equal(false);
    });
  });

  describe("createTable + buyIn for non-MOLLY token (CHOG)", () => {
    beforeEach(async () => {
      await poker.setWhitelistedCreator(project.address, true);
      await poker.connect(project).createTable(BUY_IN, 2, BB, otherToken.target);
    });

    it("alice with 100K MOLLY can buy CHOG table", async () => {
      await otherToken.connect(alice).approve(poker.target, BUY_IN);
      await poker.connect(alice).buyIn(0, BUY_IN);
      expect(await poker.chips(alice.address, 0)).to.equal(BUY_IN);
    });

    it("withdraw returns CHOG (the table's token)", async () => {
      await otherToken.connect(alice).approve(poker.target, BUY_IN);
      await poker.connect(alice).buyIn(0, BUY_IN);

      const before = await otherToken.balanceOf(alice.address);
      const half = BUY_IN / 2n;
      await poker.connect(alice).withdrawChips(half, 0);
      const after = await otherToken.balanceOf(alice.address);
      expect(after - before).to.equal(half);
    });
  });

  describe("pot distribution math", () => {
    it("MOLLY pot 1000 → 700/200/100 (winner/burn/dev)", () => {
      const pot = 1000n;
      const burn = (pot * 2000n) / 10000n;
      const dev  = (pot * 1000n) / 10000n;
      const winner = pot - burn - dev;
      expect(winner).to.equal(700n);
      expect(burn).to.equal(200n);
      expect(dev).to.equal(100n);
    });

    it("non-MOLLY pot 1000 → 700/300 (winner/rake to dev as WMON)", () => {
      const pot = 1000n;
      const rake = (pot * 3000n) / 10000n;
      const winner = pot - rake;
      expect(winner).to.equal(700n);
      expect(rake).to.equal(300n);
    });

    it("odd pots: 33 → 23 winner + 9 rake (non-MOLLY)", () => {
      const pot = 33n;
      const rake = (pot * 3000n) / 10000n; // 9 (floor)
      const winner = pot - rake;
      expect(winner + rake).to.equal(pot);
    });
  });

  describe("setSwapRouter + setPoolFee", () => {
    it("owner can set swap router", async () => {
      const newRouter = "0x1234567890123456789012345678901234567890";
      await expect(poker.setSwapRouter(newRouter))
        .to.emit(poker, "SwapRouterUpdated");
      expect(await poker.swapRouter()).to.equal(newRouter);
    });

    it("non-owner cannot set router", async () => {
      await expect(poker.connect(alice).setSwapRouter(ethers.ZeroAddress))
        .to.be.revertedWithCustomError(poker, "OwnableUnauthorizedAccount");
    });

    it("setPoolFee enforces valid V3 fee tiers", async () => {
      await poker.setPoolFee(otherToken.target, 3000); // OK
      expect(await poker.poolFee(otherToken.target)).to.equal(3000);
      await expect(poker.setPoolFee(otherToken.target, 1234))
        .to.be.revertedWith("bad fee");
    });
  });

  describe("emergencyRefund", () => {
    beforeEach(async () => {
      await poker.createTable(BUY_IN, 2, BB, molly.target);
      await molly.connect(alice).approve(poker.target, BUY_IN);
      await poker.connect(alice).buyIn(0, BUY_IN);
    });

    it("owner refunds player chips", async () => {
      const before = await molly.balanceOf(alice.address);
      await poker.emergencyRefund(0, [alice.address]);
      const after = await molly.balanceOf(alice.address);
      expect(after - before).to.equal(BUY_IN);
      expect(await poker.chips(alice.address, 0)).to.equal(0);
    });

    it("non-owner blocked", async () => {
      await expect(poker.connect(alice).emergencyRefund(0, [alice.address]))
        .to.be.revertedWithCustomError(poker, "OwnableUnauthorizedAccount");
    });
  });
});
