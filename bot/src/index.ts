import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { privateKeyToAccount } from "viem/accounts";
import {
  createPublicClient,
  createWalletClient,
  http,
  type PublicClient,
  type WalletClient
} from "viem";
import type { StrategyAdapter } from "./adapters/adapter.interface.js";
import { CurvanceAdapter } from "./adapters/curvance.adapter.js";
import { Erc4626Adapter } from "./adapters/erc4626.adapter.js";
import {
  COINGECKO_API_BASE_URL,
  COINGECKO_ID_BY_SYMBOL,
  POOL_BY_ID,
  POOLS,
  POLICY,
  PRICE_ORACLE_CACHE_TTL_MS,
  PRICE_ORACLE_TIMEOUT_MS,
  RUNTIME,
  STABLE_PRICE_SYMBOLS,
  TOKENS
} from "./config.js";
import { DecisionService } from "./services/decision.js";
import { ExecutorService } from "./services/executor.js";
import { ScannerService } from "./services/scanner.js";
import {
  BotStatusServer,
  type BotRuntimeStatus,
  type OperatorAction
} from "./services/status-server.js";
import { ConsoleXClient, TweeterService } from "./services/tweeter.js";
import { LivePriceOracle } from "./services/apy.js";
import { JsonDb } from "./storage/db.js";
import {
  DecisionReasonCode,
  type Decision,
  type ExecutionResult,
  type PoolSnapshot,
  type Position,
  type TweetRecord
} from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, "..", "data", "state.json");

function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (!raw) return fallback;
  return raw.toLowerCase() === "true";
}

function envInteger(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.floor(value);
}

function nowIso(): string {
  return new Date().toISOString();
}

function makeClients(): {
  publicClient: PublicClient;
  walletClient: WalletClient | null;
} {
  const publicClient = createPublicClient({
    transport: http(RUNTIME.rpcUrl)
  });

  let walletClient: WalletClient | null = null;
  if (!RUNTIME.dryRun && RUNTIME.executorPrivateKey) {
    const account = privateKeyToAccount(RUNTIME.executorPrivateKey);
    walletClient = createWalletClient({
      account,
      transport: http(RUNTIME.rpcUrl)
    });
  }

  return { publicClient, walletClient };
}

async function main(): Promise<void> {
  const db = new JsonDb(DB_PATH);
  await db.init();

  const { publicClient, walletClient } = makeClients();
  const adapters = new Map<string, StrategyAdapter>([
    ["curvance", new CurvanceAdapter(publicClient)],
    ["morpho", new Erc4626Adapter("morpho", publicClient)],
    ["gearbox", new Erc4626Adapter("gearbox", publicClient)],
    ["townsquare", new Erc4626Adapter("townsquare", publicClient)],
    ["neverland", new Erc4626Adapter("neverland", publicClient)]
  ]);
  const oracle = new LivePriceOracle({
    baseUrl: COINGECKO_API_BASE_URL,
    stableSymbols: STABLE_PRICE_SYMBOLS,
    coingeckoIdBySymbol: COINGECKO_ID_BY_SYMBOL,
    timeoutMs: PRICE_ORACLE_TIMEOUT_MS,
    cacheTtlMs: PRICE_ORACLE_CACHE_TTL_MS
  });

  const scanner = new ScannerService(
    POOLS,
    adapters,
    oracle,
    RUNTIME.defaultTradeAmountRaw
  );
  const decisionService = new DecisionService(
    POLICY,
    POOL_BY_ID,
    adapters,
    RUNTIME.defaultTradeAmountRaw
  );
  const executor = new ExecutorService(
    {
      vaultAddress: RUNTIME.vaultAddress,
      dryRun: RUNTIME.dryRun,
      liveModeArmed: RUNTIME.liveModeArmed,
      defaultTradeAmountRaw: RUNTIME.defaultTradeAmountRaw,
      txDeadlineSeconds: POLICY.txDeadlineSeconds,
      maxPriceImpactBps: POLICY.maxPriceImpactBps,
      minHoldSeconds: POLICY.minHoldSeconds,
      enterOnlyMode: RUNTIME.enterOnlyMode,
      maxRotationsPerDay: RUNTIME.maxRotationsPerDay,
      cooldownSeconds: RUNTIME.cooldownSeconds,
      usdcToken: TOKENS.USDC
    },
    publicClient,
    walletClient,
    POOL_BY_ID,
    adapters
  );
  const tweeter = new TweeterService(
    {
      enabled: Boolean(process.env.X_ENABLE_TWEETS === "true"),
      explorerTxBaseUrl: RUNTIME.explorerTxBaseUrl,
      minHoldHours: POLICY.minHoldSeconds / 3600,
      rotateDeltaPct: POLICY.rotationDeltaApyBps / 100,
      maxPaybackHours: POLICY.maxPaybackHours
    },
    new ConsoleXClient()
  );
  const runOnce = envBool("RUN_ONCE", true);

  const runtimeStatus: BotRuntimeStatus = {
    service: "sentryield-bot",
    startedAt: nowIso(),
    runMode: runOnce ? "once" : "loop",
    scanIntervalSeconds: RUNTIME.scanIntervalSeconds,
    staleAfterSeconds: envInteger(
      "BOT_HEALTH_STALE_SECONDS",
      Math.max(RUNTIME.scanIntervalSeconds * 3, 60)
    ),
    inFlight: false,
    totalTicks: 0,
    successfulTicks: 0,
    failedTicks: 0,
    lastTickStartedAt: null,
    lastTickFinishedAt: null,
    lastSuccessfulTickAt: null,
    lastErrorAt: null,
    lastErrorMessage: null
  };

  const statusServerEnabled = envBool("BOT_STATUS_SERVER_ENABLED", !runOnce);
  const statusServerRequired = envBool("BOT_STATUS_SERVER_REQUIRED", false);
  const statusServerHost = process.env.BOT_STATUS_HOST?.trim() || "0.0.0.0";
  const statusServerPort = envInteger("BOT_STATUS_PORT", 8787);
  const statusAuthToken = process.env.BOT_STATUS_AUTH_TOKEN?.trim() || "";
  const statusServer = statusServerEnabled
    ? new BotStatusServer({
        host: statusServerHost,
        port: statusServerPort,
        authToken: statusAuthToken,
        statusProvider: () => ({ ...runtimeStatus }),
        stateProvider: () => db.getState()
      })
    : null;
  let startedStatusServer: BotStatusServer | null = null;
  if (statusServer) {
    try {
      await statusServer.start();
      startedStatusServer = statusServer;
      console.log(`[status-server] listening on http://${statusServerHost}:${statusServerPort}`);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown status server startup error.";
      if (statusServerRequired) {
        throw error;
      }
      console.warn(`[status-server] disabled (startup failed): ${message}`);
    }
  }

  let inFlight = false;
  const tick = async (): Promise<void> => {
    if (inFlight) {
      console.warn("Previous run still in progress; skipping this interval.");
      return;
    }

    inFlight = true;
    runtimeStatus.inFlight = true;
    runtimeStatus.totalTicks += 1;
    runtimeStatus.lastTickStartedAt = nowIso();
    let tickFailed = false;

    try {
      const nowTs = Math.floor(Date.now() / 1000);
      const stateBefore = await db.getState();
      const snapshots = await scanner.scan(nowTs);
      await db.addSnapshots(snapshots);

      const stablePricesUsd = await oracle.getStablePricesUsd();
      const autoDecision = await decisionService.decide({
        nowTs,
        position: stateBefore.position,
        snapshots,
        previousSnapshots: stateBefore.snapshots,
        stablePricesUsd
      });
      const manualAction = startedStatusServer?.consumePendingAction() ?? null;
      const decision = applyOperatorOverrides({
        nowTs,
        defaultDecision: autoDecision,
        manualAction,
        paused: startedStatusServer?.isPaused() ?? false,
        position: stateBefore.position,
        snapshots
      });
      await db.addDecision(decision);

      console.log(
        `[decision] ${decision.action} | reasonCode=${decision.reasonCode} | ${decision.reason}`
      );

      const execution = await executor.execute({
        decision,
        position: stateBefore.position,
        recentDecisions: stateBefore.decisions,
        snapshots,
        nowTs
      });
      if (!execution) return;
      if (execution.error) {
        const line =
          `[execution-error] ${execution.error.code} | ${execution.error.message} | ${execution.error.details ?? "n/a"}`;
        runtimeStatus.lastErrorAt = nowIso();
        runtimeStatus.lastErrorMessage = line;
        if (execution.error.code === "POLICY_BLOCKED") {
          console.warn(line);
        } else {
          console.error(line);
        }
        return;
      }

      await db.setPosition(execution.updatedPosition);
      if (
        execution.action === "EXIT_TO_USDC" &&
        execution.updatedPosition?.poolId &&
        startedStatusServer
      ) {
        startedStatusServer.queueAction({
          type: "EXIT_TO_USDC",
          requestedAt: nowIso(),
          requestedBy: "auto_continue_partial_exit"
        });
        console.log(
          `[controls] partial exit detected for ${execution.updatedPosition.poolId}; queued follow-up EXIT_TO_USDC.`
        );
      }
      const tweet = await maybeTweet(tweeter, execution, {
        reason: decision.reason,
        previousPair: stateBefore.position?.pair ?? "unknown",
        oldApyBps: decision.oldNetApyBps,
        newApyBps: decision.newNetApyBps
      });
      if (tweet) {
        await db.addTweet(tweet);
      }
      console.log(`[execution] ${execution.action} | tx=${execution.txHashes.join(",")}`);
    } catch (error) {
      tickFailed = true;
      runtimeStatus.lastErrorAt = nowIso();
      runtimeStatus.lastErrorMessage =
        error instanceof Error ? error.message : String(error);
      console.error("Tick failed:", error);
    } finally {
      inFlight = false;
      runtimeStatus.inFlight = false;
      runtimeStatus.lastTickFinishedAt = nowIso();
      if (tickFailed) {
        runtimeStatus.failedTicks += 1;
      } else {
        runtimeStatus.successfulTicks += 1;
        runtimeStatus.lastSuccessfulTickAt = runtimeStatus.lastTickFinishedAt;
      }
    }
  };

  await tick();

  if (runOnce) {
    if (startedStatusServer) {
      await startedStatusServer.stop();
    }
    return;
  }

  const intervalMs = RUNTIME.scanIntervalSeconds * 1_000;
  console.log(`Bot running in loop mode. Interval=${RUNTIME.scanIntervalSeconds}s`);
  setInterval(() => {
    void tick();
  }, intervalMs);
}

function applyOperatorOverrides(input: {
  nowTs: number;
  defaultDecision: Decision;
  manualAction: OperatorAction | null;
  paused: boolean;
  position: Position | null;
  snapshots: PoolSnapshot[];
}): Decision {
  if (input.manualAction) {
    const manualDecision = buildManualDecision(
      input.nowTs,
      input.manualAction,
      input.position,
      input.snapshots
    );
    if (manualDecision) {
      return manualDecision;
    }
  }

  if (input.paused) {
    return {
      timestamp: input.nowTs,
      action: "HOLD",
      reason: "Operator paused automated rotations.",
      reasonCode: DecisionReasonCode.OPERATOR_PAUSED,
      chosenPoolId: null,
      fromPoolId: input.position?.poolId ?? null,
      emergency: false,
      oldNetApyBps: input.position?.lastNetApyBps ?? 0,
      newNetApyBps: 0,
      estimatedPaybackHours: null
    };
  }

  return input.defaultDecision;
}

function buildManualDecision(
  nowTs: number,
  manualAction: OperatorAction,
  position: Position | null,
  snapshots: PoolSnapshot[]
): Decision | null {
  const snapshotByPool = new Map(snapshots.map((snapshot) => [snapshot.poolId, snapshot]));
  const currentPoolId = position?.poolId ?? null;

  if (manualAction.type === "EXIT_TO_USDC") {
    if (!currentPoolId) {
      return {
        timestamp: nowTs,
        action: "HOLD",
        reason: "Manual exit requested but no active position.",
        reasonCode: DecisionReasonCode.NO_ELIGIBLE_POOL,
        chosenPoolId: null,
        fromPoolId: null,
        emergency: false,
        oldNetApyBps: 0,
        newNetApyBps: 0,
        estimatedPaybackHours: null
      };
    }
    return {
      timestamp: nowTs,
      action: "EXIT_TO_USDC",
      reason: "Manual operator exit to USDC.",
      reasonCode: DecisionReasonCode.OPERATOR_MANUAL_EXIT,
      chosenPoolId: null,
      fromPoolId: currentPoolId,
      emergency: false,
      oldNetApyBps: position?.lastNetApyBps ?? 0,
      newNetApyBps: 0,
      estimatedPaybackHours: null
    };
  }

  if (manualAction.type !== "ROTATE") {
    return null;
  }
  const targetPoolId = manualAction.poolId?.trim();
  if (!targetPoolId) {
    return {
      timestamp: nowTs,
      action: "HOLD",
      reason: "Manual rotate requested without a target pool.",
      reasonCode: DecisionReasonCode.NO_ELIGIBLE_POOL,
      chosenPoolId: null,
      fromPoolId: currentPoolId,
      emergency: false,
      oldNetApyBps: position?.lastNetApyBps ?? 0,
      newNetApyBps: 0,
      estimatedPaybackHours: null
    };
  }

  const targetSnapshot = snapshotByPool.get(targetPoolId);
  if (!targetSnapshot) {
    return {
      timestamp: nowTs,
      action: "HOLD",
      reason: `Manual rotate target pool is unavailable: ${targetPoolId}`,
      reasonCode: DecisionReasonCode.NO_ELIGIBLE_POOL,
      chosenPoolId: null,
      fromPoolId: currentPoolId,
      emergency: false,
      oldNetApyBps: position?.lastNetApyBps ?? 0,
      newNetApyBps: 0,
      estimatedPaybackHours: null
    };
  }

  if (!currentPoolId) {
    return {
      timestamp: nowTs,
      action: "ENTER",
      reason: `Manual operator enter into ${targetPoolId}.`,
      reasonCode: DecisionReasonCode.OPERATOR_MANUAL_ENTER,
      chosenPoolId: targetPoolId,
      fromPoolId: null,
      emergency: false,
      oldNetApyBps: 0,
      newNetApyBps: targetSnapshot.netApyBps,
      estimatedPaybackHours: null
    };
  }

  if (currentPoolId === targetPoolId) {
    return {
      timestamp: nowTs,
      action: "HOLD",
      reason: "Manual rotate target is the current pool; no-op.",
      reasonCode: DecisionReasonCode.NO_ELIGIBLE_POOL,
      chosenPoolId: null,
      fromPoolId: currentPoolId,
      emergency: false,
      oldNetApyBps: position?.lastNetApyBps ?? 0,
      newNetApyBps: targetSnapshot.netApyBps,
      estimatedPaybackHours: null
    };
  }

  const currentSnapshot = snapshotByPool.get(currentPoolId);
  return {
    timestamp: nowTs,
    action: "ROTATE",
    reason: `Manual operator rotate to ${targetPoolId}.`,
    reasonCode: DecisionReasonCode.OPERATOR_MANUAL_ROTATE,
    chosenPoolId: targetPoolId,
    fromPoolId: currentPoolId,
    emergency: false,
    oldNetApyBps: currentSnapshot?.netApyBps ?? position?.lastNetApyBps ?? 0,
    newNetApyBps: targetSnapshot.netApyBps,
    estimatedPaybackHours: null
  };
}

async function maybeTweet(
  tweeter: TweeterService,
  execution: ExecutionResult,
  context: {
    reason: string;
    previousPair: string;
    oldApyBps: number;
    newApyBps: number;
  }
): Promise<TweetRecord | null> {
  const txHash = execution.txHashes[0];
  if (!txHash) return null;

  if (execution.action === "ENTER" && execution.updatedPosition?.pair) {
    const tweet = await tweeter.tweetDeployed({
      protocol: execution.updatedPosition.protocol ?? "Unknown",
      pair: execution.updatedPosition.pair,
      netApyBps: execution.updatedPosition.lastNetApyBps,
      txHash
    });
    console.log("[tweet]", tweet.body);
    return tweet;
  }

  if (execution.action === "ROTATE" && execution.updatedPosition?.pair) {
    const tweet = await tweeter.tweetRotated({
      fromPair: context.previousPair,
      toPair: execution.updatedPosition.pair,
      oldApyBps: context.oldApyBps,
      newApyBps: context.newApyBps,
      reason: context.reason,
      txHash
    });
    console.log("[tweet]", tweet.body);
    return tweet;
  }

  if (execution.action === "EXIT_TO_USDC" && !execution.updatedPosition?.poolId) {
    const tweet = await tweeter.tweetEmergencyExit(context.reason, txHash);
    console.log("[tweet]", tweet.body);
    return tweet;
  }

  return null;
}

void main();
