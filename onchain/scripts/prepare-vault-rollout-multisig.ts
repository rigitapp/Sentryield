import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import dotenv from "dotenv";
import { ethers } from "ethers";

const ONCHAIN_ROOT = resolve(__dirname, "..");
const WORKSPACE_ROOT = resolve(ONCHAIN_ROOT, "..");

dotenv.config({ path: resolve(WORKSPACE_ROOT, ".env") });
dotenv.config({ path: resolve(ONCHAIN_ROOT, ".env") });
dotenv.config();

function readEnvFile(filePath: string): Record<string, string> {
  try {
    return dotenv.parse(readFileSync(filePath, "utf8"));
  } catch {
    return {};
  }
}

const FILE_ENV = {
  ...readEnvFile(resolve(WORKSPACE_ROOT, ".env")),
  ...readEnvFile(resolve(ONCHAIN_ROOT, ".env"))
};

function resolveEnvValue(name: string): string | undefined {
  const runtimeValue = process.env[name]?.trim();
  if (runtimeValue) return runtimeValue;
  const fileValue = FILE_ENV[name]?.trim();
  if (fileValue) return fileValue;
  return undefined;
}

function hydrateEnvFromFiles(baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const hydrated: NodeJS.ProcessEnv = { ...baseEnv };
  for (const [key, value] of Object.entries(FILE_ENV)) {
    if (!value?.trim()) continue;
    const existing = hydrated[key]?.trim();
    if (existing) continue;
    hydrated[key] = value;
  }
  return hydrated;
}

interface RolloutProfile {
  id: string;
  vaultAddressEnv: string;
  poolKeys: string[];
  outputFile: string;
}

const PROFILES: RolloutProfile[] = [
  {
    id: "ausd",
    vaultAddressEnv: "VAULT_AUSD_ADDRESS",
    poolKeys: ["CURVANCE_AUSD", "MORPHO_AUSD", "NEVERLAND_AUSD", "GEARBOX_AUSD"],
    outputFile: "multisig-plan.vault-ausd.json"
  },
  {
    id: "shmon",
    vaultAddressEnv: "VAULT_SHMON_ADDRESS",
    poolKeys: ["MORPHO_SHMON", "NEVERLAND_SHMON", "GEARBOX_SHMON"],
    outputFile: "multisig-plan.vault-shmon.json"
  }
];

function readAddress(envName: string): string | null {
  const value = resolveEnvValue(envName);
  if (!value) return null;
  try {
    return ethers.getAddress(value);
  } catch {
    throw new Error(`Invalid ${envName}: ${value}`);
  }
}

function runProfile(profile: RolloutProfile, vaultAddress: string): void {
  const poolKeys = profile.poolKeys.join(",");
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  const hydratedEnv = hydrateEnvFromFiles(process.env);
  const child = spawnSync(`${npmCommand} run prepare:configure:vault:multisig:monad`, {
    cwd: ONCHAIN_ROOT,
    shell: true,
    env: {
      ...hydratedEnv,
      VAULT_ADDRESS: vaultAddress,
      ALLOWLIST_INCLUDE_CURVANCE_DEFAULTS: "false",
      ALLOWLIST_ONLY_POOL_KEYS: "true",
      ALLOWLIST_POOL_KEYS: poolKeys,
      MULTISIG_TX_OUTPUT_PATH: profile.outputFile
    },
    encoding: "utf8"
  });

  if (child.stdout) {
    process.stdout.write(child.stdout);
  }
  if (child.stderr) {
    process.stderr.write(child.stderr);
  }
  if (child.error) {
    throw new Error(`Failed spawning command for ${profile.id}: ${child.error.message}`);
  }
  if (child.status !== 0) {
    throw new Error(
      `Failed generating ${profile.id} plan (exit=${child.status ?? "unknown"}).`
    );
  }

  console.log(
    `[rollout-plan] ${profile.id} -> ${resolve(ONCHAIN_ROOT, profile.outputFile)} (pool keys: ${poolKeys})`
  );
}

function main(): void {
  let generated = 0;

  for (const profile of PROFILES) {
    const vaultAddress = readAddress(profile.vaultAddressEnv);
    if (!vaultAddress) {
      console.log(
        `[rollout-plan] skipped ${profile.id}: set ${profile.vaultAddressEnv} to generate this plan.`
      );
      continue;
    }
    runProfile(profile, vaultAddress);
    generated += 1;
  }

  if (generated === 0) {
    console.log(
      "[rollout-plan] No plans generated. Configure VAULT_AUSD_ADDRESS and/or VAULT_SHMON_ADDRESS first."
    );
  }
}

main();
