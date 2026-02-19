import { createPublicClient, http, parseAbi, type Address } from "viem";
import type { PoolConfig } from "../types.js";

const RATE_SCALE = 1e18;
const SECONDS_PER_YEAR = 365 * 24 * 60 * 60;
const DEFAULT_ERC4626_LOOKBACK_SECONDS = 3600;
const MIN_ERC4626_LOOKBACK_SECONDS = 300;
const ERC4626_DYNAMIC_PROTOCOLS = new Set(["gearbox", "townsquare"]);

const PROTOCOL_READER_ABI = parseAbi([
  "function getDynamicMarketData() view returns ((address _address,(address _address,uint256 totalSupply,uint256 collateral,uint256 debt,uint256 sharePrice,uint256 assetPrice,uint256 sharePriceLower,uint256 assetPriceLower,uint256 borrowRate,uint256 predictedBorrowRate,uint256 utilizationRate,uint256 supplyRate,uint256 liquidity)[] tokens)[] data)"
]);
const ERC4626_PREVIEW_ABI = parseAbi([
  "function decimals() view returns (uint8)",
  "function previewRedeem(uint256 shares) view returns (uint256 assets)"
]);

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
    apy: number;
  } | null;
}

interface MorphoLegacyResponse {
  vaultByAddress: {
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

interface BaseApyOracleConfig {
  rpcUrl: string;
  chainId: number;
  curvanceProtocolReader: Address;
  morphoGraphqlEndpoint: string;
  timeoutMs: number;
  warnCooldownMs?: number;
  erc4626LookbackSeconds?: number;
}

export interface BaseApyOracle {
  resolveBaseApyBpsByPool(pools: PoolConfig[]): Promise<Map<string, number>>;
}

export class LiveBaseApyOracle implements BaseApyOracle {
  private readonly publicClient;
  private readonly warnCooldownMs: number;
  private readonly erc4626LookbackSeconds: number;
  private readonly lastWarningByKey = new Map<string, number>();

  constructor(private readonly config: BaseApyOracleConfig) {
    this.publicClient = createPublicClient({
      transport: http(config.rpcUrl)
    });
    this.warnCooldownMs = Math.max(0, config.warnCooldownMs ?? 300_000);
    this.erc4626LookbackSeconds = Math.max(
      MIN_ERC4626_LOOKBACK_SECONDS,
      Math.floor(config.erc4626LookbackSeconds ?? DEFAULT_ERC4626_LOOKBACK_SECONDS)
    );
  }

  async resolveBaseApyBpsByPool(pools: PoolConfig[]): Promise<Map<string, number>> {
    const overrides = new Map<string, number>();
    await Promise.all([
      this.resolveCurvanceOverrides(pools, overrides),
      this.resolveMorphoOverrides(pools, overrides),
      this.resolveErc4626SharePriceOverrides(pools, overrides)
    ]);
    return overrides;
  }

  private async resolveCurvanceOverrides(
    pools: PoolConfig[],
    overrides: Map<string, number>
  ): Promise<void> {
    const curvancePools = pools.filter((pool) => pool.protocol.toLowerCase() === "curvance");
    if (!curvancePools.length) return;

    try {
      const supplyRates = await this.fetchCurvanceSupplyRateByToken();
      for (const pool of curvancePools) {
        const supplyRate = supplyRates.get(pool.pool.toLowerCase());
        if (supplyRate === undefined) continue;
        overrides.set(pool.id, ratioToBps(supplyRateToApyRatio(supplyRate)));
      }
    } catch (error) {
      this.warnWithCooldown(
        "curvance",
        `[base-apy] Curvance APY refresh failed, using static BASE_APY_BPS_* values: ${toErrorMessage(error)}`
      );
    }
  }

  private async resolveMorphoOverrides(
    pools: PoolConfig[],
    overrides: Map<string, number>
  ): Promise<void> {
    const morphoPools = pools.filter((pool) => pool.protocol.toLowerCase() === "morpho");
    if (!morphoPools.length) return;

    for (const pool of morphoPools) {
      try {
        const apyRatio = await this.fetchMorphoApyRatio(pool.pool);
        if (apyRatio === null) continue;
        overrides.set(pool.id, ratioToBps(apyRatio));
      } catch (error) {
        this.warnWithCooldown(
          `morpho:${pool.id}`,
          `[base-apy] Morpho APY refresh failed for ${pool.id}, using static BASE_APY_BPS_* value: ${toErrorMessage(error)}`
        );
      }
    }
  }

  private async resolveErc4626SharePriceOverrides(
    pools: PoolConfig[],
    overrides: Map<string, number>
  ): Promise<void> {
    const candidatePools = pools.filter((pool) => {
      if (overrides.has(pool.id)) return false;
      return ERC4626_DYNAMIC_PROTOCOLS.has(pool.protocol.toLowerCase());
    });
    if (!candidatePools.length) return;

    try {
      const latestBlock = await this.publicClient.getBlock();
      const targetTimestamp =
        latestBlock.timestamp > BigInt(this.erc4626LookbackSeconds)
          ? latestBlock.timestamp - BigInt(this.erc4626LookbackSeconds)
          : 0n;
      const lookbackBlock = await this.findBlockAtOrBeforeTimestamp(
        targetTimestamp,
        latestBlock.number
      );
      if (!lookbackBlock || lookbackBlock.number >= latestBlock.number) return;

      const elapsedSeconds = Number(latestBlock.timestamp - lookbackBlock.timestamp);
      if (!Number.isFinite(elapsedSeconds) || elapsedSeconds <= 0) return;

      for (const pool of candidatePools) {
        try {
          const apyRatio = await this.estimateErc4626ApyRatio({
            poolAddress: pool.pool,
            latestBlockNumber: latestBlock.number,
            previousBlockNumber: lookbackBlock.number,
            elapsedSeconds
          });
          if (apyRatio === null) continue;
          overrides.set(pool.id, ratioToBps(apyRatio));
        } catch (error) {
          this.warnWithCooldown(
            `erc4626:${pool.id}`,
            `[base-apy] ${pool.protocol} APY refresh failed for ${pool.id}, using static BASE_APY_BPS_* value: ${toErrorMessage(error)}`
          );
        }
      }
    } catch (error) {
      this.warnWithCooldown(
        "erc4626",
        `[base-apy] ERC4626 APY refresh failed, using static BASE_APY_BPS_* values: ${toErrorMessage(error)}`
      );
    }
  }

  private async fetchCurvanceSupplyRateByToken(): Promise<Map<string, bigint>> {
    const dynamicMarkets = (await this.publicClient.readContract({
      address: this.config.curvanceProtocolReader,
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

  private async fetchMorphoApyRatio(address: Address): Promise<number | null> {
    const v2Query = `
      query($address:String!, $chainId:Int!) {
        vaultV2ByAddress(address:$address, chainId:$chainId) {
          apy
        }
      }
    `;
    try {
      const v2Data = await this.morphoQuery<MorphoV2Response>(v2Query, {
        address,
        chainId: this.config.chainId
      });
      const apyRatio = v2Data.vaultV2ByAddress?.apy;
      if (typeof apyRatio === "number" && Number.isFinite(apyRatio) && apyRatio >= 0) {
        return apyRatio;
      }
    } catch (error) {
      if (!(error instanceof MorphoQueryError) || error.status !== "NOT_FOUND") {
        throw error;
      }
    }

    const legacyQuery = `
      query($address:String!, $chainId:Int) {
        vaultByAddress(address:$address, chainId:$chainId) {
          state {
            apy
          }
        }
      }
    `;
    const legacyData = await this.morphoQuery<MorphoLegacyResponse>(legacyQuery, {
      address,
      chainId: this.config.chainId
    });
    const apyRatioRaw = legacyData.vaultByAddress?.state?.apy;
    if (typeof apyRatioRaw !== "number" || !Number.isFinite(apyRatioRaw) || apyRatioRaw < 0) {
      return null;
    }
    return apyRatioRaw;
  }

  private async estimateErc4626ApyRatio(input: {
    poolAddress: Address;
    latestBlockNumber: bigint;
    previousBlockNumber: bigint;
    elapsedSeconds: number;
  }): Promise<number | null> {
    const decimalsRaw = await this.publicClient.readContract({
      address: input.poolAddress,
      abi: ERC4626_PREVIEW_ABI,
      functionName: "decimals"
    });
    const decimals = Number(decimalsRaw);
    if (!Number.isFinite(decimals) || decimals < 0 || decimals > 30) {
      return null;
    }

    const shareAmount = 10n ** BigInt(Math.floor(decimals));
    const [latestAssetsOut, previousAssetsOut] = await Promise.all([
      this.publicClient.readContract({
        address: input.poolAddress,
        abi: ERC4626_PREVIEW_ABI,
        functionName: "previewRedeem",
        args: [shareAmount],
        blockNumber: input.latestBlockNumber
      }),
      this.publicClient.readContract({
        address: input.poolAddress,
        abi: ERC4626_PREVIEW_ABI,
        functionName: "previewRedeem",
        args: [shareAmount],
        blockNumber: input.previousBlockNumber
      })
    ]);
    if (previousAssetsOut <= 0n || latestAssetsOut <= 0n) return null;

    const scaledRatio = Number((latestAssetsOut * 1_000_000_000n) / previousAssetsOut) / 1_000_000_000;
    if (!Number.isFinite(scaledRatio) || scaledRatio <= 0) return null;

    const annualized = Math.pow(scaledRatio, SECONDS_PER_YEAR / input.elapsedSeconds) - 1;
    if (!Number.isFinite(annualized)) return null;
    return Math.max(0, annualized);
  }

  private async findBlockAtOrBeforeTimestamp(
    targetTimestamp: bigint,
    highBlockNumber: bigint
  ): Promise<{ number: bigint; timestamp: bigint } | null> {
    let low = 0n;
    let high = highBlockNumber;
    let best: { number: bigint; timestamp: bigint } | null = null;

    while (low <= high) {
      const mid = (low + high) / 2n;
      const block = await this.publicClient.getBlock({ blockNumber: mid });
      if (block.timestamp <= targetTimestamp) {
        best = {
          number: block.number,
          timestamp: block.timestamp
        };
        low = mid + 1n;
      } else {
        if (mid === 0n) break;
        high = mid - 1n;
      }
    }

    return best;
  }

  private async morphoQuery<T>(
    query: string,
    variables: Record<string, unknown>
  ): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      const response = await fetch(this.config.morphoGraphqlEndpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({ query, variables }),
        signal: controller.signal
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
    } finally {
      clearTimeout(timeout);
    }
  }

  private warnWithCooldown(key: string, message: string): void {
    if (this.warnCooldownMs <= 0) {
      console.warn(message);
      return;
    }
    const now = Date.now();
    const lastLoggedAt = this.lastWarningByKey.get(key) ?? 0;
    if (now - lastLoggedAt < this.warnCooldownMs) {
      return;
    }
    this.lastWarningByKey.set(key, now);
    console.warn(message);
  }
}

function ratioToBps(apyRatio: number): number {
  return Math.max(0, Math.round(apyRatio * 10_000));
}

function supplyRateToApyRatio(supplyRate: bigint): number {
  const perSecondRate = Number(supplyRate) / RATE_SCALE;
  if (!Number.isFinite(perSecondRate) || perSecondRate < 0) {
    throw new Error(`Invalid Curvance supplyRate: ${supplyRate.toString()}`);
  }
  return Math.pow(1 + perSecondRate, SECONDS_PER_YEAR) - 1;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "unknown_error";
}
