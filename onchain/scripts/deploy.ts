import { ethers } from "hardhat";
import dotenv from "dotenv";
import { readFileSync } from "node:fs";
import { join } from "node:path";

dotenv.config({ path: "../.env" });
dotenv.config();

interface CurvanceMainnetConfig {
  tokens: {
    USDC: string;
    AUSD: string;
  };
  curvance: {
    usdcMarket: string;
    usdcReceiptToken: string;
    ausdMarket: string;
    ausdReceiptToken: string;
  };
}

const OWNER_ROLE = ethers.id("OWNER_ROLE");

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function parseAddressList(raw?: string): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

function unique(addresses: string[]): string[] {
  return [...new Set(addresses.map((address) => address.toLowerCase()))];
}

async function main(): Promise<void> {
  const configPath = join(__dirname, "..", "config", "curvance.monad.mainnet.json");
  const curvanceConfig = JSON.parse(
    readFileSync(configPath, "utf8")
  ) as CurvanceMainnetConfig;

  const owner = requireEnv("OWNER_ADDRESS");
  const executor = requireEnv("EXECUTOR_ADDRESS");
  const guardian = process.env.GUARDIAN_ADDRESS ?? ethers.ZeroAddress;
  const adapterAddress = requireEnv("CURVANCE_TARGET_ADAPTER_ADDRESS");
  const movementCapBps = Number(process.env.MOVEMENT_CAP_BPS ?? "8000");
  const dailyMovementCapBps = Number(process.env.DAILY_MOVEMENT_CAP_BPS ?? "0");
  const maxDeadlineDelay = Number(process.env.MAX_DEADLINE_DELAY_SECONDS ?? "1800");

  const factory = await ethers.getContractFactory("TreasuryVault");
  const vault = await factory.deploy(
    owner,
    executor,
    guardian,
    movementCapBps,
    maxDeadlineDelay,
    curvanceConfig.tokens.USDC
  );
  await vault.waitForDeployment();

  const vaultAddress = await vault.getAddress();
  console.log(`TreasuryVault deployed at: ${vaultAddress}`);

  const [deployerSigner] = await ethers.getSigners();
  const deployerAddress = await deployerSigner.getAddress();
  const deployerHasOwnerRole = await vault.hasRole(OWNER_ROLE, deployerAddress);
  if (!deployerHasOwnerRole) {
    console.warn(
      [
        "Deployer does not have OWNER_ROLE on the new vault.",
        `deployer=${deployerAddress}`,
        `owner=${owner}`,
        "Skipping allowlist bootstrap to avoid revert.",
        "Next step: set VAULT_ADDRESS to this new vault and run `npm run configure:vault:monad` with OWNER_PRIVATE_KEY."
      ].join(" ")
    );
    return;
  }

  const tokenAllowlist = unique([
    curvanceConfig.tokens.USDC,
    curvanceConfig.tokens.AUSD,
    curvanceConfig.curvance.usdcReceiptToken,
    curvanceConfig.curvance.ausdReceiptToken,
    ...parseAddressList(process.env.INIT_TOKEN_ALLOWLIST)
  ]);
  const targetAllowlist = unique([
    adapterAddress,
    curvanceConfig.curvance.usdcMarket,
    curvanceConfig.curvance.ausdMarket,
    ...parseAddressList(process.env.INIT_TARGET_ALLOWLIST)
  ]);
  const poolAllowlist = unique([
    curvanceConfig.curvance.usdcMarket,
    curvanceConfig.curvance.ausdMarket,
    ...parseAddressList(process.env.INIT_POOL_ALLOWLIST)
  ]);

  for (const token of tokenAllowlist) {
    const tx = await vault.setTokenAllowlist(token, true);
    await tx.wait();
    console.log(`Allowlisted token: ${token}`);
  }

  for (const target of targetAllowlist) {
    const tx = await vault.setTargetAllowlist(target, true);
    await tx.wait();
    console.log(`Allowlisted target: ${target}`);
  }

  for (const pool of poolAllowlist) {
    const tx = await vault.setPoolAllowlist(pool, true);
    await tx.wait();
    console.log(`Allowlisted pool: ${pool}`);
  }

  if (dailyMovementCapBps > 0) {
    const tx = await vault.setDailyMovementCapBps(dailyMovementCapBps);
    await tx.wait();
    console.log(`Set daily movement cap bps: ${dailyMovementCapBps}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
