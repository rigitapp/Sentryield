const SECONDS_PER_YEAR = 365 * 24 * 60 * 60;

export interface PriceOracle {
  getPriceUsd(symbol: string): Promise<number>;
  getStablePricesUsd(): Promise<{ AUSD: number; USDC: number }>;
}

export class StaticPriceOracle implements PriceOracle {
  constructor(private readonly pricesUsd: Record<string, number>) {}

  async getPriceUsd(symbol: string): Promise<number> {
    const price = this.pricesUsd[symbol];
    if (price === undefined) {
      throw new Error(`Missing price for symbol: ${symbol}`);
    }
    return price;
  }

  async getStablePricesUsd(): Promise<{ AUSD: number; USDC: number }> {
    const AUSD = await this.getPriceUsd("AUSD");
    const USDC = await this.getPriceUsd("USDC");
    return { AUSD, USDC };
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
