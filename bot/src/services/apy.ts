const SECONDS_PER_YEAR = 365 * 24 * 60 * 60;

export interface PriceOracle {
  getPriceUsd(symbol: string): Promise<number>;
  getStablePricesUsd(): Promise<Record<string, number>>;
}

interface LivePriceOracleConfig {
  baseUrl: string;
  stableSymbols: string[];
  coingeckoIdBySymbol: Record<string, string>;
  timeoutMs: number;
  cacheTtlMs: number;
}

interface CacheEntry {
  value: number;
  expiresAt: number;
}

export interface PriceOracleTelemetry {
  cacheFreshHits: number;
  staleFallbackHits: number;
  stableFallbackHits: number;
  networkFetchSuccesses: number;
  fetchFailures: number;
}

export class LivePriceOracle implements PriceOracle {
  private readonly cache = new Map<string, CacheEntry>();
  private telemetry: PriceOracleTelemetry = {
    cacheFreshHits: 0,
    staleFallbackHits: 0,
    stableFallbackHits: 0,
    networkFetchSuccesses: 0,
    fetchFailures: 0
  };

  constructor(private readonly config: LivePriceOracleConfig) {}

  async getPriceUsd(symbol: string): Promise<number> {
    const normalized = symbol.trim().toUpperCase();
    const freshCached = this.readCachedValue(normalized, false);
    if (freshCached !== null) {
      this.telemetry.cacheFreshHits += 1;
      return freshCached;
    }

    try {
      const values = await this.fetchPrices([normalized]);
      const value = values[normalized];
      if (value === undefined) {
        throw new Error(`Live price unavailable for ${normalized}.`);
      }
      this.writeCache(normalized, value);
      this.telemetry.networkFetchSuccesses += 1;
      return value;
    } catch (error) {
      this.telemetry.fetchFailures += 1;
      const staleCached = this.readCachedValue(normalized, true);
      if (staleCached !== null) {
        this.telemetry.staleFallbackHits += 1;
        console.warn(
          `[price-oracle] Using stale cached price for ${normalized}: ${toErrorMessage(error)}`
        );
        return staleCached;
      }
      throw error;
    }
  }

  async getStablePricesUsd(): Promise<Record<string, number>> {
    const stableSymbols = this.normalizeSymbols(this.config.stableSymbols);
    try {
      const values = await this.fetchPrices(stableSymbols);
      for (const [symbol, value] of Object.entries(values)) {
        this.writeCache(symbol, value);
      }
      this.telemetry.networkFetchSuccesses += 1;
      return values;
    } catch (error) {
      this.telemetry.fetchFailures += 1;
      const fallback = this.readCachedSnapshot(stableSymbols);
      if (fallback) {
        this.telemetry.stableFallbackHits += 1;
        console.warn(
          `[price-oracle] Using stale cached stable prices: ${toErrorMessage(error)}`
        );
        return fallback;
      }
      throw new Error(
        `Stable price fetch failed and no cached fallback is available: ${toErrorMessage(error)}`
      );
    }
  }

  getTelemetrySnapshot(): PriceOracleTelemetry {
    return {
      ...this.telemetry
    };
  }

  private async fetchPrices(symbols: string[]): Promise<Record<string, number>> {
    const uniqueSymbols = [...new Set(symbols.map((value) => value.trim().toUpperCase()))];
    if (!uniqueSymbols.length) {
      throw new Error("Price fetch requested with empty symbol set.");
    }

    const ids = uniqueSymbols.map((symbol) => {
      const id = this.config.coingeckoIdBySymbol[symbol];
      if (!id) {
        throw new Error(`Missing CoinGecko id mapping for symbol: ${symbol}`);
      }
      return id;
    });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      const endpoint = `${this.config.baseUrl.replace(/\/$/, "")}/simple/price?ids=${encodeURIComponent(
        ids.join(",")
      )}&vs_currencies=usd`;
      const response = await fetch(endpoint, {
        method: "GET",
        headers: {
          Accept: "application/json"
        },
        signal: controller.signal,
        cache: "no-store"
      });
      if (!response.ok) {
        throw new Error(`CoinGecko returned ${response.status}`);
      }

      const payload = (await response.json()) as Record<
        string,
        {
          usd?: number;
        }
      >;
      const result: Record<string, number> = {};
      for (let index = 0; index < uniqueSymbols.length; index += 1) {
        const symbol = uniqueSymbols[index];
        const id = ids[index];
        const value = payload[id]?.usd;
        if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
          throw new Error(`Invalid CoinGecko USD price for ${symbol} (${id}).`);
        }
        result[symbol] = value;
      }
      return result;
    } finally {
      clearTimeout(timeout);
    }
  }

  private normalizeSymbols(symbols: string[]): string[] {
    return [...new Set(symbols.map((value) => value.trim().toUpperCase()))];
  }

  private writeCache(symbol: string, value: number): void {
    const normalized = symbol.trim().toUpperCase();
    const now = Date.now();
    this.cache.set(normalized, {
      value,
      expiresAt: now + this.config.cacheTtlMs
    });
  }

  private readCachedValue(symbol: string, allowStale: boolean): number | null {
    const normalized = symbol.trim().toUpperCase();
    const cached = this.cache.get(normalized);
    if (!cached) return null;
    if (!allowStale && cached.expiresAt <= Date.now()) return null;
    return cached.value;
  }

  private readCachedSnapshot(symbols: string[]): Record<string, number> | null {
    const result: Record<string, number> = {};
    for (const symbol of symbols) {
      const value = this.readCachedValue(symbol, true);
      if (value === null) return null;
      result[symbol] = value;
    }
    return result;
  }
}

export function computeIncentiveAprBps(
  rewardRatePerSecond: number,
  rewardTokenPriceUsd: number,
  tvlUsd: number
): number {
  if (tvlUsd <= 0) return 0;
  const annualRewardsUsd = rewardRatePerSecond * SECONDS_PER_YEAR * rewardTokenPriceUsd;
  return Math.max(0, Math.round((annualRewardsUsd / tvlUsd) * 10_000));
}

export function computeNetApyBps(
  baseApyBps: number,
  incentiveAprBps: number,
  protocolFeeBps: number
): number {
  return Math.max(0, baseApyBps + incentiveAprBps - protocolFeeBps);
}

export function estimatePaybackHours(costBps: number, deltaApyBps: number): number {
  if (deltaApyBps <= 0) return Number.POSITIVE_INFINITY;
  return (costBps / deltaApyBps) * 365 * 24;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "unknown_error";
}
