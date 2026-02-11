import type {
  PoolConfig,
  PoolOnChainState,
  VaultEnterRequest,
  VaultExitRequest
} from "../types.js";
import type {
  BuildEnterRequestInput,
  BuildExitRequestInput,
  StrategyAdapter
} from "./adapter.interface.js";

export class Dex1Adapter implements StrategyAdapter {
  readonly id = "dex1";

  async fetchPoolState(pool: PoolConfig): Promise<PoolOnChainState> {
    // TODO: Replace placeholders with actual readContract calls against DEX1 pool/reward contracts.
    return {
      tvlUsd: pool.mock.tvlUsd,
      rewardRatePerSecond: pool.mock.rewardRatePerSecond,
      rewardTokenSymbol: pool.rewardTokenSymbol,
      baseApyBps: pool.baseApyBps,
      protocolFeeBps: pool.mock.protocolFeeBps
    };
  }

  async estimatePriceImpactBps(pool: PoolConfig, amountIn: bigint): Promise<number> {
    void amountIn;
    // TODO: Replace with router quote simulation for real trade size.
    return pool.mock.priceImpactBps;
  }

  async estimateRotationCostBps(
    fromPool: PoolConfig,
    toPool: PoolConfig,
    amountIn: bigint
  ): Promise<number> {
    void amountIn;
    // TODO: Replace with aggregate exit+enter quote based on actual LP and route depth.
    return Math.max(fromPool.mock.rotationCostBps, toPool.mock.rotationCostBps);
  }

  async buildEnterRequest(input: BuildEnterRequestInput): Promise<VaultEnterRequest> {
    const request: VaultEnterRequest = {
      target: input.pool.target,
      pool: input.pool.pool,
      tokenIn: input.pool.tokenIn,
      lpToken: input.pool.lpToken,
      amountIn: input.amountIn,
      minOut: input.minOut,
      deadline: input.deadline,
      data: "0x",
      pair: input.pool.pair,
      protocol: input.pool.protocol,
      netApyBps: input.netApyBps,
      intendedHoldSeconds: input.intendedHoldSeconds
    };
    return request;
  }

  async buildExitRequest(input: BuildExitRequestInput): Promise<VaultExitRequest> {
    const request: VaultExitRequest = {
      target: input.pool.target,
      pool: input.pool.pool,
      lpToken: input.pool.lpToken,
      tokenOut: input.tokenOut,
      amountIn: input.amountIn,
      minOut: input.minOut,
      deadline: input.deadline,
      data: "0x",
      pair: input.pool.pair,
      protocol: input.pool.protocol
    };
    return request;
  }
}
