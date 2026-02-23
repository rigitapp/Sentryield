import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import type { Address, PolicyConfig, PoolConfig, RuntimeConfig, TokenConfig } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_ENV_PATH = join(__dirname, "..", "..", ".env");
const CWD_ENV_PATH = join(process.cwd(), ".env");

// Prefer workspace-root .env, then current working directory, then ambient environment.
loadEnv({ path: ROOT_ENV_PATH });
loadEnv({ path: CWD_ENV_PATH });
loadEnv();

const CHAIN_CONFIG_PATH = join(__dirname, "..", "config", "curvance.monad.mainnet.json");
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as Address;

interface CurvanceMainnetConfig {
  chainId: number;
  rpcUrl: string;
  explorerTxBaseUrl: string;
  tokens: {
    USDC: Address;
    AUSD: Address;
    MON: Address;
    WMON: Address;
  };
  curvance: {
    centralRegistry: Address;
    usdcMarket: Address;
    usdcReceiptToken: Address;
    usdcMarketManager: Address;
    ausdMarket: Address;
    ausdReceiptToken: Address;
    ausdMarketManager: Address;
  };
}

const CHAIN_CONFIG = JSON.parse(
  readFileSync(CHAIN_CONFIG_PATH, "utf8")
) as CurvanceMainnetConfig;
const PAIRS = ["AUSD/MON", "USDC/MON", "WMON/MON", "shMON/MON", "kMON/MON"] as const;
const DEFAULT_CURVANCE_PROTOCOL_READER = "0x878cDfc2F3D96a49A5CbD805FAF4F3080768a6d2";
const DEFAULT_MORPHO_GRAPHQL_ENDPOINT = "https://api.morpho.org/graphql";

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (Number.isNaN(value)) {
    throw new Error(`Invalid number for ${name}: ${raw}`);
  }
  return value;
}

function envBigInt(name: string, fallback: bigint): bigint {
  const raw = process.env[name];
  if (!raw) return fallback;
  return BigInt(raw);
}

function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (!raw) return fallback;
  return raw.toLowerCase() === "true";
}

function envString(name: string, fallback: string): string {
  const raw = process.env[name];
  if (!raw) return fallback;
  const trimmed = raw.trim();
  return trimmed || fallback;
}

function envAddress(name: string, fallback: Address = ZERO_ADDRESS): Address {
  return envString(name, fallback) as Address;
}

function envPair(
  name: string,
  fallback: (typeof PAIRS)[number]
): (typeof PAIRS)[number] {
  const value = envString(name, fallback);
  if (PAIRS.includes(value as (typeof PAIRS)[number])) {
    return value as (typeof PAIRS)[number];
  }
  throw new Error(`Invalid pair for ${name}: ${value}`);
}

function envCsvUpper(name: string, fallback: string[]): string[] {
  const raw = process.env[name];
  if (!raw) return fallback;
  const values = raw
    .split(",")
    .map((item) => item.trim().toUpperCase())
    .filter(Boolean);
  return values.length ? values : fallback;
}

export const TOKENS: TokenConfig = {
  USDC: CHAIN_CONFIG.tokens.USDC,
  AUSD: CHAIN_CONFIG.tokens.AUSD,
  MON: CHAIN_CONFIG.tokens.MON,
  WMON: CHAIN_CONFIG.tokens.WMON,
  SHMON: envAddress("TOKEN_SHMON_ADDRESS"),
  KMON: envAddress("TOKEN_KMON_ADDRESS")
};

const MIN_HOLD_SECONDS = Math.max(0, envNumber("MIN_HOLD_SECONDS", 0));

export const POLICY: PolicyConfig = {
  minHoldSeconds: MIN_HOLD_SECONDS,
  rotationDeltaApyBps: 50,
  maxPaybackHours: 72,
  depegThresholdBps: 100,
  maxPriceImpactBps: 30,
  aprCliffDropBps: 5000,
  txDeadlineSeconds: envNumber("TX_DEADLINE_SECONDS", 1_800)
};

const CURVANCE_TARGET_ADAPTER = envAddress("CURVANCE_TARGET_ADAPTER_ADDRESS");
const CURVANCE_BASE_APY_BPS = envNumber("BASE_APY_BPS_CURVANCE_USDC", 420);
const CURVANCE_REWARD_RATE_PER_SECOND = envNumber("CURVANCE_REWARD_RATE_PER_SECOND", 0);
const CURVANCE_PROTOCOL_FEE_BPS = envNumber("CURVANCE_PROTOCOL_FEE_BPS", 8);
const CURVANCE_ROTATION_COST_BPS = envNumber("CURVANCE_ROTATION_COST_BPS", 12);

const CURVANCE_AUSD_TARGET_ADAPTER = envAddress("CURVANCE_AUSD_TARGET_ADAPTER_ADDRESS", CURVANCE_TARGET_ADAPTER);
const CURVANCE_AUSD_BASE_APY_BPS = envNumber("BASE_APY_BPS_CURVANCE_AUSD", 400);
const CURVANCE_AUSD_REWARD_RATE_PER_SECOND = envNumber("CURVANCE_AUSD_REWARD_RATE_PER_SECOND", 0);
const CURVANCE_AUSD_PROTOCOL_FEE_BPS = envNumber("CURVANCE_AUSD_PROTOCOL_FEE_BPS", CURVANCE_PROTOCOL_FEE_BPS);
const CURVANCE_AUSD_ROTATION_COST_BPS = envNumber("CURVANCE_AUSD_ROTATION_COST_BPS", CURVANCE_ROTATION_COST_BPS);

const MORPHO_DEFAULT_PAIR = envPair("MORPHO_PAIR", "USDC/MON");
const MORPHO_TOKEN_IN_ADDRESS = envAddress("MORPHO_TOKEN_IN_ADDRESS", TOKENS.USDC);
const MORPHO_TARGET_ADAPTER_ADDRESS = envAddress("MORPHO_TARGET_ADAPTER_ADDRESS");
const MORPHO_BASE_APY_BPS = envNumber("BASE_APY_BPS_MORPHO", 390);
const MORPHO_REWARD_TOKEN_SYMBOL = envString("MORPHO_REWARD_TOKEN_SYMBOL", "USDC");
const MORPHO_REWARD_RATE_PER_SECOND = envNumber("MORPHO_REWARD_RATE_PER_SECOND", 0);
const MORPHO_PROTOCOL_FEE_BPS = envNumber("MORPHO_PROTOCOL_FEE_BPS", 8);
const MORPHO_ROTATION_COST_BPS = envNumber("MORPHO_ROTATION_COST_BPS", 14);

const MORPHO_AUSD_TARGET_ADAPTER_ADDRESS = envAddress("MORPHO_AUSD_TARGET_ADAPTER_ADDRESS", MORPHO_TARGET_ADAPTER_ADDRESS);
const MORPHO_AUSD_BASE_APY_BPS = envNumber("BASE_APY_BPS_MORPHO_AUSD", 380);
const MORPHO_AUSD_REWARD_TOKEN_SYMBOL = envString("MORPHO_AUSD_REWARD_TOKEN_SYMBOL", "AUSD");
const MORPHO_AUSD_REWARD_RATE_PER_SECOND = envNumber("MORPHO_AUSD_REWARD_RATE_PER_SECOND", 0);
const MORPHO_AUSD_PROTOCOL_FEE_BPS = envNumber("MORPHO_AUSD_PROTOCOL_FEE_BPS", MORPHO_PROTOCOL_FEE_BPS);
const MORPHO_AUSD_ROTATION_COST_BPS = envNumber("MORPHO_AUSD_ROTATION_COST_BPS", MORPHO_ROTATION_COST_BPS);

const MORPHO_SHMON_PAIR = envPair("MORPHO_SHMON_PAIR", "shMON/MON");
const MORPHO_SHMON_TOKEN_IN_ADDRESS = envAddress("MORPHO_SHMON_TOKEN_IN_ADDRESS", TOKENS.SHMON);
const MORPHO_SHMON_TARGET_ADAPTER_ADDRESS = envAddress(
  "MORPHO_SHMON_TARGET_ADAPTER_ADDRESS",
  MORPHO_TARGET_ADAPTER_ADDRESS
);
const MORPHO_SHMON_BASE_APY_BPS = envNumber("BASE_APY_BPS_MORPHO_SHMON", MORPHO_BASE_APY_BPS);
const MORPHO_SHMON_REWARD_TOKEN_SYMBOL = envString("MORPHO_SHMON_REWARD_TOKEN_SYMBOL", "shMON");
const MORPHO_SHMON_REWARD_RATE_PER_SECOND = envNumber("MORPHO_SHMON_REWARD_RATE_PER_SECOND", 0);
const MORPHO_SHMON_PROTOCOL_FEE_BPS = envNumber(
  "MORPHO_SHMON_PROTOCOL_FEE_BPS",
  MORPHO_PROTOCOL_FEE_BPS
);
const MORPHO_SHMON_ROTATION_COST_BPS = envNumber(
  "MORPHO_SHMON_ROTATION_COST_BPS",
  MORPHO_ROTATION_COST_BPS
);

const MORPHO_KMON_PAIR = envPair("MORPHO_KMON_PAIR", "kMON/MON");
const MORPHO_KMON_TOKEN_IN_ADDRESS = envAddress("MORPHO_KMON_TOKEN_IN_ADDRESS", TOKENS.KMON);
const MORPHO_KMON_TARGET_ADAPTER_ADDRESS = envAddress(
  "MORPHO_KMON_TARGET_ADAPTER_ADDRESS",
  MORPHO_TARGET_ADAPTER_ADDRESS
);
const MORPHO_KMON_BASE_APY_BPS = envNumber("BASE_APY_BPS_MORPHO_KMON", MORPHO_BASE_APY_BPS);
const MORPHO_KMON_REWARD_TOKEN_SYMBOL = envString("MORPHO_KMON_REWARD_TOKEN_SYMBOL", "kMON");
const MORPHO_KMON_REWARD_RATE_PER_SECOND = envNumber("MORPHO_KMON_REWARD_RATE_PER_SECOND", 0);
const MORPHO_KMON_PROTOCOL_FEE_BPS = envNumber(
  "MORPHO_KMON_PROTOCOL_FEE_BPS",
  MORPHO_PROTOCOL_FEE_BPS
);
const MORPHO_KMON_ROTATION_COST_BPS = envNumber(
  "MORPHO_KMON_ROTATION_COST_BPS",
  MORPHO_ROTATION_COST_BPS
);

export const POOLS: PoolConfig[] = [
  {
    id: "curvance-usdc-market",
    protocol: "Curvance",
    pair: "USDC/MON",
    tier: "S",
    enabled: envBool("CURVANCE_ENABLED", true),
    adapterId: "curvance",
    tokenIn: TOKENS.USDC,
    target: CURVANCE_TARGET_ADAPTER,
    pool: CHAIN_CONFIG.curvance.usdcMarket,
    lpToken: CHAIN_CONFIG.curvance.usdcReceiptToken,
    baseApyBps: CURVANCE_BASE_APY_BPS,
    rewardTokenSymbol: "USDC",
    rewardRatePerSecond: CURVANCE_REWARD_RATE_PER_SECOND,
    protocolFeeBps: CURVANCE_PROTOCOL_FEE_BPS,
    rotationCostBps: CURVANCE_ROTATION_COST_BPS
  },
  {
    id: "curvance-ausd-market",
    protocol: "Curvance",
    pair: "AUSD/MON",
    tier: "S",
    enabled: envBool("CURVANCE_AUSD_ENABLED", false),
    adapterId: "curvance",
    tokenIn: TOKENS.AUSD,
    target: CURVANCE_AUSD_TARGET_ADAPTER,
    pool: envAddress("CURVANCE_AUSD_POOL_ADDRESS", CHAIN_CONFIG.curvance.ausdMarket),
    lpToken: envAddress("CURVANCE_AUSD_LP_TOKEN_ADDRESS", CHAIN_CONFIG.curvance.ausdReceiptToken),
    baseApyBps: CURVANCE_AUSD_BASE_APY_BPS,
    rewardTokenSymbol: "AUSD",
    rewardRatePerSecond: CURVANCE_AUSD_REWARD_RATE_PER_SECOND,
    protocolFeeBps: CURVANCE_AUSD_PROTOCOL_FEE_BPS,
    rotationCostBps: CURVANCE_AUSD_ROTATION_COST_BPS
  },
  {
    id: "morpho-usdc-vault",
    protocol: "Morpho",
    pair: MORPHO_DEFAULT_PAIR,
    tier: "S",
    enabled: envBool("MORPHO_ENABLED", false),
    adapterId: "morpho",
    tokenIn: MORPHO_TOKEN_IN_ADDRESS,
    target: MORPHO_TARGET_ADAPTER_ADDRESS,
    pool: envAddress("MORPHO_POOL_ADDRESS"),
    lpToken: envAddress("MORPHO_LP_TOKEN_ADDRESS", envAddress("MORPHO_POOL_ADDRESS")),
    baseApyBps: MORPHO_BASE_APY_BPS,
    rewardTokenSymbol: MORPHO_REWARD_TOKEN_SYMBOL,
    rewardRatePerSecond: MORPHO_REWARD_RATE_PER_SECOND,
    protocolFeeBps: MORPHO_PROTOCOL_FEE_BPS,
    rotationCostBps: MORPHO_ROTATION_COST_BPS
  },
  {
    id: "morpho-ausd-vault",
    protocol: "Morpho",
    pair: "AUSD/MON",
    tier: "S",
    enabled: envBool("MORPHO_AUSD_ENABLED", false),
    adapterId: "morpho",
    tokenIn: TOKENS.AUSD,
    target: MORPHO_AUSD_TARGET_ADAPTER_ADDRESS,
    pool: envAddress("MORPHO_AUSD_POOL_ADDRESS"),
    lpToken: envAddress("MORPHO_AUSD_LP_TOKEN_ADDRESS", envAddress("MORPHO_AUSD_POOL_ADDRESS")),
    baseApyBps: MORPHO_AUSD_BASE_APY_BPS,
    rewardTokenSymbol: MORPHO_AUSD_REWARD_TOKEN_SYMBOL,
    rewardRatePerSecond: MORPHO_AUSD_REWARD_RATE_PER_SECOND,
    protocolFeeBps: MORPHO_AUSD_PROTOCOL_FEE_BPS,
    rotationCostBps: MORPHO_AUSD_ROTATION_COST_BPS
  },
  {
    id: "morpho-shmon-vault",
    protocol: "Morpho",
    pair: MORPHO_SHMON_PAIR,
    tier: "S",
    enabled: envBool("MORPHO_SHMON_ENABLED", false),
    adapterId: "morpho",
    tokenIn: MORPHO_SHMON_TOKEN_IN_ADDRESS,
    target: MORPHO_SHMON_TARGET_ADAPTER_ADDRESS,
    pool: envAddress("MORPHO_SHMON_POOL_ADDRESS"),
    lpToken: envAddress(
      "MORPHO_SHMON_LP_TOKEN_ADDRESS",
      envAddress("MORPHO_SHMON_POOL_ADDRESS")
    ),
    baseApyBps: MORPHO_SHMON_BASE_APY_BPS,
    rewardTokenSymbol: MORPHO_SHMON_REWARD_TOKEN_SYMBOL,
    rewardRatePerSecond: MORPHO_SHMON_REWARD_RATE_PER_SECOND,
    protocolFeeBps: MORPHO_SHMON_PROTOCOL_FEE_BPS,
    rotationCostBps: MORPHO_SHMON_ROTATION_COST_BPS
  },
  {
    id: "morpho-kmon-vault",
    protocol: "Morpho",
    pair: MORPHO_KMON_PAIR,
    tier: "S",
    enabled: envBool("MORPHO_KMON_ENABLED", false),
    adapterId: "morpho",
    tokenIn: MORPHO_KMON_TOKEN_IN_ADDRESS,
    target: MORPHO_KMON_TARGET_ADAPTER_ADDRESS,
    pool: envAddress("MORPHO_KMON_POOL_ADDRESS"),
    lpToken: envAddress(
      "MORPHO_KMON_LP_TOKEN_ADDRESS",
      envAddress("MORPHO_KMON_POOL_ADDRESS")
    ),
    baseApyBps: MORPHO_KMON_BASE_APY_BPS,
    rewardTokenSymbol: MORPHO_KMON_REWARD_TOKEN_SYMBOL,
    rewardRatePerSecond: MORPHO_KMON_REWARD_RATE_PER_SECOND,
    protocolFeeBps: MORPHO_KMON_PROTOCOL_FEE_BPS,
    rotationCostBps: MORPHO_KMON_ROTATION_COST_BPS
  },
  {
    id: "gearbox-usdc-vault",
    protocol: "Gearbox",
    pair: envPair("GEARBOX_PAIR", "USDC/MON"),
    tier: "S",
    enabled: envBool("GEARBOX_ENABLED", false),
    adapterId: "gearbox",
    tokenIn: envAddress("GEARBOX_TOKEN_IN_ADDRESS", TOKENS.USDC),
    target: envAddress("GEARBOX_TARGET_ADAPTER_ADDRESS"),
    pool: envAddress("GEARBOX_POOL_ADDRESS"),
    lpToken: envAddress("GEARBOX_LP_TOKEN_ADDRESS", envAddress("GEARBOX_POOL_ADDRESS")),
    baseApyBps: envNumber("BASE_APY_BPS_GEARBOX", 380),
    rewardTokenSymbol: envString("GEARBOX_REWARD_TOKEN_SYMBOL", "USDC"),
    rewardRatePerSecond: envNumber("GEARBOX_REWARD_RATE_PER_SECOND", 0),
    protocolFeeBps: envNumber("GEARBOX_PROTOCOL_FEE_BPS", 9),
    rotationCostBps: envNumber("GEARBOX_ROTATION_COST_BPS", 15)
  },
  {
    id: "gearbox-ausd-vault",
    protocol: "Gearbox",
    pair: envPair("GEARBOX_AUSD_PAIR", "AUSD/MON"),
    tier: "S",
    enabled: envBool("GEARBOX_AUSD_ENABLED", false),
    adapterId: "gearbox",
    tokenIn: envAddress("GEARBOX_AUSD_TOKEN_IN_ADDRESS", TOKENS.AUSD),
    target: envAddress(
      "GEARBOX_AUSD_TARGET_ADAPTER_ADDRESS",
      envAddress("GEARBOX_TARGET_ADAPTER_ADDRESS")
    ),
    pool: envAddress("GEARBOX_AUSD_POOL_ADDRESS"),
    lpToken: envAddress(
      "GEARBOX_AUSD_LP_TOKEN_ADDRESS",
      envAddress("GEARBOX_AUSD_POOL_ADDRESS")
    ),
    baseApyBps: envNumber("BASE_APY_BPS_GEARBOX_AUSD", envNumber("BASE_APY_BPS_GEARBOX", 380)),
    rewardTokenSymbol: envString("GEARBOX_AUSD_REWARD_TOKEN_SYMBOL", "AUSD"),
    rewardRatePerSecond: envNumber("GEARBOX_AUSD_REWARD_RATE_PER_SECOND", 0),
    protocolFeeBps: envNumber("GEARBOX_AUSD_PROTOCOL_FEE_BPS", envNumber("GEARBOX_PROTOCOL_FEE_BPS", 9)),
    rotationCostBps: envNumber(
      "GEARBOX_AUSD_ROTATION_COST_BPS",
      envNumber("GEARBOX_ROTATION_COST_BPS", 15)
    )
  },
  {
    id: "gearbox-shmon-vault",
    protocol: "Gearbox",
    pair: envPair("GEARBOX_SHMON_PAIR", "shMON/MON"),
    tier: "S",
    enabled: envBool("GEARBOX_SHMON_ENABLED", false),
    adapterId: "gearbox",
    tokenIn: envAddress("GEARBOX_SHMON_TOKEN_IN_ADDRESS", TOKENS.SHMON),
    target: envAddress(
      "GEARBOX_SHMON_TARGET_ADAPTER_ADDRESS",
      envAddress("GEARBOX_TARGET_ADAPTER_ADDRESS")
    ),
    pool: envAddress("GEARBOX_SHMON_POOL_ADDRESS"),
    lpToken: envAddress(
      "GEARBOX_SHMON_LP_TOKEN_ADDRESS",
      envAddress("GEARBOX_SHMON_POOL_ADDRESS")
    ),
    baseApyBps: envNumber(
      "BASE_APY_BPS_GEARBOX_SHMON",
      envNumber("BASE_APY_BPS_GEARBOX", 380)
    ),
    rewardTokenSymbol: envString("GEARBOX_SHMON_REWARD_TOKEN_SYMBOL", "shMON"),
    rewardRatePerSecond: envNumber("GEARBOX_SHMON_REWARD_RATE_PER_SECOND", 0),
    protocolFeeBps: envNumber(
      "GEARBOX_SHMON_PROTOCOL_FEE_BPS",
      envNumber("GEARBOX_PROTOCOL_FEE_BPS", 9)
    ),
    rotationCostBps: envNumber(
      "GEARBOX_SHMON_ROTATION_COST_BPS",
      envNumber("GEARBOX_ROTATION_COST_BPS", 15)
    )
  },
  {
    id: "gearbox-kmon-vault",
    protocol: "Gearbox",
    pair: envPair("GEARBOX_KMON_PAIR", "kMON/MON"),
    tier: "S",
    enabled: envBool("GEARBOX_KMON_ENABLED", false),
    adapterId: "gearbox",
    tokenIn: envAddress("GEARBOX_KMON_TOKEN_IN_ADDRESS", TOKENS.KMON),
    target: envAddress(
      "GEARBOX_KMON_TARGET_ADAPTER_ADDRESS",
      envAddress("GEARBOX_TARGET_ADAPTER_ADDRESS")
    ),
    pool: envAddress("GEARBOX_KMON_POOL_ADDRESS"),
    lpToken: envAddress(
      "GEARBOX_KMON_LP_TOKEN_ADDRESS",
      envAddress("GEARBOX_KMON_POOL_ADDRESS")
    ),
    baseApyBps: envNumber(
      "BASE_APY_BPS_GEARBOX_KMON",
      envNumber("BASE_APY_BPS_GEARBOX", 380)
    ),
    rewardTokenSymbol: envString("GEARBOX_KMON_REWARD_TOKEN_SYMBOL", "kMON"),
    rewardRatePerSecond: envNumber("GEARBOX_KMON_REWARD_RATE_PER_SECOND", 0),
    protocolFeeBps: envNumber(
      "GEARBOX_KMON_PROTOCOL_FEE_BPS",
      envNumber("GEARBOX_PROTOCOL_FEE_BPS", 9)
    ),
    rotationCostBps: envNumber(
      "GEARBOX_KMON_ROTATION_COST_BPS",
      envNumber("GEARBOX_ROTATION_COST_BPS", 15)
    )
  },
  {
    id: "townsquare-usdc-vault",
    protocol: "TownSquare",
    pair: envPair("TOWNSQUARE_PAIR", "USDC/MON"),
    tier: "S",
    enabled: envBool("TOWNSQUARE_ENABLED", false),
    adapterId: "townsquare",
    tokenIn: envAddress("TOWNSQUARE_TOKEN_IN_ADDRESS", TOKENS.USDC),
    target: envAddress("TOWNSQUARE_TARGET_ADAPTER_ADDRESS"),
    pool: envAddress("TOWNSQUARE_POOL_ADDRESS"),
    lpToken: envAddress(
      "TOWNSQUARE_LP_TOKEN_ADDRESS",
      envAddress("TOWNSQUARE_POOL_ADDRESS")
    ),
    baseApyBps: envNumber("BASE_APY_BPS_TOWNSQUARE", 360),
    rewardTokenSymbol: envString("TOWNSQUARE_REWARD_TOKEN_SYMBOL", "USDC"),
    rewardRatePerSecond: envNumber("TOWNSQUARE_REWARD_RATE_PER_SECOND", 0),
    protocolFeeBps: envNumber("TOWNSQUARE_PROTOCOL_FEE_BPS", 9),
    rotationCostBps: envNumber("TOWNSQUARE_ROTATION_COST_BPS", 16)
  },
  {
    id: "neverland-usdc-vault",
    protocol: "Neverland",
    pair: envPair("NEVERLAND_PAIR", "USDC/MON"),
    tier: "S",
    enabled: envBool("NEVERLAND_ENABLED", false),
    adapterId: "neverland",
    tokenIn: envAddress("NEVERLAND_TOKEN_IN_ADDRESS", TOKENS.USDC),
    target: envAddress("NEVERLAND_TARGET_ADAPTER_ADDRESS"),
    pool: envAddress("NEVERLAND_POOL_ADDRESS"),
    lpToken: envAddress(
      "NEVERLAND_LP_TOKEN_ADDRESS",
      envAddress("NEVERLAND_POOL_ADDRESS")
    ),
    baseApyBps: envNumber("BASE_APY_BPS_NEVERLAND", 350),
    rewardTokenSymbol: envString("NEVERLAND_REWARD_TOKEN_SYMBOL", "USDC"),
    rewardRatePerSecond: envNumber("NEVERLAND_REWARD_RATE_PER_SECOND", 0),
    protocolFeeBps: envNumber("NEVERLAND_PROTOCOL_FEE_BPS", 10),
    rotationCostBps: envNumber("NEVERLAND_ROTATION_COST_BPS", 16)
  },
  {
    id: "neverland-ausd-vault",
    protocol: "Neverland",
    pair: envPair("NEVERLAND_AUSD_PAIR", "AUSD/MON"),
    tier: "S",
    enabled: envBool("NEVERLAND_AUSD_ENABLED", false),
    adapterId: "neverland",
    tokenIn: envAddress("NEVERLAND_AUSD_TOKEN_IN_ADDRESS", TOKENS.AUSD),
    target: envAddress(
      "NEVERLAND_AUSD_TARGET_ADAPTER_ADDRESS",
      envAddress("NEVERLAND_TARGET_ADAPTER_ADDRESS")
    ),
    pool: envAddress("NEVERLAND_AUSD_POOL_ADDRESS"),
    lpToken: envAddress(
      "NEVERLAND_AUSD_LP_TOKEN_ADDRESS",
      envAddress("NEVERLAND_AUSD_POOL_ADDRESS")
    ),
    baseApyBps: envNumber(
      "BASE_APY_BPS_NEVERLAND_AUSD",
      envNumber("BASE_APY_BPS_NEVERLAND", 350)
    ),
    rewardTokenSymbol: envString("NEVERLAND_AUSD_REWARD_TOKEN_SYMBOL", "AUSD"),
    rewardRatePerSecond: envNumber("NEVERLAND_AUSD_REWARD_RATE_PER_SECOND", 0),
    protocolFeeBps: envNumber(
      "NEVERLAND_AUSD_PROTOCOL_FEE_BPS",
      envNumber("NEVERLAND_PROTOCOL_FEE_BPS", 10)
    ),
    rotationCostBps: envNumber(
      "NEVERLAND_AUSD_ROTATION_COST_BPS",
      envNumber("NEVERLAND_ROTATION_COST_BPS", 16)
    )
  },
  {
    id: "neverland-shmon-vault",
    protocol: "Neverland",
    pair: envPair("NEVERLAND_SHMON_PAIR", "shMON/MON"),
    tier: "S",
    enabled: envBool("NEVERLAND_SHMON_ENABLED", false),
    adapterId: "neverland",
    tokenIn: envAddress("NEVERLAND_SHMON_TOKEN_IN_ADDRESS", TOKENS.SHMON),
    target: envAddress(
      "NEVERLAND_SHMON_TARGET_ADAPTER_ADDRESS",
      envAddress("NEVERLAND_TARGET_ADAPTER_ADDRESS")
    ),
    pool: envAddress("NEVERLAND_SHMON_POOL_ADDRESS"),
    lpToken: envAddress(
      "NEVERLAND_SHMON_LP_TOKEN_ADDRESS",
      envAddress("NEVERLAND_SHMON_POOL_ADDRESS")
    ),
    baseApyBps: envNumber(
      "BASE_APY_BPS_NEVERLAND_SHMON",
      envNumber("BASE_APY_BPS_NEVERLAND", 350)
    ),
    rewardTokenSymbol: envString("NEVERLAND_SHMON_REWARD_TOKEN_SYMBOL", "shMON"),
    rewardRatePerSecond: envNumber("NEVERLAND_SHMON_REWARD_RATE_PER_SECOND", 0),
    protocolFeeBps: envNumber(
      "NEVERLAND_SHMON_PROTOCOL_FEE_BPS",
      envNumber("NEVERLAND_PROTOCOL_FEE_BPS", 10)
    ),
    rotationCostBps: envNumber(
      "NEVERLAND_SHMON_ROTATION_COST_BPS",
      envNumber("NEVERLAND_ROTATION_COST_BPS", 16)
    )
  },
  {
    id: "neverland-kmon-vault",
    protocol: "Neverland",
    pair: envPair("NEVERLAND_KMON_PAIR", "kMON/MON"),
    tier: "S",
    enabled: envBool("NEVERLAND_KMON_ENABLED", false),
    adapterId: "neverland",
    tokenIn: envAddress("NEVERLAND_KMON_TOKEN_IN_ADDRESS", TOKENS.KMON),
    target: envAddress(
      "NEVERLAND_KMON_TARGET_ADAPTER_ADDRESS",
      envAddress("NEVERLAND_TARGET_ADAPTER_ADDRESS")
    ),
    pool: envAddress("NEVERLAND_KMON_POOL_ADDRESS"),
    lpToken: envAddress(
      "NEVERLAND_KMON_LP_TOKEN_ADDRESS",
      envAddress("NEVERLAND_KMON_POOL_ADDRESS")
    ),
    baseApyBps: envNumber(
      "BASE_APY_BPS_NEVERLAND_KMON",
      envNumber("BASE_APY_BPS_NEVERLAND", 350)
    ),
    rewardTokenSymbol: envString("NEVERLAND_KMON_REWARD_TOKEN_SYMBOL", "kMON"),
    rewardRatePerSecond: envNumber("NEVERLAND_KMON_REWARD_RATE_PER_SECOND", 0),
    protocolFeeBps: envNumber(
      "NEVERLAND_KMON_PROTOCOL_FEE_BPS",
      envNumber("NEVERLAND_PROTOCOL_FEE_BPS", 10)
    ),
    rotationCostBps: envNumber(
      "NEVERLAND_KMON_ROTATION_COST_BPS",
      envNumber("NEVERLAND_ROTATION_COST_BPS", 16)
    )
  }
];

export const RUNTIME: RuntimeConfig = {
  rpcUrl: process.env.MONAD_RPC_URL ?? CHAIN_CONFIG.rpcUrl,
  chainId: envNumber("MONAD_CHAIN_ID", CHAIN_CONFIG.chainId),
  vaultAddress: (process.env.VAULT_ADDRESS ?? ZERO_ADDRESS) as Address,
  vaultDepositToken: envAddress("VAULT_DEPOSIT_TOKEN_ADDRESS", TOKENS.USDC),
  executorPrivateKey: process.env.BOT_EXECUTOR_PRIVATE_KEY as RuntimeConfig["executorPrivateKey"],
  explorerTxBaseUrl: process.env.EXPLORER_TX_BASE_URL ?? CHAIN_CONFIG.explorerTxBaseUrl,
  dryRun: envBool("DRY_RUN", true),
  liveModeArmed: envBool("LIVE_MODE_ARMED", false),
  scanIntervalSeconds: envNumber("SCAN_INTERVAL_SECONDS", 300),
  defaultTradeAmountRaw: envBigInt("DEFAULT_TRADE_AMOUNT_RAW", 1_000_000n),
  enterOnlyMode: envBool("ENTER_ONLY", false),
  maxRotationsPerDay: envNumber("MAX_ROTATIONS_PER_DAY", 1),
  cooldownSeconds: envNumber("COOLDOWN_SECONDS", 21_600)
};

if (!RUNTIME.dryRun && !RUNTIME.executorPrivateKey) {
  throw new Error("BOT_EXECUTOR_PRIVATE_KEY is required when DRY_RUN=false");
}
if (!RUNTIME.dryRun && RUNTIME.vaultAddress === ZERO_ADDRESS) {
  throw new Error("VAULT_ADDRESS is required when DRY_RUN=false");
}
if (
  !RUNTIME.dryRun &&
  POOLS.some(
    (pool) =>
      pool.enabled &&
      (pool.target === ZERO_ADDRESS ||
        pool.pool === ZERO_ADDRESS ||
        pool.lpToken === ZERO_ADDRESS ||
        pool.tokenIn === ZERO_ADDRESS)
  )
) {
  throw new Error(
    "Enabled pools require non-zero target/pool/lpToken/tokenIn addresses when DRY_RUN=false."
  );
}
if (!RUNTIME.dryRun && !RUNTIME.liveModeArmed) {
  console.warn(
    "LIVE_MODE_ARMED=false. Bot is in guarded live mode: simulations run, but broadcasts are blocked."
  );
}

export const STABLE_PRICE_SYMBOLS = envCsvUpper("STABLE_PRICE_SYMBOLS", ["USDC"]);
export const COINGECKO_API_BASE_URL = envString(
  "COINGECKO_API_BASE_URL",
  "https://api.coingecko.com/api/v3"
);
export const COINGECKO_API_KEY = envString("COINGECKO_API_KEY", "");
export const PRICE_ORACLE_TIMEOUT_MS = envNumber("PRICE_ORACLE_TIMEOUT_MS", 8_000);
export const PRICE_ORACLE_CACHE_TTL_MS = envNumber("PRICE_ORACLE_CACHE_TTL_MS", 30_000);
export const USE_STATIC_STABLE_PRICES = envBool("USE_STATIC_STABLE_PRICES", false);
export const STATIC_STABLE_PRICE_USD = envNumber("STATIC_STABLE_PRICE_USD", 1);
export const PRICE_ORACLE_RATE_LIMIT_COOLDOWN_MS = envNumber(
  "PRICE_ORACLE_RATE_LIMIT_COOLDOWN_MS",
  300_000
);
export const PRICE_ORACLE_STALE_FALLBACK_TTL_MS = envNumber(
  "PRICE_ORACLE_STALE_FALLBACK_TTL_MS",
  300_000
);
export const PRICE_ORACLE_WARN_COOLDOWN_MS = envNumber(
  "PRICE_ORACLE_WARN_COOLDOWN_MS",
  300_000
);
export const BASE_APY_AUTO_UPDATE = envBool("BASE_APY_AUTO_UPDATE", false);
export const BASE_APY_ORACLE_TIMEOUT_MS = envNumber("BASE_APY_ORACLE_TIMEOUT_MS", 8_000);
export const BASE_APY_WARN_COOLDOWN_MS = envNumber("BASE_APY_WARN_COOLDOWN_MS", 300_000);
export const BASE_APY_ERC4626_LOOKBACK_SECONDS = envNumber(
  "BASE_APY_ERC4626_LOOKBACK_SECONDS",
  3600
);
export const CURVANCE_PROTOCOL_READER_ADDRESS = envAddress(
  "CURVANCE_PROTOCOL_READER_ADDRESS",
  DEFAULT_CURVANCE_PROTOCOL_READER as Address
);
export const MORPHO_GRAPHQL_ENDPOINT = envString(
  "MORPHO_GRAPHQL_ENDPOINT",
  DEFAULT_MORPHO_GRAPHQL_ENDPOINT
);
export const COINGECKO_ID_BY_SYMBOL: Record<string, string> = {
  USDC: envString("COINGECKO_ID_USDC", "usd-coin"),
  MON: envString("COINGECKO_ID_MON", "monad"),
  WMON: envString("COINGECKO_ID_WMON", envString("COINGECKO_ID_MON", "monad")),
  AUSD: envString("COINGECKO_ID_AUSD", ""),
  SHMON: envString("COINGECKO_ID_SHMON", envString("COINGECKO_ID_MON", "monad")),
  KMON: envString("COINGECKO_ID_KMON", "")
};

if (!RUNTIME.dryRun) {
  for (const symbol of STABLE_PRICE_SYMBOLS) {
    const id = COINGECKO_ID_BY_SYMBOL[symbol];
    if (!id) {
      throw new Error(
        `Missing COINGECKO_ID_${symbol} while STABLE_PRICE_SYMBOLS includes ${symbol}.`
      );
    }
  }
}

export const POOL_BY_ID = new Map(POOLS.map((pool) => [pool.id, pool]));
export const CURVANCE_MAINNET = CHAIN_CONFIG;
