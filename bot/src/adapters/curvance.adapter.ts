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
    let tvlUsd = pool.mock.tvlUsd;

    try {
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

      // v1 assumes USDC ~= $1.00; replace with oracle-derived valuation if needed.
      tvlUsd = Number(totalAssets) / 10 ** Number(decimals);
    } catch {
      // Fallback to local config if read paths are unavailable on a given RPC.
      tvlUsd = pool.mock.tvlUsd;
    }

    return {
      tvlUsd,
      rewardRatePerSecond: pool.mock.rewardRatePerSecond,
      rewardTokenSymbol: pool.rewardTokenSymbol,
      baseApyBps: pool.baseApyBps,
      protocolFeeBps: pool.mock.protocolFeeBps
    };
  }

  async estimatePriceImpactBps(pool: PoolConfig, amountIn: bigint): Promise<number> {
    if (amountIn <= 0n) return 0;

    try {
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
    } catch {
      // Conservative fallback for unavailable read paths.
      return pool.mock.priceImpactBps;
    }
  }

  async estimateRotationCostBps(
    fromPool: PoolConfig,
    toPool: PoolConfig,
    amountIn: bigint
  ): Promise<number> {
    if (fromPool.id === toPool.id) return 0;
    void amountIn;
    // TODO: replace with explicit exit + enter quote path if v1 expands beyond one pool.
    return Math.max(fromPool.mock.rotationCostBps, toPool.mock.rotationCostBps);
  }

  async buildEnterRequest(input: BuildEnterRequestInput): Promise<VaultEnterRequest> {
    return {
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
  }

  async buildExitRequest(input: BuildExitRequestInput): Promise<VaultExitRequest> {
    return {
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
  }
}
