import { ethers } from "hardhat";
import dotenv from "dotenv";
import { readFileSync, writeFileSync } from "node:fs";
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

interface MultisigTx {
  to: string;
  value: string;
  data: string;
  description: string;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value.trim();
}

function parseAddressList(raw?: string): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

function normalizeAddress(address: string): string {
  return ethers.getAddress(address);
}

function unique(addresses: string[]): string[] {
  return [...new Set(addresses.map((address) => normalizeAddress(address)))];
}

async function main(): Promise<void> {
  const vaultAddress = normalizeAddress(requireEnv("VAULT_ADDRESS"));
  const adapterAddress = normalizeAddress(requireEnv("CURVANCE_TARGET_ADAPTER_ADDRESS"));
  const ownerAddressRaw = process.env.OWNER_ADDRESS?.trim();
  const ownerAddress = ownerAddressRaw ? normalizeAddress(ownerAddressRaw) : null;

  const configPath = join(__dirname, "..", "config", "curvance.monad.mainnet.json");
  const curvanceConfig = JSON.parse(
    readFileSync(configPath, "utf8")
  ) as CurvanceMainnetConfig;

  const network = await ethers.provider.getNetwork();
  const chainId = Number(network.chainId);

  const vaultAbi = [
    "function hasRole(bytes32 role, address account) view returns (bool)",
    "function tokenAllowlist(address) view returns (bool)",
    "function targetAllowlist(address) view returns (bool)",
    "function poolAllowlist(address) view returns (bool)",
    "function dailyMovementCapBps() view returns (uint16)",
    "function setTokenAllowlist(address,bool)",
    "function setTargetAllowlist(address,bool)",
    "function setPoolAllowlist(address,bool)",
    "function setDailyMovementCapBps(uint16)"
  ];
  const vault = new ethers.Contract(vaultAddress, vaultAbi, ethers.provider);

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

  const txs: MultisigTx[] = [];

  for (const token of tokenAllowlist) {
    const allowed = await vault.tokenAllowlist(token);
    if (allowed) continue;
    txs.push({
      to: vaultAddress,
      value: "0",
      data: vault.interface.encodeFunctionData("setTokenAllowlist", [token, true]),
      description: `setTokenAllowlist(${token}, true)`
    });
  }

  for (const target of targetAllowlist) {
    const allowed = await vault.targetAllowlist(target);
    if (allowed) continue;
    txs.push({
      to: vaultAddress,
      value: "0",
      data: vault.interface.encodeFunctionData("setTargetAllowlist", [target, true]),
      description: `setTargetAllowlist(${target}, true)`
    });
  }

  for (const pool of poolAllowlist) {
    const allowed = await vault.poolAllowlist(pool);
    if (allowed) continue;
    txs.push({
      to: vaultAddress,
      value: "0",
      data: vault.interface.encodeFunctionData("setPoolAllowlist", [pool, true]),
      description: `setPoolAllowlist(${pool}, true)`
    });
  }

  const desiredDailyMovementCapBps = Number(process.env.DAILY_MOVEMENT_CAP_BPS ?? "0");
  if (
    Number.isFinite(desiredDailyMovementCapBps) &&
    desiredDailyMovementCapBps >= 0 &&
    desiredDailyMovementCapBps <= 10_000
  ) {
    const currentDailyCapBps = Number(await vault.dailyMovementCapBps());
    if (currentDailyCapBps !== desiredDailyMovementCapBps) {
      txs.push({
        to: vaultAddress,
        value: "0",
        data: vault.interface.encodeFunctionData("setDailyMovementCapBps", [
          desiredDailyMovementCapBps
        ]),
        description: `setDailyMovementCapBps(${desiredDailyMovementCapBps})`
      });
    }
  }

  if (ownerAddress) {
    const ownerRole = ethers.id("OWNER_ROLE");
    const hasOwnerRole = await vault.hasRole(ownerRole, ownerAddress);
    console.log(
      `OWNER_ADDRESS=${ownerAddress} OWNER_ROLE=${hasOwnerRole ? "yes" : "no"}`
    );
  } else {
    console.log("OWNER_ADDRESS not set; OWNER_ROLE check skipped.");
  }

  if (txs.length === 0) {
    console.log("Vault appears already configured. No multisig transactions needed.");
    return;
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    chainId,
    vaultAddress,
    transactionCount: txs.length,
    transactions: txs
  };

  console.log("=== Vault multisig transaction plan ===");
  console.log(`Chain ID: ${chainId}`);
  console.log(`Vault: ${vaultAddress}`);
  txs.forEach((tx, index) => {
    console.log(`${index + 1}. ${tx.description}`);
    console.log(`   to: ${tx.to}`);
    console.log(`   value: ${tx.value}`);
    console.log(`   data: ${tx.data}`);
  });
  console.log("JSON_PLAN_START");
  console.log(JSON.stringify(payload, null, 2));
  console.log("JSON_PLAN_END");

  const outputPath = process.env.MULTISIG_TX_OUTPUT_PATH?.trim();
  if (outputPath) {
    writeFileSync(outputPath, JSON.stringify(payload, null, 2), "utf8");
    console.log(`Saved transaction plan to ${outputPath}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
