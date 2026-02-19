import { encodeAbiParameters, parseAbi, type PublicClient } from "viem";
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

const RAY = 10n ** 27n;
const AAVE_POOL_ABI = parseAbi([
  "function getReserveData(address asset) view returns ((uint256 configuration,uint128 liquidityIndex,uint128 currentLiquidityRate,uint128 variableBorrowIndex,uint128 currentVariableBorrowRate,uint128 currentStableBorrowRate,uint40 lastUpdateTimestamp,uint16 id,address aTokenAddress,address stableDebtTokenAddress,address variableDebtTokenAddress,address interestRateStrategyAddress,uint128 accruedToTreasury,uint128 unbacked,uint128 isolationModeTotalDebt) data)"
]);
const ERC20_SUPPLY_ABI = parseAbi([
  "function totalSupply() view returns (uint256)"
]);
const ERC20_DECIMALS_ABI = parseAbi([
  "function decimals() view returns (uint8)"
]);

interface AaveReserveData {
  currentLiquidityRate: bigint;
  aTokenAddress: `0x${string}`;
}

export class NeverlandAaveAdapter implements StrategyAdapter {
  readonly id = "neverland";

  constructor(private readonly publicClient: PublicClient) {}

  async fetchPoolState(pool: PoolConfig): Promise<PoolOnChainState> {
    const reserve = await this.readReserveData(pool);
    if (reserve.aTokenAddress.toLowerCase() !== pool.lpToken.toLowerCase()) {
      throw new Error(
        `Neverland lpToken mismatch for ${pool.id}: configured=${pool.lpToken}, reserve=${reserve.aTokenAddress}`
      );
    }

    const [aTokenSupply, tokenDecimals] = await Promise.all([
      this.publicClient.readContract({
        address: reserve.aTokenAddress,
        abi: ERC20_SUPPLY_ABI,
        functionName: "totalSupply"
      }),
      this.publicClient.readContract({
        address: pool.tokenIn,
        abi: ERC20_DECIMALS_ABI,
        functionName: "decimals"
      })
    ]);
    const tvlUsd = Number(aTokenSupply) / 10 ** Number(tokenDecimals);

    return {
      tvlUsd,
      rewardRatePerSecond: pool.rewardRatePerSecond,
      rewardTokenSymbol: pool.rewardTokenSymbol,
      baseApyBps: rayToBps(reserve.currentLiquidityRate),
      protocolFeeBps: pool.protocolFeeBps
    };
  }

  async estimatePriceImpactBps(pool: PoolConfig, amountIn: bigint): Promise<number> {
    void pool;
    void amountIn;
    return 0;
  }

  async estimateRotationCostBps(
    fromPool: PoolConfig,
    toPool: PoolConfig,
    amountIn: bigint
  ): Promise<number> {
    if (fromPool.id === toPool.id) return 0;
    void amountIn;
    return Math.max(fromPool.rotationCostBps, toPool.rotationCostBps);
  }

  async buildEnterRequest(input: BuildEnterRequestInput): Promise<VaultEnterRequest> {
    const toleranceBps = this.deriveToleranceBps(input.amountIn, input.minOut);
    const minOut = this.applyToleranceBps(input.amountIn, toleranceBps);

    return {
      target: input.pool.target,
      pool: input.pool.pool,
      tokenIn: input.pool.tokenIn,
      lpToken: input.pool.lpToken,
      amountIn: input.amountIn,
      minOut,
      deadline: input.deadline,
      // Pass expected aToken so the onchain adapter can fail-fast on misconfigured lpToken.
      data: encodeAbiParameters([{ type: "address" }], [input.pool.lpToken]),
      pair: input.pool.pair,
      protocol: input.pool.protocol,
      netApyBps: input.netApyBps,
      intendedHoldSeconds: input.intendedHoldSeconds
    };
  }

  async buildExitRequest(input: BuildExitRequestInput): Promise<VaultExitRequest> {
    const toleranceBps = this.deriveToleranceBps(input.amountIn, input.minOut);
    const minOut = this.applyToleranceBps(input.amountIn, toleranceBps);

    return {
      target: input.pool.target,
      pool: input.pool.pool,
      lpToken: input.pool.lpToken,
      tokenOut: input.tokenOut,
      amountIn: input.amountIn,
      minOut,
      deadline: input.deadline,
      // Pass expected aToken so the onchain adapter can fail-fast on misconfigured lpToken.
      data: encodeAbiParameters([{ type: "address" }], [input.pool.lpToken]),
      pair: input.pool.pair,
      protocol: input.pool.protocol
    };
  }

  private async readReserveData(pool: PoolConfig): Promise<AaveReserveData> {
    return (await this.publicClient.readContract({
      address: pool.pool,
      abi: AAVE_POOL_ABI,
      functionName: "getReserveData",
      args: [pool.tokenIn]
    })) as AaveReserveData;
  }

  private deriveToleranceBps(amountIn: bigint, requestedMinOut: bigint): number {
    if (amountIn <= 0n) return 10_000;
    const clamped =
      requestedMinOut >= amountIn ? 10_000n : (requestedMinOut * 10_000n) / amountIn;
    const value = Number(clamped);
    if (!Number.isFinite(value)) return 10_000;
    return Math.max(1, Math.min(10_000, Math.floor(value)));
  }

  private applyToleranceBps(quotedOut: bigint, toleranceBps: number): bigint {
    if (quotedOut <= 0n) return 1n;
    const minOut = (quotedOut * BigInt(toleranceBps)) / 10_000n;
    return minOut > 0n ? minOut : 1n;
  }
}

function rayToBps(rateRay: bigint): number {
  if (rateRay <= 0n) return 0;
  const bps = (rateRay * 10_000n) / RAY;
  const bounded = bps > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : bps;
  return Number(bounded);
}
