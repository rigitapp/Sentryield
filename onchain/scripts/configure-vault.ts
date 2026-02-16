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
  if (!value) throw new Error(`Missing required env var: ${name}`);
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

async function maybeSetToken(vault: any, token: string): Promise<void> {
  const allowed = await vault.tokenAllowlist(token);
  if (allowed) return;
  const tx = await vault.setTokenAllowlist(token, true);
  await tx.wait();
  console.log(`Allowlisted token: ${token}`);
}

async function maybeSetTarget(vault: any, target: string): Promise<void> {
  const allowed = await vault.targetAllowlist(target);
  if (allowed) return;
  const tx = await vault.setTargetAllowlist(target, true);
  await tx.wait();
  console.log(`Allowlisted target: ${target}`);
}

async function maybeSetPool(vault: any, pool: string): Promise<void> {
  const allowed = await vault.poolAllowlist(pool);
  if (allowed) return;
  const tx = await vault.setPoolAllowlist(pool, true);
  await tx.wait();
  console.log(`Allowlisted pool: ${pool}`);
}

async function main(): Promise<void> {
  const vaultAddress = requireEnv("VAULT_ADDRESS");
  const adapterAddress = requireEnv("CURVANCE_TARGET_ADAPTER_ADDRESS");
  const ownerAddress = requireEnv("OWNER_ADDRESS");
  const ownerPrivateKey = process.env.OWNER_PRIVATE_KEY ?? process.env.DEPLOYER_PRIVATE_KEY;
  if (!ownerPrivateKey) {
    throw new Error("Set OWNER_PRIVATE_KEY (or DEPLOYER_PRIVATE_KEY) to configure vault.");
  }

  const configPath = join(__dirname, "..", "config", "curvance.monad.mainnet.json");
  const curvanceConfig = JSON.parse(
    readFileSync(configPath, "utf8")
  ) as CurvanceMainnetConfig;

  const provider = ethers.provider;
  const signer = new ethers.Wallet(ownerPrivateKey, provider);
  const signerAddress = await signer.getAddress();
  console.log(`Config signer: ${signerAddress}`);

  const vaultAbi = [
    "function hasRole(bytes32 role, address account) view returns (bool)",
    "function tokenAllowlist(address) view returns (bool)",
    "function targetAllowlist(address) view returns (bool)",
    "function poolAllowlist(address) view returns (bool)",
    "function setTokenAllowlist(address,bool)",
    "function setTargetAllowlist(address,bool)",
    "function setPoolAllowlist(address,bool)",
    "function setDailyMovementCapBps(uint16)"
  ];
  const vault = new ethers.Contract(vaultAddress, vaultAbi, signer);

  const ownerHasRole = await vault.hasRole(OWNER_ROLE, signerAddress);
  if (!ownerHasRole) {
    throw new Error(
      `Signer ${signerAddress} lacks OWNER_ROLE. Expected owner: ${ownerAddress}.`
    );
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
    await maybeSetToken(vault, token);
  }
  for (const target of targetAllowlist) {
    await maybeSetTarget(vault, target);
  }
  for (const pool of poolAllowlist) {
    await maybeSetPool(vault, pool);
  }

  const dailyMovementCapBps = Number(process.env.DAILY_MOVEMENT_CAP_BPS ?? "0");
  if (dailyMovementCapBps > 0) {
    const tx = await vault.setDailyMovementCapBps(dailyMovementCapBps);
    await tx.wait();
    console.log(`Set daily movement cap bps: ${dailyMovementCapBps}`);
  }

  console.log("Vault configuration complete.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
