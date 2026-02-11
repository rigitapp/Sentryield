import type { StrategyAdapter } from "../adapters/adapter.interface.js";
import type { PoolConfig, PoolSnapshot } from "../types.js";
import {
  computeIncentiveAprBps,
  computeNetApyBps,
  type PriceOracle
} from "./apy.js";

export class ScannerService {
  constructor(
    private readonly pools: PoolConfig[],
    private readonly adapters: Map<string, StrategyAdapter>,
    private readonly priceOracle: PriceOracle,
    private readonly tradeAmountRaw: bigint
  ) {}

  async scan(timestamp: number): Promise<PoolSnapshot[]> {
    const snapshots: PoolSnapshot[] = [];

    for (const pool of this.pools) {
      if (!pool.enabled) continue;

      const adapter = this.adapters.get(pool.adapterId);
      if (!adapter) {
        throw new Error(`Missing adapter for pool ${pool.id}: ${pool.adapterId}`);
      }

      const state = await adapter.fetchPoolState(pool);
      const rewardTokenPriceUsd = await this.priceOracle.getPriceUsd(
        state.rewardTokenSymbol
      );
      const incentiveAprBps = computeIncentiveAprBps(
        state.rewardRatePerSecond,
        rewardTokenPriceUsd,
        state.tvlUsd
      );
      const netApyBps = computeNetApyBps(
        state.baseApyBps,
        incentiveAprBps,
        state.protocolFeeBps
      );
      const slippageBps = await adapter.estimatePriceImpactBps(
        pool,
        this.tradeAmountRaw
      );

      snapshots.push({
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
      });
    }

    return snapshots.sort((a, b) => b.netApyBps - a.netApyBps);
  }
}
