import type { StrategyAdapter } from "../adapters/adapter.interface.js";
import type { PoolConfig, PoolSnapshot } from "../types.js";
import type { BaseApyOracle } from "./base-apy-oracle.js";
import {
  computeIncentiveAprBps,
  computeNetApyBps,
  type PriceOracle
} from "./apy.js";

const DEFAULT_POOL_TIMEOUT_MS = 12_000;

export class ScannerService {
  constructor(
    private readonly pools: PoolConfig[],
    private readonly adapters: Map<string, StrategyAdapter>,
    private readonly priceOracle: PriceOracle,
    private readonly tradeAmountRaw: bigint,
    private readonly poolTimeoutMs = resolvePoolTimeoutMs(),
    private readonly baseApyOracle?: BaseApyOracle
  ) {}

  async scan(timestamp: number): Promise<PoolSnapshot[]> {
    const enabledPools = this.pools.filter((pool) => pool.enabled);
    let baseApyOverrides = new Map<string, number>();
    if (this.baseApyOracle && enabledPools.length > 0) {
      try {
        baseApyOverrides = await this.baseApyOracle.resolveBaseApyBpsByPool(enabledPools);
      } catch (error) {
        console.warn(
          `[base-apy] Dynamic base APY refresh failed; using static BASE_APY_BPS_* values: ${toErrorMessage(error)}`
        );
      }
    }

    const settled = await Promise.allSettled(
      enabledPools.map((pool) =>
        this.scanPoolWithTimeout(pool, timestamp, baseApyOverrides)
      )
    );

    const snapshots: PoolSnapshot[] = [];
    for (let index = 0; index < settled.length; index += 1) {
      const result = settled[index];
      const pool = enabledPools[index];
      if (result.status === "fulfilled") {
        snapshots.push(result.value);
        continue;
      }

      console.warn(
        `[scanner] Skipping pool ${pool.id} after scan error: ${toErrorMessage(result.reason)}`
      );
    }

    if (enabledPools.length > 0 && snapshots.length === 0) {
      throw new Error("All enabled pools failed to scan.");
    }

    return snapshots.sort((a, b) => b.netApyBps - a.netApyBps);
  }

  private async scanPoolWithTimeout(
    pool: PoolConfig,
    timestamp: number,
    baseApyOverrides: Map<string, number>
  ): Promise<PoolSnapshot> {
    return withTimeout(
      this.scanPool(pool, timestamp, baseApyOverrides),
      this.poolTimeoutMs,
      `Pool ${pool.id} scan timed out after ${this.poolTimeoutMs}ms.`
    );
  }

  private async scanPool(
    pool: PoolConfig,
    timestamp: number,
    baseApyOverrides: Map<string, number>
  ): Promise<PoolSnapshot> {
    const adapter = this.adapters.get(pool.adapterId);
    if (!adapter) {
      throw new Error(`Missing adapter for pool ${pool.id}: ${pool.adapterId}`);
    }

    const state = await adapter.fetchPoolState(pool);
    const baseApyBps = baseApyOverrides.get(pool.id) ?? state.baseApyBps;
    const rewardTokenPriceUsd = await this.priceOracle.getPriceUsd(
      state.rewardTokenSymbol
    );
    const incentiveAprBps = computeIncentiveAprBps(
      state.rewardRatePerSecond,
      rewardTokenPriceUsd,
      state.tvlUsd
    );
    const netApyBps = computeNetApyBps(
      baseApyBps,
      incentiveAprBps,
      state.protocolFeeBps
    );
    const slippageBps = await adapter.estimatePriceImpactBps(
      pool,
      this.tradeAmountRaw
    );

    return {
      poolId: pool.id,
      pair: pool.pair,
      protocol: pool.protocol,
      timestamp,
      tvlUsd: state.tvlUsd,
      incentiveAprBps,
      netApyBps,
      slippageBps,
      rewardRatePerSecond: state.rewardRatePerSecond,
      rewardTokenPriceUsd
    };
  }
}

function resolvePoolTimeoutMs(): number {
  const raw = process.env.SCANNER_POOL_TIMEOUT_MS;
  if (!raw) return DEFAULT_POOL_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_POOL_TIMEOUT_MS;
  return Math.floor(parsed);
}

function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  timeoutMessage: string
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(timeoutMessage));
    }, timeoutMs);

    operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "unknown_error";
}
