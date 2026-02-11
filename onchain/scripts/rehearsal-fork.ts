import { ethers, network } from "hardhat";
import { readFileSync } from "node:fs";
import { join } from "node:path";

interface CurvanceMainnetConfig {
  tokens: {
    USDC: string;
  };
  curvance: {
    usdcMarket: string;
    receiptToken: string;
  };
}

const ERC20_ABI = [
  "function balanceOf(address account) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)"
];

const CURVANCE_CTOKEN_ABI = [
  "function previewDeposit(uint256 assets) view returns (uint256 shares)",
  "function previewRedeem(uint256 shares) view returns (uint256 assets)"
];

async function main(): Promise<void> {
  const [owner, executor] = await ethers.getSigners();

  const configPath = join(__dirname, "..", "config", "curvance.monad.mainnet.json");
  const chainConfig = JSON.parse(
    readFileSync(configPath, "utf8")
  ) as CurvanceMainnetConfig;

  const adapterFactory = await ethers.getContractFactory("CurvanceTargetAdapter");
  const adapter = await adapterFactory.deploy();

  const vaultFactory = await ethers.getContractFactory("TreasuryVault");
  const vault = await vaultFactory.deploy(
    owner.address,
    executor.address,
    ethers.ZeroAddress,
    8_000,
    1_800
  );
  await Promise.all([adapter.waitForDeployment(), vault.waitForDeployment()]);

  console.log("Vault:", await vault.getAddress());
  console.log("Adapter:", await adapter.getAddress());

  let usdcAddress = chainConfig.tokens.USDC;
  let marketAddress = chainConfig.curvance.usdcMarket;
  let receiptTokenAddress = chainConfig.curvance.receiptToken;
  const fallbackToMock = process.env.REHEARSAL_FORCE_MOCK === "true";

  if (fallbackToMock) {
    const deployed = await deployMockMarket(owner.address);
    usdcAddress = await deployed.usdc.getAddress();
    marketAddress = await deployed.market.getAddress();
    receiptTokenAddress = marketAddress;
    await deployed.usdc.mint(await vault.getAddress(), ethers.parseUnits("10000", 6));
    console.log("Rehearsal using local mock market.");
  } else {
    const funded = await tryFundVaultFromWhale(usdcAddress, await vault.getAddress());
    if (!funded) {
      const deployed = await deployMockMarket(owner.address);
      usdcAddress = await deployed.usdc.getAddress();
      marketAddress = await deployed.market.getAddress();
      receiptTokenAddress = marketAddress;
      await deployed.usdc.mint(await vault.getAddress(), ethers.parseUnits("10000", 6));
      console.log("Falling back to local mock market (whale funding unavailable).");
    } else {
      receiptTokenAddress = marketAddress;
      console.log("Rehearsal using forked Curvance market.");
    }
  }

  await configureVault({
    vault,
    usdcAddress,
    marketAddress,
    receiptTokenAddress,
    adapterAddress: await adapter.getAddress()
  });

  const cToken = new ethers.Contract(marketAddress, CURVANCE_CTOKEN_ABI, owner);
  const amountIn = ethers.parseUnits("100", 6);
  const previewShares = await cToken.previewDeposit(amountIn);
  const minSharesOut = (previewShares * 99n) / 100n;
  const deadline = BigInt((await timeNow()) + 1_200);

  const enterRequest = {
    target: await adapter.getAddress(),
    pool: marketAddress,
    tokenIn: usdcAddress,
    lpToken: receiptTokenAddress,
    amountIn,
    minOut: minSharesOut,
    deadline,
    data: "0x",
    pair: "USDC/MON",
    protocol: "Curvance",
    netApyBps: 400,
    intendedHoldSeconds: 86_400
  };

  const enterTx = await vault.connect(executor).enterPool(enterRequest);
  const enterReceipt = await enterTx.wait();
  console.log("ENTER tx:", enterReceipt?.hash);

  const receiptToken = new ethers.Contract(receiptTokenAddress, ERC20_ABI, owner);
  const lpBalance = await receiptToken.balanceOf(await vault.getAddress());
  console.log("Vault receipt balance after enter:", lpBalance.toString());

  // Respect the default 80% per-tx movement cap in the rehearsal flow.
  const lpToExit = (lpBalance * 80n) / 100n;
  const previewAssets = await cToken.previewRedeem(lpToExit);
  const minAssetsOut = (previewAssets * 99n) / 100n;
  const exitRequest = {
    target: await adapter.getAddress(),
    pool: marketAddress,
    lpToken: receiptTokenAddress,
    tokenOut: usdcAddress,
    amountIn: lpToExit,
    minOut: minAssetsOut,
    deadline: BigInt((await timeNow()) + 1_200),
    data: "0x",
    pair: "USDC/MON",
    protocol: "Curvance"
  };

  const exitTx = await vault.connect(executor).exitPool(exitRequest);
  const exitReceipt = await exitTx.wait();
  console.log("EXIT tx:", exitReceipt?.hash);

  const usdc = new ethers.Contract(usdcAddress, ERC20_ABI, owner);
  const usdcBalanceAfterExit = await usdc.balanceOf(await vault.getAddress());
  console.log("Vault USDC after exit:", usdcBalanceAfterExit.toString());

  // Re-enter once, then simulate a clearly impossible minOut and skip send.
  const secondEnterTx = await vault.connect(executor).enterPool(enterRequest);
  await secondEnterTx.wait();
  const impossibleRequest = {
    ...enterRequest,
    minOut: previewShares + 10n ** 30n,
    deadline: BigInt((await timeNow()) + 1_200)
  };

  const nonceBefore = await ethers.provider.getTransactionCount(executor.address);
  let reverted = false;
  try {
    await vault.connect(executor).enterPool.staticCall(impossibleRequest);
  } catch {
    reverted = true;
    console.log("Simulation failed as expected for impossible minOut.");
  }
  if (!reverted) {
    throw new Error("Expected simulation failure but staticCall succeeded.");
  }
  const nonceAfter = await ethers.provider.getTransactionCount(executor.address);
  if (nonceAfter !== nonceBefore) {
    throw new Error("Nonce changed during simulated failure; unexpected tx broadcast.");
  }

  console.log("No tx broadcast after failed simulation (nonce unchanged).");
}

async function configureVault(params: {
  vault: any;
  usdcAddress: string;
  marketAddress: string;
  receiptTokenAddress: string;
  adapterAddress: string;
}): Promise<void> {
  const { vault, usdcAddress, marketAddress, receiptTokenAddress, adapterAddress } = params;
  await (await vault.setTokenAllowlist(usdcAddress, true)).wait();
  await (await vault.setTokenAllowlist(receiptTokenAddress, true)).wait();
  await (await vault.setTargetAllowlist(adapterAddress, true)).wait();
  await (await vault.setTargetAllowlist(marketAddress, true)).wait();
  await (await vault.setPoolAllowlist(marketAddress, true)).wait();
}

async function tryFundVaultFromWhale(usdcAddress: string, vaultAddress: string): Promise<boolean> {
  const whale = process.env.FORK_USDC_WHALE;
  if (!whale) return false;

  try {
    await network.provider.request({
      method: "hardhat_impersonateAccount",
      params: [whale]
    });

    const [owner] = await ethers.getSigners();
    await owner.sendTransaction({
      to: whale,
      value: ethers.parseEther("1")
    });

    const whaleSigner = await ethers.getSigner(whale);
    const usdc = new ethers.Contract(usdcAddress, ERC20_ABI, whaleSigner);
    const tx = await usdc.transfer(vaultAddress, ethers.parseUnits("1000", 6));
    await tx.wait();
    return true;
  } catch {
    return false;
  }
}

async function deployMockMarket(owner: string) {
  const mockErc20Factory = await ethers.getContractFactory("MockERC20");
  const mockPoolFactory = await ethers.getContractFactory("MockCurvancePool");

  const usdc = await mockErc20Factory.deploy("USD Coin", "USDC", 6);
  const market = await mockPoolFactory.deploy(owner, await usdc.getAddress(), "Mock cUSDC", "mcUSDC");
  await Promise.all([usdc.waitForDeployment(), market.waitForDeployment()]);
  return { usdc, market };
}

async function timeNow(): Promise<number> {
  const block = await ethers.provider.getBlock("latest");
  return Number(block?.timestamp ?? Math.floor(Date.now() / 1000));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
