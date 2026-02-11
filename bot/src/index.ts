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
import { POOL_BY_ID, POOLS, POLICY, RUNTIME, STATIC_PRICES_USD, TOKENS } from "./config.js";
import { DecisionService } from "./services/decision.js";
import { ExecutorService } from "./services/executor.js";
import { ScannerService } from "./services/scanner.js";
import { ConsoleXClient, TweeterService } from "./services/tweeter.js";
import { StaticPriceOracle } from "./services/apy.js";
import { JsonDb } from "./storage/db.js";
import type { ExecutionResult, TweetRecord } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, "..", "data", "state.json");

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
    ["curvance", new CurvanceAdapter(publicClient)]
  ]);
  const oracle = new StaticPriceOracle(STATIC_PRICES_USD);

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

  let inFlight = false;
  const tick = async (): Promise<void> => {
    if (inFlight) {
      console.warn("Previous run still in progress; skipping this interval.");
      return;
    }

    inFlight = true;
    try {
      const nowTs = Math.floor(Date.now() / 1000);
      const stateBefore = await db.getState();
      const snapshots = await scanner.scan(nowTs);
      await db.addSnapshots(snapshots);

      const stablePricesUsd = await oracle.getStablePricesUsd();
      const decision = await decisionService.decide({
        nowTs,
        position: stateBefore.position,
        snapshots,
        previousSnapshots: stateBefore.snapshots,
        stablePricesUsd
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
        if (execution.error.code === "POLICY_BLOCKED") {
          console.warn(line);
        } else {
          console.error(line);
        }
        return;
      }

      await db.setPosition(execution.updatedPosition);
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
      console.error("Tick failed:", error);
    } finally {
      inFlight = false;
    }
  };

  const runOnce = (process.env.RUN_ONCE ?? "true").toLowerCase() === "true";
  await tick();

  if (!runOnce) {
    const intervalMs = RUNTIME.scanIntervalSeconds * 1_000;
    console.log(`Bot running in loop mode. Interval=${RUNTIME.scanIntervalSeconds}s`);
    setInterval(() => {
      void tick();
    }, intervalMs);
  }
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

  if (execution.action === "EXIT_TO_USDC") {
    const tweet = await tweeter.tweetEmergencyExit(context.reason, txHash);
    console.log("[tweet]", tweet.body);
    return tweet;
  }

  return null;
}

void main();
