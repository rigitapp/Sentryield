import type { StrategyAdapter } from "../adapters/adapter.interface.js";
import type {
  Decision,
  DecisionReasonCode,
  PolicyConfig,
  PoolConfig,
  PoolSnapshot,
  Position
} from "../types.js";
import { DecisionReasonCode as ReasonCode } from "../types.js";
import { estimatePaybackHours } from "./apy.js";
import { aprCliffGuard, depegGuard, slippageGuard } from "./guards.js";

interface DecideInput {
  nowTs: number;
  position: Position | null;
  snapshots: PoolSnapshot[];
  previousSnapshots: PoolSnapshot[];
  stablePricesUsd: Record<string, number>;
  deployableEntryPoolIds?: Set<string>;
}

export class DecisionService {
  private readonly vaultDepositTokenLower: string;

  constructor(
    private readonly policy: PolicyConfig,
    private readonly poolById: Map<string, PoolConfig>,
    private readonly adapters: Map<string, StrategyAdapter>,
    private readonly tradeAmountRaw: bigint,
    vaultDepositToken: string
  ) {
    this.vaultDepositTokenLower = vaultDepositToken.toLowerCase();
  }

  async decide(input: DecideInput): Promise<Decision> {
    const eligibleSnapshots = input.snapshots.filter((snapshot) => {
      const pool = this.poolById.get(snapshot.poolId);
      return (
        pool?.enabled &&
        pool.tier === "S" &&
        pool.tokenIn.toLowerCase() === this.vaultDepositTokenLower
      );
    });
    const deployableEligibleSnapshots = input.deployableEntryPoolIds
      ? eligibleSnapshots.filter((snapshot) => input.deployableEntryPoolIds?.has(snapshot.poolId))
      : eligibleSnapshots;

    if (eligibleSnapshots.length === 0) {
      return this.hold(input.nowTs, "No eligible Tier-S pools found.", ReasonCode.NO_ELIGIBLE_POOL);
    }

    const currentPoolId = input.position?.poolId ?? null;
    const currentSnapshot = currentPoolId
      ? eligibleSnapshots.find((s) => s.poolId === currentPoolId)
      : undefined;

    const depeg = depegGuard(input.stablePricesUsd, this.policy.depegThresholdBps);
    if (depeg.triggered && currentPoolId) {
      return {
        timestamp: input.nowTs,
        action: "EXIT_TO_USDC",
        reason: `${depeg.reason}: ${depeg.details ?? ""}`.trim(),
        reasonCode: ReasonCode.DEPEG_EXIT,
        chosenPoolId: null,
        fromPoolId: currentPoolId,
        emergency: true,
        oldNetApyBps: currentSnapshot?.netApyBps ?? input.position?.lastNetApyBps ?? 0,
        newNetApyBps: 0,
        estimatedPaybackHours: null
      };
    }

    if (currentPoolId && currentSnapshot) {
      const previousSnapshot = this.latestSnapshot(input.previousSnapshots, currentPoolId);
      const aprCliff = aprCliffGuard(
        currentSnapshot,
        previousSnapshot,
        this.policy.aprCliffDropBps
      );
      if (aprCliff.triggered) {
        return {
          timestamp: input.nowTs,
          action: "EXIT_TO_USDC",
          reason: `${aprCliff.reason}: ${aprCliff.details ?? ""}`.trim(),
          reasonCode: ReasonCode.APR_CLIFF_EXIT,
          chosenPoolId: null,
          fromPoolId: currentPoolId,
          emergency: true,
          oldNetApyBps: currentSnapshot.netApyBps,
          newNetApyBps: 0,
          estimatedPaybackHours: null
        };
      }
    }

    const hasActivePosition = Boolean(currentPoolId);
    if (!hasActivePosition) {
      if (depeg.triggered) {
        return this.hold(
          input.nowTs,
          `Depeg guard active. Skipping new deploy: ${depeg.details ?? ""}`.trim(),
          ReasonCode.NO_ELIGIBLE_POOL
        );
      }

      const candidate = this.pickBestCandidate(deployableEligibleSnapshots);
      if (!candidate) {
        if (input.deployableEntryPoolIds && deployableEligibleSnapshots.length === 0) {
          return this.hold(
            input.nowTs,
            "No deployable token balance available under movement caps.",
            ReasonCode.NO_ELIGIBLE_POOL
          );
        }
        return this.hold(
          input.nowTs,
          "No candidate passed slippage guard for entry.",
          ReasonCode.SLIPPAGE_TOO_HIGH
        );
      }

      return {
        timestamp: input.nowTs,
        action: "ENTER",
        reason:
          "No active position. Deploying capital to best Tier-S pool by net APY.",
        reasonCode: ReasonCode.INITIAL_DEPLOY,
        chosenPoolId: candidate.poolId,
        fromPoolId: null,
        emergency: false,
        oldNetApyBps: 0,
        newNetApyBps: candidate.netApyBps,
        estimatedPaybackHours: null
      };
    }

    if (!currentPoolId) {
      return this.hold(
        input.nowTs,
        "Current position id is missing; skipping rotation.",
        ReasonCode.NO_ELIGIBLE_POOL
      );
    }

    const enteredAt = input.position?.enteredAt ?? null;
    if (enteredAt && input.nowTs - enteredAt < this.policy.minHoldSeconds) {
      const remainingSeconds = Math.max(0, this.policy.minHoldSeconds - (input.nowTs - enteredAt));
      return this.hold(
        input.nowTs,
        this.minHoldReason(remainingSeconds),
        ReasonCode.MIN_HOLD_ACTIVE,
        currentPoolId
      );
    }

    if (!currentSnapshot) {
      return this.hold(
        input.nowTs,
        "Current pool snapshot missing; skipping rotation this cycle.",
        ReasonCode.NO_ELIGIBLE_POOL,
        currentPoolId
      );
    }

    const candidate = this.pickBestCandidate(eligibleSnapshots, currentPoolId);
    if (!candidate) {
      return this.hold(
        input.nowTs,
        "No alternate Tier-S pool passed slippage guard.",
        ReasonCode.SLIPPAGE_TOO_HIGH,
        currentPoolId
      );
    }

    const deltaBps = candidate.netApyBps - currentSnapshot.netApyBps;
    if (deltaBps < this.policy.rotationDeltaApyBps) {
      return this.hold(
        input.nowTs,
        `APY delta ${deltaBps}bps is below threshold ${this.policy.rotationDeltaApyBps}bps.`,
        ReasonCode.DELTA_BELOW_THRESHOLD,
        currentPoolId
      );
    }

    const fromPool = this.poolById.get(currentPoolId);
    const toPool = this.poolById.get(candidate.poolId);
    if (!fromPool || !toPool) {
      return this.hold(
        input.nowTs,
        "Pool config missing for rotation candidate.",
        ReasonCode.NO_ELIGIBLE_POOL,
        currentPoolId
      );
    }

    const adapter = this.adapters.get(fromPool.adapterId);
    if (!adapter) {
      throw new Error(`Missing adapter for pool ${fromPool.id}: ${fromPool.adapterId}`);
    }

    const costBps = await adapter.estimateRotationCostBps(
      fromPool,
      toPool,
      this.tradeAmountRaw
    );
    const paybackHours = estimatePaybackHours(costBps, deltaBps);
    if (paybackHours > this.policy.maxPaybackHours) {
      return this.hold(
        input.nowTs,
        `Payback ${paybackHours.toFixed(2)}h exceeds max ${this.policy.maxPaybackHours}h.`,
        ReasonCode.PAYBACK_TOO_LONG,
        currentPoolId
      );
    }

    return {
      timestamp: input.nowTs,
      action: "ROTATE",
      reason: `Rotate for +${deltaBps}bps net APY with payback ${paybackHours.toFixed(2)}h.`,
      reasonCode: ReasonCode.APY_UPGRADE,
      chosenPoolId: candidate.poolId,
      fromPoolId: currentPoolId,
      emergency: false,
      oldNetApyBps: currentSnapshot.netApyBps,
      newNetApyBps: candidate.netApyBps,
      estimatedPaybackHours: paybackHours
    };
  }

  private hold(
    timestamp: number,
    reason: string,
    reasonCode: DecisionReasonCode,
    fromPoolId: string | null = null
  ): Decision {
    return {
      timestamp,
      action: "HOLD",
      reason,
      reasonCode,
      chosenPoolId: null,
      fromPoolId,
      emergency: false,
      oldNetApyBps: 0,
      newNetApyBps: 0,
      estimatedPaybackHours: null
    };
  }

  private pickBestCandidate(
    snapshots: PoolSnapshot[],
    excludePoolId?: string | null
  ): PoolSnapshot | null {
    const ranked = [...snapshots].sort((a, b) => b.netApyBps - a.netApyBps);
    for (const snapshot of ranked) {
      if (excludePoolId && snapshot.poolId === excludePoolId) continue;
      const slippage = slippageGuard(snapshot, this.policy.maxPriceImpactBps);
      if (!slippage.triggered) return snapshot;
    }
    return null;
  }

  private latestSnapshot(
    snapshots: PoolSnapshot[],
    poolId: string
  ): PoolSnapshot | undefined {
    const filtered = snapshots
      .filter((snapshot) => snapshot.poolId === poolId)
      .sort((a, b) => b.timestamp - a.timestamp);
    return filtered[0];
  }

  private minHoldReason(remainingSeconds: number): string {
    const holdSeconds = this.policy.minHoldSeconds;
    if (holdSeconds <= 0) {
      return "Min hold policy is disabled.";
    }
    const holdHours = holdSeconds / 3600;
    const remainingHours = remainingSeconds / 3600;
    return `Min hold time (${holdHours.toFixed(1)}h) active. Remaining: ${remainingHours.toFixed(
      1
    )}h.`;
  }
}
