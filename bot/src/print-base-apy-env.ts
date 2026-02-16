import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { createPublicClient, getAddress, http, parseAbi, type Address } from "viem";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_ENV_PATH = join(__dirname, "..", "..", ".env");
const CWD_ENV_PATH = join(process.cwd(), ".env");
const CHAIN_CONFIG_PATH = join(__dirname, "..", "config", "curvance.monad.mainnet.json");

const DEFAULT_RPC_URL = "https://rpc.monad.xyz";
const DEFAULT_CHAIN_ID = 143;
const DEFAULT_PROTOCOL_READER = "0x878cDfc2F3D96a49A5CbD805FAF4F3080768a6d2";
const DEFAULT_MORPHO_USDC_VAULT = "0xbeEFf443C3CbA3E369DA795002243BeaC311aB83";
const DEFAULT_MORPHO_AUSD_VAULT = "0xBC03E505EE65f9fAa68a2D7e5A74452858C16D29";
const MORPHO_GRAPHQL_ENDPOINT = "https://api.morpho.org/graphql";
const RATE_SCALE = 1e18;
const SECONDS_PER_YEAR = 365 * 24 * 60 * 60;

const PROTOCOL_READER_ABI = parseAbi([
  "function getDynamicMarketData() view returns ((address _address,(address _address,uint256 totalSupply,uint256 collateral,uint256 debt,uint256 sharePrice,uint256 assetPrice,uint256 sharePriceLower,uint256 assetPriceLower,uint256 borrowRate,uint256 predictedBorrowRate,uint256 utilizationRate,uint256 supplyRate,uint256 liquidity)[] tokens)[] data)"
]);

interface CurvanceMainnetConfig {
  curvance: {
    usdcMarket: Address;
    ausdMarket: Address;
  };
}

interface DynamicMarketDataToken {
  _address: Address;
  supplyRate: bigint;
}

interface DynamicMarketDataRow {
  _address: Address;
  tokens: DynamicMarketDataToken[];
}

interface MorphoV2Response {
  vaultV2ByAddress: {
    address: string;
    name: string;
    symbol: string;
    apy: number;
  } | null;
}

interface MorphoLegacyResponse {
  vaultByAddress: {
    address: string;
    name: string;
    symbol: string;
    state: {
      apy: number;
    } | null;
  } | null;
}

interface MorphoGraphQlError {
  message: string;
  status?: string;
  extensions?: {
    description?: string;
  };
}

class MorphoQueryError extends Error {
  constructor(
    message: string,
    readonly status?: string
  ) {
    super(message);
  }
}

function loadEnv(): void {
  dotenv.config({ path: ROOT_ENV_PATH });
  dotenv.config({ path: CWD_ENV_PATH });
  dotenv.config();
}

function normalizeAddress(raw: string): Address {
  return getAddress(raw.trim());
}

function readChainId(): number {
  const raw = (process.env.MONAD_CHAIN_ID ?? String(DEFAULT_CHAIN_ID)).trim();
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid MONAD_CHAIN_ID: ${raw}`);
  }
  return Math.trunc(parsed);
}

function readChainConfig(): CurvanceMainnetConfig {
  return JSON.parse(readFileSync(CHAIN_CONFIG_PATH, "utf8")) as CurvanceMainnetConfig;
}

function ratioToBps(apyRatio: number): number {
  return Math.max(0, Math.round(apyRatio * 10_000));
}

function supplyRateToApyRatio(supplyRate: bigint): number {
  const perSecondRate = Number(supplyRate) / RATE_SCALE;
  if (!Number.isFinite(perSecondRate) || perSecondRate < 0) {
    throw new Error(`Invalid Curvance supplyRate value: ${supplyRate.toString()}`);
  }
  return Math.pow(1 + perSecondRate, SECONDS_PER_YEAR) - 1;
}

async function fetchCurvanceSupplyRateByToken(
  rpcUrl: string,
  protocolReader: Address
): Promise<Map<string, bigint>> {
  const client = createPublicClient({
    transport: http(rpcUrl)
  });

  const dynamicMarkets = (await client.readContract({
    address: protocolReader,
    abi: PROTOCOL_READER_ABI,
    functionName: "getDynamicMarketData"
  })) as DynamicMarketDataRow[];

  const result = new Map<string, bigint>();
  for (const market of dynamicMarkets) {
    for (const token of market.tokens) {
      result.set(token._address.toLowerCase(), token.supplyRate);
    }
  }
  return result;
}

async function morphoQuery<T>(
  query: string,
  variables: Record<string, unknown>
): Promise<T> {
  const response = await fetch(MORPHO_GRAPHQL_ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({ query, variables })
  });

  if (!response.ok) {
    throw new Error(`Morpho API HTTP ${response.status}`);
  }

  const payload = (await response.json()) as {
    data?: T;
    errors?: MorphoGraphQlError[];
  };

  if (payload.errors?.length) {
    const first = payload.errors[0];
    const detail = first.extensions?.description ? ` (${first.extensions.description})` : "";
    throw new MorphoQueryError(`${first.message}${detail}`, first.status);
  }
  if (!payload.data) {
    throw new Error("Morpho API returned an empty payload.");
  }

  return payload.data;
}

async function fetchMorphoApyRatio(
  address: Address,
  chainId: number
): Promise<{ apyRatio: number; source: string; label: string }> {
  const v2Query = `
    query($address:String!, $chainId:Int!) {
      vaultV2ByAddress(address:$address, chainId:$chainId) {
        name
        symbol
        apy
      }
    }
  `;

  try {
    const v2Data = await morphoQuery<MorphoV2Response>(v2Query, { address, chainId });
    const vault = v2Data.vaultV2ByAddress;
    if (vault && Number.isFinite(vault.apy)) {
      return {
        apyRatio: vault.apy,
        source: "vaultV2ByAddress",
        label: `${vault.name} (${vault.symbol})`
      };
    }
  } catch (error) {
    if (!(error instanceof MorphoQueryError) || error.status !== "NOT_FOUND") {
      throw error;
    }
  }

  const legacyQuery = `
    query($address:String!, $chainId:Int) {
      vaultByAddress(address:$address, chainId:$chainId) {
        name
        symbol
        state {
          apy
        }
      }
    }
  `;

  const legacyData = await morphoQuery<MorphoLegacyResponse>(legacyQuery, {
    address,
    chainId
  });
  const vault = legacyData.vaultByAddress;
  const apyRatio = vault?.state?.apy;

  if (!vault || !Number.isFinite(apyRatio)) {
    throw new Error(`Morpho APY not found for ${address}.`);
  }

  return {
    apyRatio,
    source: "vaultByAddress.state.apy",
    label: `${vault.name} (${vault.symbol})`
  };
}

function formatPercent(apyRatio: number): string {
  return `${(apyRatio * 100).toFixed(6)}%`;
}

async function main(): Promise<void> {
  loadEnv();

  const chainConfig = readChainConfig();
  const rpcUrl = (process.env.MONAD_RPC_URL ?? DEFAULT_RPC_URL).trim();
  const chainId = readChainId();
  const protocolReader = normalizeAddress(
    process.env.CURVANCE_PROTOCOL_READER_ADDRESS ?? DEFAULT_PROTOCOL_READER
  );

  const curvanceUsdcCtoken = normalizeAddress(
    process.env.CURVANCE_USDC_POOL_ADDRESS ?? chainConfig.curvance.usdcMarket
  );
  const curvanceAusdCtoken = normalizeAddress(
    process.env.CURVANCE_AUSD_POOL_ADDRESS ?? chainConfig.curvance.ausdMarket
  );
  const morphoUsdcVault = normalizeAddress(process.env.MORPHO_POOL_ADDRESS ?? DEFAULT_MORPHO_USDC_VAULT);
  const morphoAusdVault = normalizeAddress(
    process.env.MORPHO_AUSD_POOL_ADDRESS ?? DEFAULT_MORPHO_AUSD_VAULT
  );

  const curvanceSupplyRates = await fetchCurvanceSupplyRateByToken(rpcUrl, protocolReader);
  const curvanceUsdcRate = curvanceSupplyRates.get(curvanceUsdcCtoken.toLowerCase());
  const curvanceAusdRate = curvanceSupplyRates.get(curvanceAusdCtoken.toLowerCase());

  if (curvanceUsdcRate === undefined) {
    throw new Error(`Curvance USDC cToken not found in ProtocolReader output: ${curvanceUsdcCtoken}`);
  }
  if (curvanceAusdRate === undefined) {
    throw new Error(`Curvance AUSD cToken not found in ProtocolReader output: ${curvanceAusdCtoken}`);
  }

  const curvanceUsdcApyRatio = supplyRateToApyRatio(curvanceUsdcRate);
  const curvanceAusdApyRatio = supplyRateToApyRatio(curvanceAusdRate);

  const morphoUsdc = await fetchMorphoApyRatio(morphoUsdcVault, chainId);
  const morphoAusd = await fetchMorphoApyRatio(morphoAusdVault, chainId);

  const curvanceUsdcBps = ratioToBps(curvanceUsdcApyRatio);
  const curvanceAusdBps = ratioToBps(curvanceAusdApyRatio);
  const morphoUsdcBps = ratioToBps(morphoUsdc.apyRatio);
  const morphoAusdBps = ratioToBps(morphoAusd.apyRatio);

  console.log(`# Generated at ${new Date().toISOString()}`);
  console.log(`# chainId=${chainId}`);
  console.log(`# Curvance USDC ${curvanceUsdcCtoken} APY=${formatPercent(curvanceUsdcApyRatio)}`);
  console.log(`# Curvance AUSD ${curvanceAusdCtoken} APY=${formatPercent(curvanceAusdApyRatio)}`);
  console.log(
    `# Morpho USDC ${morphoUsdcVault} APY=${formatPercent(morphoUsdc.apyRatio)} source=${morphoUsdc.source} ${morphoUsdc.label}`
  );
  console.log(
    `# Morpho AUSD ${morphoAusdVault} APY=${formatPercent(morphoAusd.apyRatio)} source=${morphoAusd.source} ${morphoAusd.label}`
  );
  console.log("BASE_APY_BPS_CURVANCE_USDC=" + curvanceUsdcBps);
  console.log("BASE_APY_BPS_CURVANCE_AUSD=" + curvanceAusdBps);
  console.log("BASE_APY_BPS_MORPHO=" + morphoUsdcBps);
  console.log("BASE_APY_BPS_MORPHO_AUSD=" + morphoAusdBps);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[print-base-apy-env] ${message}`);
  process.exitCode = 1;
});
