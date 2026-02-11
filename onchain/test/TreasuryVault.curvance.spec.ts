import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { anyValue } from "@nomicfoundation/hardhat-chai-matchers/withArgs";
import { expect } from "chai";
import { ethers } from "hardhat";

const MOVEMENT_CAP_BPS = 8_000;
const MAX_DEADLINE_DELAY = 1_800;
const INTENDED_HOLD_SECONDS = 24 * 60 * 60;
const NET_APY_BPS = 550;
const ONE_USDC = 10n ** 6n;
const INITIAL_VAULT_USDC = 1_000_000n * ONE_USDC;

describe("TreasuryVault + CurvanceTargetAdapter", function () {
  async function fixture() {
    const [owner, executor, guardian, stranger] = await ethers.getSigners();

    const mockErc20Factory = await ethers.getContractFactory("MockERC20");
    const usdc = await mockErc20Factory.deploy("USD Coin", "USDC", 6);
    const ausd = await mockErc20Factory.deploy("AUSD", "AUSD", 6);
    const rogue = await mockErc20Factory.deploy("Rogue", "ROG", 6);

    const poolFactory = await ethers.getContractFactory("MockCurvancePool");

    const pool1 = await poolFactory.deploy(
      owner.address,
      await usdc.getAddress(),
      "Curvance cUSDC One",
      "cUSDC1"
    );
    const pool2 = await poolFactory.deploy(
      owner.address,
      await usdc.getAddress(),
      "Curvance cUSDC Two",
      "cUSDC2"
    );

    const adapterFactory = await ethers.getContractFactory("CurvanceTargetAdapter");
    const adapter = await adapterFactory.deploy();

    const vaultFactory = await ethers.getContractFactory("TreasuryVault");
    const vault = await vaultFactory.deploy(
      owner.address,
      executor.address,
      guardian.address,
      MOVEMENT_CAP_BPS,
      MAX_DEADLINE_DELAY
    );

    const vaultAddress = await vault.getAddress();
    const adapterAddress = await adapter.getAddress();
    const pool1Address = await pool1.getAddress();
    const pool2Address = await pool2.getAddress();

    // Allowlist tokens used in v1 tests.
    await vault.setTokenAllowlist(await usdc.getAddress(), true);
    await vault.setTokenAllowlist(await ausd.getAddress(), true);
    await vault.setTokenAllowlist(pool1Address, true);
    await vault.setTokenAllowlist(pool2Address, true);

    // Allowlist adapter target + pool contracts.
    await vault.setTargetAllowlist(adapterAddress, true);
    await vault.setTargetAllowlist(pool1Address, true);
    await vault.setTargetAllowlist(pool2Address, true);
    await vault.setPoolAllowlist(pool1Address, true);
    await vault.setPoolAllowlist(pool2Address, true);

    // Fund vault with USDC for enters.
    await usdc.mint(vaultAddress, INITIAL_VAULT_USDC);
    await rogue.mint(vaultAddress, INITIAL_VAULT_USDC);

    return {
      owner,
      executor,
      guardian,
      stranger,
      vault,
      adapter,
      pool1,
      pool2,
      usdc,
      ausd,
      rogue
    };
  }

  async function makeEnterRequest(params: {
    target: string;
    pool: string;
    tokenIn: string;
    lpToken: string;
    amountIn: bigint;
    minOut?: bigint;
    deadline?: bigint;
    pair?: string;
  }) {
    const latest = await time.latest();
    return {
      target: params.target,
      pool: params.pool,
      tokenIn: params.tokenIn,
      lpToken: params.lpToken,
      amountIn: params.amountIn,
      minOut: params.minOut ?? params.amountIn,
      deadline: params.deadline ?? BigInt(latest + 1_200),
      data: "0x",
      pair: params.pair ?? "USDC/MON",
      protocol: "Curvance",
      netApyBps: NET_APY_BPS,
      intendedHoldSeconds: INTENDED_HOLD_SECONDS
    };
  }

  async function makeExitRequest(params: {
    target: string;
    pool: string;
    lpToken: string;
    tokenOut: string;
    amountIn: bigint;
    minOut?: bigint;
    deadline?: bigint;
    pair?: string;
  }) {
    const latest = await time.latest();
    return {
      target: params.target,
      pool: params.pool,
      lpToken: params.lpToken,
      tokenOut: params.tokenOut,
      amountIn: params.amountIn,
      minOut: params.minOut ?? params.amountIn,
      deadline: params.deadline ?? BigInt(latest + 1_200),
      data: "0x",
      pair: params.pair ?? "USDC/MON",
      protocol: "Curvance"
    };
  }

  describe("A) Vault safety rails", function () {
    it("reverts on disallowed token", async function () {
      const { vault, executor, adapter, pool1, rogue } = await loadFixture(fixture);
      const request = await makeEnterRequest({
        target: await adapter.getAddress(),
        pool: await pool1.getAddress(),
        tokenIn: await rogue.getAddress(),
        lpToken: await pool1.getAddress(),
        amountIn: 100_000n * ONE_USDC
      });

      await expect(vault.connect(executor).enterPool(request))
        .to.be.revertedWithCustomError(vault, "TokenNotAllowlisted")
        .withArgs(await rogue.getAddress());
    });

    it("reverts on disallowed target", async function () {
      const { vault, executor, pool1, usdc, stranger } = await loadFixture(fixture);
      const request = await makeEnterRequest({
        target: stranger.address,
        pool: await pool1.getAddress(),
        tokenIn: await usdc.getAddress(),
        lpToken: await pool1.getAddress(),
        amountIn: 100_000n * ONE_USDC
      });

      await expect(vault.connect(executor).enterPool(request))
        .to.be.revertedWithCustomError(vault, "TargetNotAllowlisted")
        .withArgs(stranger.address);
    });

    it("reverts on disallowed pool", async function () {
      const { vault, owner, executor, adapter, pool1, usdc } = await loadFixture(fixture);
      await vault.connect(owner).setPoolAllowlist(await pool1.getAddress(), false);

      const request = await makeEnterRequest({
        target: await adapter.getAddress(),
        pool: await pool1.getAddress(),
        tokenIn: await usdc.getAddress(),
        lpToken: await pool1.getAddress(),
        amountIn: 100_000n * ONE_USDC
      });

      await expect(vault.connect(executor).enterPool(request))
        .to.be.revertedWithCustomError(vault, "PoolNotAllowlisted")
        .withArgs(await pool1.getAddress());
    });

    it("blocks executor actions while paused", async function () {
      const { vault, guardian, executor, adapter, pool1, usdc } = await loadFixture(
        fixture
      );

      await vault.connect(guardian).pause();
      expect(await vault.paused()).to.equal(true);

      const request = await makeEnterRequest({
        target: await adapter.getAddress(),
        pool: await pool1.getAddress(),
        tokenIn: await usdc.getAddress(),
        lpToken: await pool1.getAddress(),
        amountIn: 100_000n * ONE_USDC
      });
      await expect(vault.connect(executor).enterPool(request)).to.be.revertedWithCustomError(
        vault,
        "EnforcedPause"
      );
    });

    it("enforces per-tx movement cap", async function () {
      const { vault, executor, adapter, pool1, usdc } = await loadFixture(fixture);

      // Balance=1,000,000 USDC and cap=80%, so 900,000 USDC should fail.
      const request = await makeEnterRequest({
        target: await adapter.getAddress(),
        pool: await pool1.getAddress(),
        tokenIn: await usdc.getAddress(),
        lpToken: await pool1.getAddress(),
        amountIn: 900_000n * ONE_USDC
      });

      await expect(vault.connect(executor).enterPool(request)).to.be.revertedWithCustomError(
        vault,
        "MovementCapExceeded"
      );
    });

    it("enforces optional daily movement cap", async function () {
      const { vault, owner, executor, adapter, pool1, usdc } = await loadFixture(fixture);
      await vault.connect(owner).setDailyMovementCapBps(5_000);

      const first = await makeEnterRequest({
        target: await adapter.getAddress(),
        pool: await pool1.getAddress(),
        tokenIn: await usdc.getAddress(),
        lpToken: await pool1.getAddress(),
        amountIn: 300_000n * ONE_USDC
      });
      await vault.connect(executor).enterPool(first);

      const second = await makeEnterRequest({
        target: await adapter.getAddress(),
        pool: await pool1.getAddress(),
        tokenIn: await usdc.getAddress(),
        lpToken: await pool1.getAddress(),
        amountIn: 300_000n * ONE_USDC
      });

      await expect(vault.connect(executor).enterPool(second)).to.be.revertedWithCustomError(
        vault,
        "DailyMovementCapExceeded"
      );
    });

    it("reverts when deadline is expired", async function () {
      const { vault, executor, adapter, pool1, usdc } = await loadFixture(fixture);
      const latest = await time.latest();
      const request = await makeEnterRequest({
        target: await adapter.getAddress(),
        pool: await pool1.getAddress(),
        tokenIn: await usdc.getAddress(),
        lpToken: await pool1.getAddress(),
        amountIn: 100_000n * ONE_USDC,
        deadline: BigInt(latest - 1)
      });

      await expect(vault.connect(executor).enterPool(request))
        .to.be.revertedWithCustomError(vault, "DeadlineExpired")
        .withArgs(BigInt(latest - 1));
    });

    it("reverts on minOut slippage failure", async function () {
      const { vault, executor, owner, adapter, pool1, usdc } = await loadFixture(fixture);

      // Force 10% haircut on deposits in mock pool.
      await pool1.connect(owner).setSlippageBps(9_000, 10_000);

      const amountIn = 100_000n * ONE_USDC;
      const request = await makeEnterRequest({
        target: await adapter.getAddress(),
        pool: await pool1.getAddress(),
        tokenIn: await usdc.getAddress(),
        lpToken: await pool1.getAddress(),
        amountIn,
        minOut: amountIn
      });

      await expect(vault.connect(executor).enterPool(request)).to.be.revertedWithCustomError(
        adapter,
        "SlippageCheckFailed"
      );
    });

    it("enforces roles: only EXECUTOR executes and GUARDIAN can pause only", async function () {
      const { vault, guardian, stranger, adapter, pool1, usdc } = await loadFixture(
        fixture
      );
      const request = await makeEnterRequest({
        target: await adapter.getAddress(),
        pool: await pool1.getAddress(),
        tokenIn: await usdc.getAddress(),
        lpToken: await pool1.getAddress(),
        amountIn: 100_000n * ONE_USDC
      });

      await expect(vault.connect(stranger).enterPool(request)).to.be.revertedWithCustomError(
        vault,
        "AccessControlUnauthorizedAccount"
      );

      await vault.connect(guardian).pause();
      expect(await vault.paused()).to.equal(true);

      await expect(vault.connect(guardian).unpause()).to.be.revertedWithCustomError(
        vault,
        "AccessControlUnauthorizedAccount"
      );
    });
  });

  describe("B) Adapter call path", function () {
    it("enterPool calls Curvance adapter, mints LP, emits PoolEntered", async function () {
      const { vault, executor, adapter, pool1, usdc } = await loadFixture(fixture);
      const amountIn = 600_000n * ONE_USDC;
      const request = await makeEnterRequest({
        target: await adapter.getAddress(),
        pool: await pool1.getAddress(),
        tokenIn: await usdc.getAddress(),
        lpToken: await pool1.getAddress(),
        amountIn,
        minOut: amountIn,
        pair: "USDC/MON"
      });

      await expect(vault.connect(executor).enterPool(request))
        .to.emit(vault, "PoolEntered")
        .withArgs(
          "USDC/MON",
          "Curvance",
          await pool1.getAddress(),
          amountIn,
          amountIn,
          NET_APY_BPS,
          INTENDED_HOLD_SECONDS,
          anyValue
        );

      expect(await pool1.balanceOf(await vault.getAddress())).to.equal(amountIn);
      expect(await usdc.balanceOf(await vault.getAddress())).to.equal(
        INITIAL_VAULT_USDC - amountIn
      );
    });

    it("exitPool calls Curvance adapter, returns tokenOut, emits PoolExited", async function () {
      const { vault, executor, adapter, pool1, usdc } = await loadFixture(fixture);

      const entered = 600_000n * ONE_USDC;
      const enterRequest = await makeEnterRequest({
        target: await adapter.getAddress(),
        pool: await pool1.getAddress(),
        tokenIn: await usdc.getAddress(),
        lpToken: await pool1.getAddress(),
        amountIn: entered
      });
      await vault.connect(executor).enterPool(enterRequest);

      const lpToBurn = 450_000n * ONE_USDC;
      const exitRequest = await makeExitRequest({
        target: await adapter.getAddress(),
        pool: await pool1.getAddress(),
        lpToken: await pool1.getAddress(),
        tokenOut: await usdc.getAddress(),
        amountIn: lpToBurn,
        minOut: lpToBurn,
        pair: "USDC/MON"
      });

      await expect(vault.connect(executor).exitPool(exitRequest))
        .to.emit(vault, "PoolExited")
        .withArgs(
          "USDC/MON",
          "Curvance",
          await pool1.getAddress(),
          lpToBurn,
          lpToBurn,
          anyValue
        );

      expect(await pool1.balanceOf(await vault.getAddress())).to.equal(entered - lpToBurn);
      expect(await usdc.balanceOf(await vault.getAddress())).to.equal(
        INITIAL_VAULT_USDC - entered + lpToBurn
      );
    });

    it("rotate executes exit+enter and emits Rotated", async function () {
      const { vault, executor, adapter, pool1, pool2, usdc } = await loadFixture(
        fixture
      );

      const entered = 600_000n * ONE_USDC;
      const enterPool1 = await makeEnterRequest({
        target: await adapter.getAddress(),
        pool: await pool1.getAddress(),
        tokenIn: await usdc.getAddress(),
        lpToken: await pool1.getAddress(),
        amountIn: entered,
        pair: "AUSD/MON"
      });
      await vault.connect(executor).enterPool(enterPool1);

      const lpToRotate = 450_000n * ONE_USDC;
      const latest = await time.latest();

      const rotateRequest = {
        exitRequest: {
          target: await adapter.getAddress(),
          pool: await pool1.getAddress(),
          lpToken: await pool1.getAddress(),
          tokenOut: await usdc.getAddress(),
          amountIn: lpToRotate,
          minOut: lpToRotate,
          deadline: BigInt(latest + 1_200),
          data: "0x",
          pair: "AUSD/MON",
          protocol: "Curvance"
        },
        enterRequest: {
          target: await adapter.getAddress(),
          pool: await pool2.getAddress(),
          tokenIn: await usdc.getAddress(),
          lpToken: await pool2.getAddress(),
          amountIn: 0n,
          minOut: lpToRotate,
          deadline: BigInt(latest + 1_200),
          data: "0x",
          pair: "USDC/MON",
          protocol: "Curvance",
          netApyBps: 780,
          intendedHoldSeconds: INTENDED_HOLD_SECONDS
        },
        oldNetApyBps: 510,
        newNetApyBps: 780,
        reasonCode: 2
      };

      await expect(vault.connect(executor).rotate(rotateRequest))
        .to.emit(vault, "Rotated")
        .withArgs(
          await pool1.getAddress(),
          await pool2.getAddress(),
          "AUSD/MON",
          "USDC/MON",
          510,
          780,
          2,
          anyValue
        );

      expect(await pool1.balanceOf(await vault.getAddress())).to.equal(entered - lpToRotate);
      expect(await pool2.balanceOf(await vault.getAddress())).to.equal(lpToRotate);
    });
  });
});
