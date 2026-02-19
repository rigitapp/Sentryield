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

interface AllowlistSets {
  tokens: string[];
  targets: string[];
  pools: string[];
}

const OWNER_ROLE = ethers.id("OWNER_ROLE");
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const PROTOCOL_ADDRESS_KEY =
  /^(CURVANCE(?:_[A-Z0-9]+)?|MORPHO(?:_[A-Z0-9]+)?|GEARBOX(?:_[A-Z0-9]+)?|TOWNSQUARE(?:_[A-Z0-9]+)?|NEVERLAND(?:_[A-Z0-9]+)?)_(TOKEN_IN_ADDRESS|LP_TOKEN_ADDRESS|TARGET_ADAPTER_ADDRESS|POOL_ADDRESS)$/;
const PROTOCOL_POOL_KEY = /^(CURVANCE|MORPHO|GEARBOX|TOWNSQUARE|NEVERLAND)(?:_[A-Z0-9]+)?$/;

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  return raw.toLowerCase() === "true";
}

function normalizeIfAddress(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const normalized = ethers.getAddress(trimmed);
    return normalized.toLowerCase() === ZERO_ADDRESS ? null : normalized;
  } catch {
    return null;
  }
}

function parseAddressList(raw?: string): string[] {
  if (!raw) return [];
  const parsed = raw
    .split(",")
    .map((value) => normalizeIfAddress(value))
    .filter((value): value is string => Boolean(value));
  return unique(parsed);
}

function unique(addresses: string[]): string[] {
  return [...new Set(addresses.map((address) => ethers.getAddress(address)))];
}

function parsePoolKeys(raw?: string): Set<string> {
  if (!raw) return new Set();
  const values = raw
    .split(",")
    .map((value) => value.trim().toUpperCase())
    .filter((value) => PROTOCOL_POOL_KEY.test(value));
  return new Set(values);
}

function resolveEnabledPoolKeysFromEnv(env: NodeJS.ProcessEnv): Set<string> {
  const active = new Set<string>();
  for (const [key, rawValue] of Object.entries(env)) {
    if (!key.endsWith("_ENABLED")) continue;
    if (!rawValue || rawValue.trim().toLowerCase() !== "true") continue;
    const poolKey = key.slice(0, -"_ENABLED".length).toUpperCase();
    if (PROTOCOL_POOL_KEY.test(poolKey)) {
      active.add(poolKey);
    }
  }
  return active;
}

function collectProtocolAllowlistsFromEnv(
  env: NodeJS.ProcessEnv,
  includeDisabled: boolean,
  activePoolKeys: Set<string>
): AllowlistSets {
  const tokens: string[] = [];
  const targets: string[] = [];
  const pools: string[] = [];

  for (const [key, rawValue] of Object.entries(env)) {
    if (!rawValue) continue;
    const match = key.match(PROTOCOL_ADDRESS_KEY);
    if (!match) continue;

    const poolKey = match[1].toUpperCase();
    const suffix = match[2];
    if (!includeDisabled && !activePoolKeys.has(poolKey)) continue;

    const normalized = normalizeIfAddress(rawValue);
    if (!normalized) continue;

    if (suffix === "TOKEN_IN_ADDRESS" || suffix === "LP_TOKEN_ADDRESS") {
      tokens.push(normalized);
      continue;
    }
    if (suffix === "TARGET_ADAPTER_ADDRESS") {
      targets.push(normalized);
      continue;
    }
    if (suffix === "POOL_ADDRESS") {
      pools.push(normalized);
    }
  }

  return {
    tokens: unique(tokens),
    targets: unique(targets),
    pools: unique(pools)
  };
}

function getCurvanceDefaults(
  config: CurvanceMainnetConfig,
  adapterAddress: string | null
): AllowlistSets {
  const tokens = unique([
    config.tokens.USDC,
    config.tokens.AUSD,
    config.curvance.usdcReceiptToken,
    config.curvance.ausdReceiptToken
  ]);

  const targets = unique(
    [
      adapterAddress,
      config.curvance.usdcMarket,
      config.curvance.ausdMarket
    ].filter((value): value is string => Boolean(value))
  );

  const pools = unique([config.curvance.usdcMarket, config.curvance.ausdMarket]);

  return { tokens, targets, pools };
}

async function maybeSetToken(vault: any, token: string): Promise<void> {
  const allowed = (await vault.tokenAllowlist(token)) as boolean;
  if (allowed) return;
  const tx = await vault.setTokenAllowlist(token, true);
  await tx.wait();
  console.log(`Allowlisted token: ${token}`);
}

async function maybeSetTarget(vault: any, target: string): Promise<void> {
  const allowed = (await vault.targetAllowlist(target)) as boolean;
  if (allowed) return;
  const tx = await vault.setTargetAllowlist(target, true);
  await tx.wait();
  console.log(`Allowlisted target: ${target}`);
}

async function maybeSetPool(vault: any, pool: string): Promise<void> {
  const allowed = (await vault.poolAllowlist(pool)) as boolean;
  if (allowed) return;
  const tx = await vault.setPoolAllowlist(pool, true);
  await tx.wait();
  console.log(`Allowlisted pool: ${pool}`);
}

async function main(): Promise<void> {
  const vaultAddress = ethers.getAddress(requireEnv("VAULT_ADDRESS"));
  const ownerAddress = ethers.getAddress(requireEnv("OWNER_ADDRESS"));
  const ownerPrivateKey = process.env.OWNER_PRIVATE_KEY ?? process.env.DEPLOYER_PRIVATE_KEY;
  if (!ownerPrivateKey) {
    throw new Error("Set OWNER_PRIVATE_KEY (or DEPLOYER_PRIVATE_KEY) to configure vault.");
  }

  const includeCurvanceDefaults = envBool("ALLOWLIST_INCLUDE_CURVANCE_DEFAULTS", true);
  const includeDisabledPoolConfigs = envBool("ALLOWLIST_INCLUDE_DISABLED_POOL_CONFIGS", false);
  const allowlistOnlyPoolKeys = envBool("ALLOWLIST_ONLY_POOL_KEYS", false);
  const explicitPoolKeys = parsePoolKeys(process.env.ALLOWLIST_POOL_KEYS);
  const enabledPoolKeys = resolveEnabledPoolKeysFromEnv(process.env);
  const activePoolKeys = allowlistOnlyPoolKeys
    ? explicitPoolKeys
    : new Set([...enabledPoolKeys, ...explicitPoolKeys]);
  const curvanceAdapter = normalizeIfAddress(process.env.CURVANCE_TARGET_ADAPTER_ADDRESS ?? "");

  const configPath = join(__dirname, "..", "config", "curvance.monad.mainnet.json");
  const curvanceConfig = JSON.parse(readFileSync(configPath, "utf8")) as CurvanceMainnetConfig;
  const fromEnv = collectProtocolAllowlistsFromEnv(
    process.env,
    includeDisabledPoolConfigs,
    activePoolKeys
  );
  const defaults = includeCurvanceDefaults
    ? getCurvanceDefaults(curvanceConfig, curvanceAdapter)
    : { tokens: [], targets: [], pools: [] };

  const tokenAllowlist = unique([
    ...defaults.tokens,
    ...fromEnv.tokens,
    ...parseAddressList(process.env.INIT_TOKEN_ALLOWLIST)
  ]);
  const targetAllowlist = unique([
    ...defaults.targets,
    ...fromEnv.targets,
    ...fromEnv.pools,
    ...parseAddressList(process.env.INIT_TARGET_ALLOWLIST)
  ]);
  const poolAllowlist = unique([
    ...defaults.pools,
    ...fromEnv.pools,
    ...parseAddressList(process.env.INIT_POOL_ALLOWLIST)
  ]);

  console.log(
    `Allowlist candidates | tokens=${tokenAllowlist.length} targets=${targetAllowlist.length} pools=${poolAllowlist.length}`
  );

  const provider = ethers.provider;
  const signer = new ethers.Wallet(ownerPrivateKey, provider);
  const signerAddress = await signer.getAddress();
  console.log(`Config signer: ${signerAddress}`);

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
  const vault = new ethers.Contract(vaultAddress, vaultAbi, signer);

  const ownerHasRole = (await vault.hasRole(OWNER_ROLE, signerAddress)) as boolean;
  if (!ownerHasRole) {
    throw new Error(`Signer ${signerAddress} lacks OWNER_ROLE. Expected owner: ${ownerAddress}.`);
  }

  for (const token of tokenAllowlist) {
    await maybeSetToken(vault, token);
  }
  for (const target of targetAllowlist) {
    await maybeSetTarget(vault, target);
  }
  for (const pool of poolAllowlist) {
    await maybeSetPool(vault, pool);
  }

  const dailyMovementCapRaw = process.env.DAILY_MOVEMENT_CAP_BPS?.trim();
  if (dailyMovementCapRaw) {
    const desiredDailyMovementCapBps = Number(dailyMovementCapRaw);
    if (
      !Number.isFinite(desiredDailyMovementCapBps) ||
      desiredDailyMovementCapBps < 0 ||
      desiredDailyMovementCapBps > 10_000
    ) {
      throw new Error(
        `Invalid DAILY_MOVEMENT_CAP_BPS: ${dailyMovementCapRaw}. Expected 0..10000.`
      );
    }

    const currentDailyCapBps = Number(await vault.dailyMovementCapBps());
    if (currentDailyCapBps !== desiredDailyMovementCapBps) {
      const tx = await vault.setDailyMovementCapBps(desiredDailyMovementCapBps);
      await tx.wait();
      console.log(`Set daily movement cap bps: ${desiredDailyMovementCapBps}`);
    }
  }

  console.log("Vault configuration complete.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
