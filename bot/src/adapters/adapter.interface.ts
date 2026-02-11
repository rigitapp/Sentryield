import type {
  PoolConfig,
  PoolOnChainState,
  VaultEnterRequest,
  VaultExitRequest
} from "../types.js";

export interface BuildEnterRequestInput {
  pool: PoolConfig;
  amountIn: bigint;
  minOut: bigint;
  deadline: bigint;
  netApyBps: number;
  intendedHoldSeconds: number;
}

export interface BuildExitRequestInput {
  pool: PoolConfig;
  tokenOut: `0x${string}`;
  amountIn: bigint;
  minOut: bigint;
  deadline: bigint;
}

export interface StrategyAdapter {
  readonly id: string;
  fetchPoolState(pool: PoolConfig): Promise<PoolOnChainState>;
  estimatePriceImpactBps(pool: PoolConfig, amountIn: bigint): Promise<number>;
  estimateRotationCostBps(
    fromPool: PoolConfig,
    toPool: PoolConfig,
    amountIn: bigint
  ): Promise<number>;
  buildEnterRequest(input: BuildEnterRequestInput): Promise<VaultEnterRequest>;
  buildExitRequest(input: BuildExitRequestInput): Promise<VaultExitRequest>;
}
