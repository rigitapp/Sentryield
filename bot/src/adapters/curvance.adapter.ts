import { parseAbi, type PublicClient } from "viem";
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

const CURVANCE_CTOKEN_ABI = parseAbi([
  "function asset() view returns (address)",
  "function totalSupply() view returns (uint256)",
  "function previewDeposit(uint256 assets) view returns (uint256 shares)",
  "function previewRedeem(uint256 shares) view returns (uint256 assets)"
]);

const ERC20_DECIMALS_ABI = parseAbi([
  "function decimals() view returns (uint8)"
]);

export class CurvanceAdapter implements StrategyAdapter {
  readonly id = "curvance";

  constructor(private readonly publicClient: PublicClient) {}

  async fetchPoolState(pool: PoolConfig): Promise<PoolOnChainState> {
    const totalShares = await this.publicClient.readContract({
      address: pool.pool,
      abi: CURVANCE_CTOKEN_ABI,
      functionName: "totalSupply"
    });
    const totalAssets = await this.publicClient.readContract({
      address: pool.pool,
      abi: CURVANCE_CTOKEN_ABI,
      functionName: "previewRedeem",
      args: [totalShares]
    });
    const decimals = await this.publicClient.readContract({
      address: pool.tokenIn,
      abi: ERC20_DECIMALS_ABI,
      functionName: "decimals"
    });

    // USDC pool valuation uses token units converted to USD nominal.
    const tvlUsd = Number(totalAssets) / 10 ** Number(decimals);

    return {
      tvlUsd,
      rewardRatePerSecond: pool.rewardRatePerSecond,
      rewardTokenSymbol: pool.rewardTokenSymbol,
      baseApyBps: pool.baseApyBps,
      protocolFeeBps: pool.protocolFeeBps
    };
  }

  async estimatePriceImpactBps(pool: PoolConfig, amountIn: bigint): Promise<number> {
    if (amountIn <= 0n) return 0;

    const shares = await this.publicClient.readContract({
      address: pool.pool,
      abi: CURVANCE_CTOKEN_ABI,
      functionName: "previewDeposit",
      args: [amountIn]
    });
    const assetsOut = await this.publicClient.readContract({
      address: pool.pool,
      abi: CURVANCE_CTOKEN_ABI,
      functionName: "previewRedeem",
      args: [shares]
    });

    if (assetsOut >= amountIn) return 0;
    const loss = amountIn - assetsOut;
    return Number((loss * 10_000n) / amountIn);
  }

  async estimateRotationCostBps(
    fromPool: PoolConfig,
    toPool: PoolConfig,
    amountIn: bigint
  ): Promise<number> {
    if (fromPool.id === toPool.id) return 0;
    void amountIn;
    // Rotation cost estimate is an explicit config constant until multi-pool
    // quote stitching is implemented.
    return Math.max(fromPool.rotationCostBps, toPool.rotationCostBps);
  }

  async buildEnterRequest(input: BuildEnterRequestInput): Promise<VaultEnterRequest> {
    const quotedShares = await this.publicClient.readContract({
      address: input.pool.pool,
      abi: CURVANCE_CTOKEN_ABI,
      functionName: "previewDeposit",
      args: [input.amountIn]
    });
    const toleranceBps = this.deriveToleranceBps(input.amountIn, input.minOut);
    const minOut = this.applyToleranceBps(quotedShares, toleranceBps);

    return {
      target: input.pool.target,
      pool: input.pool.pool,
      tokenIn: input.pool.tokenIn,
      lpToken: input.pool.lpToken,
      amountIn: input.amountIn,
      minOut,
      deadline: input.deadline,
      data: "0x",
      pair: input.pool.pair,
      protocol: input.pool.protocol,
      netApyBps: input.netApyBps,
      intendedHoldSeconds: input.intendedHoldSeconds
    };
  }

  async buildExitRequest(input: BuildExitRequestInput): Promise<VaultExitRequest> {
    const quotedAssets = await this.publicClient.readContract({
      address: input.pool.pool,
      abi: CURVANCE_CTOKEN_ABI,
      functionName: "previewRedeem",
      args: [input.amountIn]
    });
    const toleranceBps = this.deriveToleranceBps(input.amountIn, input.minOut);
    const minOut = this.applyToleranceBps(quotedAssets, toleranceBps);

    return {
      target: input.pool.target,
      pool: input.pool.pool,
      lpToken: input.pool.lpToken,
      tokenOut: input.tokenOut,
      amountIn: input.amountIn,
      minOut,
      deadline: input.deadline,
      data: "0x",
      pair: input.pool.pair,
      protocol: input.pool.protocol
    };
  }

  private deriveToleranceBps(amountIn: bigint, requestedMinOut: bigint): number {
    if (amountIn <= 0n) return 10_000;
    const clamped = requestedMinOut >= amountIn ? 10_000n : (requestedMinOut * 10_000n) / amountIn;
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
