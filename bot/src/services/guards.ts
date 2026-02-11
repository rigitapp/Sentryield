import type { GuardResult, PoolSnapshot } from "../types.js";

function deviationBpsFromDollar(price: number): number {
  return Math.round(Math.abs(price - 1) * 10_000);
}

export function depegGuard(
  stablePricesUsd: { AUSD: number; USDC: number },
  maxDeviationBps: number
): GuardResult {
  const ausdDeviation = deviationBpsFromDollar(stablePricesUsd.AUSD);
  const usdcDeviation = deviationBpsFromDollar(stablePricesUsd.USDC);

  if (ausdDeviation > maxDeviationBps || usdcDeviation > maxDeviationBps) {
    return {
      triggered: true,
      reason: "DEPEG_GUARD_TRIGGERED",
      details: `AUSD deviation=${ausdDeviation}bps, USDC deviation=${usdcDeviation}bps`
    };
  }

  return {
    triggered: false,
    reason: "DEPEG_GUARD_OK"
  };
}

export function slippageGuard(
  snapshot: PoolSnapshot,
  maxPriceImpactBps: number
): GuardResult {
  if (snapshot.slippageBps > maxPriceImpactBps) {
    return {
      triggered: true,
      reason: "SLIPPAGE_GUARD_TRIGGERED",
      details: `pool=${snapshot.poolId}, impact=${snapshot.slippageBps}bps, max=${maxPriceImpactBps}bps`
    };
  }

  return {
    triggered: false,
    reason: "SLIPPAGE_GUARD_OK"
  };
}

export function aprCliffGuard(
  currentSnapshot: PoolSnapshot | undefined,
  previousSnapshot: PoolSnapshot | undefined,
  minDropBps: number
): GuardResult {
  if (!currentSnapshot || !previousSnapshot) {
    return {
      triggered: false,
      reason: "APR_CLIFF_GUARD_NOT_ENOUGH_DATA"
    };
  }

  const previousIncentive = previousSnapshot.incentiveAprBps;
  if (previousIncentive <= 0) {
    return {
      triggered: false,
      reason: "APR_CLIFF_GUARD_PREV_ZERO"
    };
  }

  const drop = previousIncentive - currentSnapshot.incentiveAprBps;
  const dropBps = Math.round((drop / previousIncentive) * 10_000);
  if (dropBps > minDropBps) {
    return {
      triggered: true,
      reason: "APR_CLIFF_GUARD_TRIGGERED",
      details: `pool=${currentSnapshot.poolId}, incentiveDrop=${dropBps}bps`
    };
  }

  return {
    triggered: false,
    reason: "APR_CLIFF_GUARD_OK"
  };
}
