import "server-only";

import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createPublicClient,
  erc20Abi,
  formatUnits,
  http,
  isAddress,
  parseAbi,
  parseAbiItem
} from "viem";
import type {
  AgentTransaction,
  AgentStatus,
  DashboardData,
  GuardStatus,
  GuardStatusLevel,
  LatestDecision,
  Position,
  PoolOption,
  Rotation,
  Snapshot,
  Tweet
} from "@/lib/types";
import type { DashboardProfile } from "@/lib/server/dashboard-profiles";

type DecisionAction = "HOLD" | "ENTER" | "ROTATE" | "EXIT_TO_USDC";
type BotTweetType = "DEPLOYED" | "ROTATED" | "EMERGENCY_EXIT";

interface BotPosition {
  poolId: string | null;
  pair: string | null;
  protocol: string | null;
  enteredAt: number | null;
  lpBalance: string;
  lastNetApyBps: number;
  parkedToken: "USDC" | null;
}

interface BotSnapshot {
  poolId: string;
  pair: string;
  protocol: string;
  timestamp: number;
  incentiveAprBps: number;
  netApyBps: number;
  slippageBps: number;
  rewardTokenPriceUsd: number;
}

interface BotDecision {
  timestamp: number;
  chosenPoolId: string | null;
  reason: string;
  action: DecisionAction;
}

interface BotTweet {
  timestamp: number;
  type: BotTweetType;
  txHash: string | null;
  body: string;
}

interface BotState {
  position: BotPosition | null;
  snapshots: BotSnapshot[];
  decisions: BotDecision[];
  tweets: BotTweet[];
}

interface ReadBotStateResult {
  state: BotState;
  source: "remote" | "local" | "empty";
  warnings: string[];
}

interface RemoteStatusEnvelope {
  healthy?: unknown;
  ready?: unknown;
  state?: unknown;
}

const DEFAULT_STATE_PATH = join(process.cwd(), "bot", "data", "state.json");
const CHAIN_CONFIG_PATH = join(
  process.cwd(),
  "bot",
  "config",
  "curvance.monad.mainnet.json"
);
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const DEFAULT_SCAN_INTERVAL_SECONDS = 300;
const DEFAULT_MIN_HOLD_HOURS = 24;
const DEFAULT_ROTATION_DELTA_PCT = 2;
const DEFAULT_MAX_PAYBACK_HOURS = 72;
const DEFAULT_EXPLORER_TX_BASE_URL = "https://monadscan.com/tx/";
const DEFAULT_DEPEG_THRESHOLD_PCT = 1;
const DEFAULT_SLIPPAGE_THRESHOLD_PCT = 0.3;
const DEFAULT_APR_CLIFF_THRESHOLD_PCT = 50;
const DEFAULT_VAULT_TOKEN_DECIMALS = 6;
const DEFAULT_RPC_URL = "https://rpc.monad.xyz";
const DEFAULT_COINGECKO_API_BASE_URL = "https://api.coingecko.com/api/v3";

const TREASURY_VAULT_OVERVIEW_ABI = parseAbi([
  "function depositToken() view returns (address)",
  "function totalAssets() view returns (uint256)"
]);
const TREASURY_VAULT_USER_DEPOSITED_EVENT = parseAbiItem(
  "event UserDeposited(address indexed user, uint256 amountIn, uint256 sharesOut, uint256 timestamp)"
);
const LOG_SCAN_MAX_BLOCK_RANGE = 100n;
const LOG_SCAN_THROTTLE_MS = 50;

interface VaultDepositFlowCacheEntry {
  deploymentBlock: bigint;
  lastScannedBlock: bigint;
  cumulativeDepositsRaw: bigint;
}

const vaultDepositFlowCache = new Map<string, VaultDepositFlowCacheEntry>();
const vaultDepositFlowInFlight = new Map<string, Promise<bigint | null>>();

interface VaultAggregateMetrics {
  totalDepositsUsd: number | null;
  totalLiquidityUsd: number | null;
  totalVaultCount: number;
}

interface ChainConfig {
  chainId: number;
  tokens: {
    USDC: string;
    AUSD?: string;
    MON?: string;
    WMON?: string;
  };
}

interface DashboardProfileOverrides {
  remoteBotStateUrl?: string;
  remoteBotStateAuthToken?: string;
  vaultAddress?: string;
  vaultTokenAddress?: string;
  vaultTokenDecimals?: number;
  vaultTokenSymbol?: string;
}

const CHAIN_CONFIG = loadChainConfig();

export async function getDashboardData(
  profile?: DashboardProfile
): Promise<DashboardData> {
  const profileOverrides = resolveProfileOverrides(profile);
  const stateResult = await readBotState(profileOverrides);
  const state = stateResult.state;
  const hasStateData =
    Boolean(state.position) ||
    state.snapshots.length > 0 ||
    state.decisions.length > 0 ||
    state.tweets.length > 0;

  const poolMetaById = buildPoolMeta(state);
  const snapshotsByPool = groupSnapshotsByPool(state.snapshots);
  const activePoolId = state.position?.poolId ?? inferLatestPoolId(state.snapshots);
  const latestSnapshot = getLatestSnapshot(state.snapshots);
  const latestDecision = getLatestDecision(state.decisions);
  const latestTimestamp = Math.max(
    latestSnapshot?.timestamp ?? 0,
    latestDecision?.timestamp ?? 0
  );

  const isDryRun = envBool("DRY_RUN", true);
  const liveModeArmed = envBool("LIVE_MODE_ARMED", false);
  const chainId = envNumber("MONAD_CHAIN_ID", CHAIN_CONFIG.chainId);
  const vaultAddress =
    profileOverrides.vaultAddress ?? envString("VAULT_ADDRESS", ZERO_ADDRESS);
  const vaultTokenAddress =
    profileOverrides.vaultTokenAddress ??
    envString(
      "VAULT_DEPOSIT_TOKEN_ADDRESS",
      envString("USDC_TOKEN_ADDRESS", CHAIN_CONFIG.tokens.USDC)
    );
  const vaultTokenDecimals =
    profileOverrides.vaultTokenDecimals ??
    Math.max(
      0,
      Math.floor(
        envNumber(
          "VAULT_DEPOSIT_TOKEN_DECIMALS",
          envNumber("USDC_DECIMALS", DEFAULT_VAULT_TOKEN_DECIMALS)
        )
      )
    );
  const vaultTokenSymbol =
    profileOverrides.vaultTokenSymbol ?? resolveVaultTokenSymbol(vaultTokenAddress);
  const vaultAddresses = resolveVaultAddresses(vaultAddress);
  const rpcUrl = envString("MONAD_RPC_URL", DEFAULT_RPC_URL);
  const explorerTxBaseUrl = envString(
    "EXPLORER_TX_BASE_URL",
    DEFAULT_EXPLORER_TX_BASE_URL
  );
  const currentPosition = mapCurrentPosition(
    state,
    poolMetaById,
    snapshotsByPool,
    vaultTokenSymbol
  );
  const guardStatus = mapGuardStatus(state, activePoolId, latestSnapshot?.timestamp ?? null);
  const agentStatus = deriveAgentStatus(latestTimestamp);
  const apySnapshots = mapApySnapshots(state.snapshots, activePoolId);
  const { rotations, transactions } = mapDecisionHistory(
    state,
    poolMetaById,
    snapshotsByPool,
    isDryRun,
    vaultTokenSymbol
  );
  const availablePools = mapAvailablePools(poolMetaById);
  const latestDecisionRow = mapLatestDecision(latestDecision);
  const vaultTokenBalance = await readVaultTokenBalance({
    rpcUrl,
    vaultAddress,
    tokenAddress: vaultTokenAddress,
    tokenDecimals: vaultTokenDecimals
  });
  const aggregateMetrics = await readVaultAggregateMetrics({
    rpcUrl,
    vaultAddresses
  });
  const usdcTokenAddress = vaultTokenAddress;
  const usdcDecimals = vaultTokenDecimals;
  const vaultUsdcBalance = vaultTokenBalance;
  const tweets = mapTweets(state.tweets, isDryRun);
  const nextTweetPreview = buildPreviewTweet(currentPosition, guardStatus, agentStatus);

  return {
    agentStatus,
    currentPosition,
    apySnapshots,
    rotations,
    transactions,
    guardStatus,
    tweets,
    nextTweetPreview,
    updatedAt: toIsoString(latestTimestamp || nowSeconds()),
    dataSource: hasStateData ? "bot_state" : "empty",
    botStateSource: stateResult.source,
    stateWarnings: stateResult.warnings,
    isDryRun,
    liveModeArmed,
    chainId,
    vaultAddress,
    vaultTokenAddress,
    vaultTokenDecimals,
    vaultTokenSymbol,
    vaultTokenBalance,
    totalDepositsUsd: aggregateMetrics.totalDepositsUsd,
    totalLiquidityUsd: aggregateMetrics.totalLiquidityUsd,
    totalVaultCount: aggregateMetrics.totalVaultCount,
    usdcTokenAddress,
    usdcDecimals,
    vaultUsdcBalance,
    availablePools,
    latestDecision: latestDecisionRow,
    explorerTxBaseUrl
  };
}

async function readBotState(
  overrides: DashboardProfileOverrides = {}
): Promise<ReadBotStateResult> {
  const remoteUrl =
    overrides.remoteBotStateUrl?.trim() ||
    process.env.BOT_STATE_URL?.trim() ||
    process.env.BOT_STATE_JSON_URL?.trim() ||
    "";
  const remoteAuthToken =
    overrides.remoteBotStateAuthToken?.trim() ||
    process.env.BOT_STATE_AUTH_TOKEN?.trim() ||
    "";
  if (remoteUrl) {
    const warnings: string[] = [];
    try {
      const response = await fetch(remoteUrl, {
        headers: remoteAuthToken
          ? {
              "x-bot-status-token": remoteAuthToken
            }
          : undefined,
        cache: "no-store",
        next: { revalidate: 0 }
      });
      if (response.ok) {
        const parsed = (await response.json()) as unknown;
        if (isRemoteStatusEnvelope(parsed)) {
          if (parsed.healthy !== true || parsed.ready !== true) {
            throw new Error("Remote bot endpoint is not healthy/ready.");
          }
          return {
            state: toBotState(parsed.state),
            source: "remote",
            warnings
          };
        }
        return {
          state: toBotState(parsed),
          source: "remote",
          warnings
        };
      }
      warnings.push(`Remote bot state request failed (${response.status}).`);
    } catch (error) {
      warnings.push(`Remote bot state request failed: ${toErrorMessage(error)}`);
    }

    const localFallback = await readLocalBotState();
    if (localFallback) {
      warnings.push("Using local bot state fallback.");
      return {
        state: localFallback,
        source: "local",
        warnings
      };
    }

    warnings.push("No local bot state fallback available.");
    return {
      state: emptyBotState(),
      source: "empty",
      warnings
    };
  }

  const localState = await readLocalBotState();
  if (localState) {
    return {
      state: localState,
      source: "local",
      warnings: []
    };
  }

  return {
    state: emptyBotState(),
    source: "empty",
    warnings: []
  };
}

async function readLocalBotState(): Promise<BotState | null> {
  const path = process.env.BOT_STATE_PATH?.trim() || DEFAULT_STATE_PATH;
  try {
    const raw = await readFile(path, "utf8");
    return toBotState(JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}

function isRemoteStatusEnvelope(value: unknown): value is RemoteStatusEnvelope {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return "healthy" in candidate || "ready" in candidate || "runtime" in candidate;
}

function toBotState(input: unknown): BotState {
  if (!input || typeof input !== "object") {
    return {
      position: null,
      snapshots: [],
      decisions: [],
      tweets: []
    };
  }

  const parsed = input as Partial<BotState> & {
    state?: Partial<BotState>;
  };
  const source = parsed.state && typeof parsed.state === "object" ? parsed.state : parsed;

  return {
    position: sanitizePosition(source.position),
    snapshots: sanitizeSnapshots(source.snapshots),
    decisions: sanitizeDecisions(source.decisions),
    tweets: sanitizeTweets(source.tweets)
  };
}

function sanitizePosition(input: unknown): BotPosition | null {
  if (!input || typeof input !== "object") return null;
  const candidate = input as Partial<BotPosition>;

  return {
    poolId: typeof candidate.poolId === "string" ? candidate.poolId : null,
    pair: typeof candidate.pair === "string" ? candidate.pair : null,
    protocol: typeof candidate.protocol === "string" ? candidate.protocol : null,
    enteredAt: normalizeTimestamp(candidate.enteredAt),
    lpBalance: typeof candidate.lpBalance === "string" ? candidate.lpBalance : "0",
    lastNetApyBps: safeNumber(candidate.lastNetApyBps),
    parkedToken: candidate.parkedToken === "USDC" ? "USDC" : null
  };
}

function sanitizeSnapshots(input: unknown): BotSnapshot[] {
  if (!Array.isArray(input)) return [];
  const sanitized: BotSnapshot[] = [];

  for (const item of input) {
    if (!item || typeof item !== "object") continue;
    const snapshot = item as Partial<BotSnapshot>;
    if (typeof snapshot.poolId !== "string") continue;

    const timestamp = normalizeTimestamp(snapshot.timestamp);
    if (!timestamp) continue;

    sanitized.push({
      poolId: snapshot.poolId,
      pair: typeof snapshot.pair === "string" ? snapshot.pair : "USDC/MON",
      protocol: typeof snapshot.protocol === "string" ? snapshot.protocol : "Unknown",
      timestamp,
      incentiveAprBps: safeNumber(snapshot.incentiveAprBps),
      netApyBps: safeNumber(snapshot.netApyBps),
      slippageBps: safeNumber(snapshot.slippageBps),
      rewardTokenPriceUsd: safeNumber((snapshot as { rewardTokenPriceUsd?: unknown }).rewardTokenPriceUsd)
    });
  }

  return sanitized.sort((a, b) => a.timestamp - b.timestamp);
}

function sanitizeDecisions(input: unknown): BotDecision[] {
  if (!Array.isArray(input)) return [];
  const actions = new Set<DecisionAction>(["HOLD", "ENTER", "ROTATE", "EXIT_TO_USDC"]);
  const sanitized: BotDecision[] = [];

  for (const item of input) {
    if (!item || typeof item !== "object") continue;
    const decision = item as Partial<BotDecision>;
    if (typeof decision.action !== "string" || !actions.has(decision.action as DecisionAction)) {
      continue;
    }

    const timestamp = normalizeTimestamp(decision.timestamp);
    if (!timestamp) continue;

    sanitized.push({
      timestamp,
      chosenPoolId: typeof decision.chosenPoolId === "string" ? decision.chosenPoolId : null,
      reason: typeof decision.reason === "string" ? decision.reason : decision.action,
      action: decision.action as DecisionAction
    });
  }

  return sanitized.sort((a, b) => a.timestamp - b.timestamp);
}

function sanitizeTweets(input: unknown): BotTweet[] {
  if (!Array.isArray(input)) return [];
  const types = new Set<BotTweetType>(["DEPLOYED", "ROTATED", "EMERGENCY_EXIT"]);
  const sanitized: BotTweet[] = [];

  for (const item of input) {
    if (!item || typeof item !== "object") continue;
    const tweet = item as Partial<BotTweet>;
    if (typeof tweet.type !== "string" || !types.has(tweet.type as BotTweetType)) continue;

    const timestamp = normalizeTimestamp(tweet.timestamp);
    if (!timestamp) continue;

    sanitized.push({
      timestamp,
      type: tweet.type as BotTweetType,
      txHash: typeof tweet.txHash === "string" ? tweet.txHash : null,
      body: typeof tweet.body === "string" ? tweet.body : ""
    });
  }

  return sanitized.sort((a, b) => a.timestamp - b.timestamp);
}

function emptyBotState(): BotState {
  return {
    position: null,
    snapshots: [],
    decisions: [],
    tweets: []
  };
}

function mapCurrentPosition(
  state: BotState,
  poolMetaById: Map<string, { pair: string; protocol: string }>,
  snapshotsByPool: Map<string, BotSnapshot[]>,
  vaultTokenSymbol: string
): Position {
  const minHoldHours = envNumber("MIN_HOLD_HOURS", DEFAULT_MIN_HOLD_HOURS);
  const rotationDeltaPct = envNumber("ROTATION_DELTA_PCT", DEFAULT_ROTATION_DELTA_PCT);
  const maxPaybackHours = envNumber("MAX_PAYBACK_HOURS", DEFAULT_MAX_PAYBACK_HOURS);
  const now = nowSeconds();

  if (!state.position?.poolId) {
    const latest = getLatestSnapshot(state.snapshots);
    const pair = state.position?.pair ?? latest?.pair ?? `${vaultTokenSymbol}/MON`;

    return {
      id: `parked-${vaultTokenSymbol.toLowerCase()}`,
      pair,
      protocol: "Treasury",
      pool: `${vaultTokenSymbol} Parking`,
      netApy: 0,
      breakdown: {
        fees: 0,
        incentives: 0,
        costs: 0
      },
      enteredAt: toIsoString(state.position?.enteredAt ?? latest?.timestamp ?? now),
      intendedHoldHours: minHoldHours,
      switchRule: {
        minDelta: rotationDeltaPct,
        maxPaybackHours
      }
    };
  }

  const poolId = state.position.poolId;
  const poolMeta = poolMetaById.get(poolId);
  const latestPoolSnapshot = getLatestSnapshot(snapshotsByPool.get(poolId));

  const netApy = bpsToPercent(
    latestPoolSnapshot?.netApyBps ?? state.position.lastNetApyBps
  );
  const incentives = bpsToPercent(latestPoolSnapshot?.incentiveAprBps ?? 0);
  const costs = bpsToPercent(latestPoolSnapshot?.slippageBps ?? 0);
  const fees = Math.max(netApy - incentives + costs, 0);

  return {
    id: poolId,
    pair: state.position.pair ?? poolMeta?.pair ?? `${vaultTokenSymbol}/MON`,
    protocol: state.position.protocol ?? poolMeta?.protocol ?? "Unknown",
    pool: poolLabel(poolId, poolMetaById),
    netApy: round(netApy, 1),
    breakdown: {
      fees: round(fees, 1),
      incentives: round(incentives, 1),
      costs: round(costs, 1)
    },
    enteredAt: toIsoString(state.position.enteredAt ?? now),
    intendedHoldHours: minHoldHours,
    switchRule: {
      minDelta: rotationDeltaPct,
      maxPaybackHours
    }
  };
}

function mapApySnapshots(snapshots: BotSnapshot[], activePoolId: string | null): Snapshot[] {
  if (!snapshots.length) return [];
  const selectedPoolId = activePoolId ?? inferLatestPoolId(snapshots);
  if (!selectedPoolId) return [];

  const poolSnapshots = snapshots.filter((snapshot) => snapshot.poolId === selectedPoolId);
  if (!poolSnapshots.length) return [];

  const latest = poolSnapshots[poolSnapshots.length - 1];
  const sevenDaysAgo = latest.timestamp - 7 * 24 * 60 * 60;

  return poolSnapshots
    .filter((snapshot) => snapshot.timestamp >= sevenDaysAgo)
    .slice(-200)
    .map((snapshot) => ({
      timestamp: toIsoString(snapshot.timestamp),
      netApy: round(bpsToPercent(snapshot.netApyBps), 1)
    }));
}

function mapDecisionHistory(
  state: BotState,
  poolMetaById: Map<string, { pair: string; protocol: string }>,
  snapshotsByPool: Map<string, BotSnapshot[]>,
  isDryRun: boolean,
  vaultTokenSymbol: string
): { rotations: Rotation[]; transactions: AgentTransaction[] } {
  const actionToTweetType: Record<Exclude<DecisionAction, "HOLD">, BotTweetType> = {
    ENTER: "DEPLOYED",
    ROTATE: "ROTATED",
    EXIT_TO_USDC: "EMERGENCY_EXIT"
  };

  const actionableDecisions = state.decisions.filter(
    (decision) => decision.action !== "HOLD"
  ) as Array<Omit<BotDecision, "action"> & { action: Exclude<DecisionAction, "HOLD"> }>;

  const tweetPool = state.tweets.filter((tweet) => Boolean(tweet.txHash));
  const consumedTweetIndexes = new Set<number>();
  const rows: Array<{
    timestamp: string;
    action: Exclude<DecisionAction, "HOLD">;
    fromPool: string;
    toPool: string;
    oldApy: number;
    newApy: number;
    reason: string;
    txHash: string | null;
    pair: string;
  }> = [];

  let currentPoolId: string | null = null;
  for (const decision of actionableDecisions) {
    const fromPoolId = currentPoolId;
    const toPoolId = decision.action === "EXIT_TO_USDC" ? null : decision.chosenPoolId;

    const oldApy = round(resolveNetApyAt(snapshotsByPool, fromPoolId, decision.timestamp), 1);
    const newApy = round(resolveNetApyAt(snapshotsByPool, toPoolId, decision.timestamp), 1);
    const pair = inferPair(fromPoolId, toPoolId, poolMetaById, vaultTokenSymbol);
    const txHash = takeNearestTxHash(
      tweetPool,
      consumedTweetIndexes,
      actionToTweetType[decision.action],
      decision.timestamp
    );
    const safeTxHash =
      txHash && looksSyntheticTxHash(txHash) ? null : txHash;

    rows.push({
      timestamp: toIsoString(decision.timestamp),
      action: decision.action,
      fromPool: fromPoolId
        ? poolLabel(fromPoolId, poolMetaById)
        : decision.action === "ENTER"
          ? `${vaultTokenSymbol} Parking`
          : "Unknown",
      toPool: toPoolId ? poolLabel(toPoolId, poolMetaById) : `${vaultTokenSymbol} Parking`,
      oldApy,
      newApy,
      reason: decision.reason,
      txHash: isDryRun ? null : safeTxHash,
      pair
    });

    currentPoolId = toPoolId;
  }

  const sortedRows = rows.sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
  const rotations: Rotation[] = [];
  const transactions: AgentTransaction[] = [];

  for (const row of sortedRows) {
    if (row.action === "ROTATE") {
      rotations.push({
        id: `rot-${row.timestamp}-${rotations.length + 1}`,
        timestamp: row.timestamp,
        fromPool: row.fromPool,
        toPool: row.toPool,
        oldApy: row.oldApy,
        newApy: row.newApy,
        reason: row.reason,
        txHash: row.txHash,
        pair: row.pair
      });
      continue;
    }

    transactions.push({
      id: `txn-${row.timestamp}-${transactions.length + 1}`,
      timestamp: row.timestamp,
      action: row.action,
      fromPool: row.fromPool,
      toPool: row.toPool,
      reason: row.reason,
      txHash: row.txHash,
      pair: row.pair
    });
  }

  return {
    rotations,
    transactions
  };
}

function mapGuardStatus(
  state: BotState,
  activePoolId: string | null,
  latestSnapshotTs: number | null
): GuardStatus {
  const depegThreshold = envNumber("DEPEG_THRESHOLD_PCT", DEFAULT_DEPEG_THRESHOLD_PCT);
  const slippageThreshold = envNumber(
    "SLIPPAGE_THRESHOLD_PCT",
    DEFAULT_SLIPPAGE_THRESHOLD_PCT
  );
  const aprCliffThreshold = envNumber(
    "APR_CLIFF_THRESHOLD_PCT",
    DEFAULT_APR_CLIFF_THRESHOLD_PCT
  );

  const latestSnapshot = getLatestSnapshot(
    activePoolId
      ? state.snapshots.filter((snapshot) => snapshot.poolId === activePoolId)
      : state.snapshots
  );
  const hasLiveStablePrice = Boolean(
    latestSnapshot && Number.isFinite(latestSnapshot.rewardTokenPriceUsd) && latestSnapshot.rewardTokenPriceUsd > 0
  );
  const depegCurrent = hasLiveStablePrice
    ? Math.abs((latestSnapshot?.rewardTokenPriceUsd ?? 1) - 1) * 100
    : 0;
  const depegStatus = hasLiveStablePrice
    ? thresholdToLevel(depegCurrent, depegThreshold)
    : "yellow";
  const slippageCurrent = bpsToPercent(latestSnapshot?.slippageBps ?? 0);
  const aprDropCurrent = getCurrentAprDropPercent(state.snapshots, activePoolId);

  return {
    depegGuard: {
      threshold: round(depegThreshold, 2),
      status: depegStatus,
      currentValue: round(depegCurrent, 2)
    },
    slippageLimit: {
      threshold: round(slippageThreshold, 2),
      status: thresholdToLevel(slippageCurrent, slippageThreshold),
      currentValue: round(slippageCurrent, 2)
    },
    aprCliff: {
      threshold: round(aprCliffThreshold, 1),
      status: thresholdToLevel(aprDropCurrent, aprCliffThreshold),
      currentDrop: round(aprDropCurrent, 1)
    },
    lastCheckTime: toIsoString(latestSnapshotTs ?? nowSeconds())
  };
}

function mapTweets(tweets: BotTweet[], isDryRun: boolean): Tweet[] {
  return [...tweets]
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, 12)
    .map((tweet, index) => ({
      id: `tweet-${tweet.timestamp}-${index}`,
      content: sanitizeTweetBody(tweet.body, isDryRun),
      timestamp: toIsoString(tweet.timestamp),
      type: mapTweetType(tweet.type)
    }));
}

function mapAvailablePools(
  poolMetaById: Map<string, { pair: string; protocol: string }>
): PoolOption[] {
  return [...poolMetaById.entries()]
    .map(([id, meta]) => ({
      id,
      label: `${meta.protocol} ${meta.pair}`,
      pair: meta.pair,
      protocol: meta.protocol
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

function mapLatestDecision(decision: BotDecision | undefined): LatestDecision | null {
  if (!decision) return null;
  return {
    action: decision.action,
    reason: decision.reason,
    timestamp: toIsoString(decision.timestamp)
  };
}

function buildPreviewTweet(
  currentPosition: Position,
  guardStatus: GuardStatus,
  agentStatus: AgentStatus
): Tweet {
  const guardLevels = [
    guardStatus.depegGuard.status,
    guardStatus.slippageLimit.status,
    guardStatus.aprCliff.status
  ];
  const allGreen = guardLevels.every((level) => level === "green");
  const hasRed = guardLevels.some((level) => level === "red");
  const guardSummary = allGreen ? "GREEN" : hasRed ? "RED ALERT" : "YELLOW WATCH";

  const content = [
    "STATUS UPDATE: Sentryield",
    "",
    `Position: ${currentPosition.pair} (${currentPosition.pool})`,
    `Net APY: ${currentPosition.netApy.toFixed(1)}%`,
    `Guards: ${guardSummary}`,
    `Agent: ${agentStatus}`,
    "",
    "#Monad #DeFi #YieldAutomation"
  ].join("\n");

  return {
    id: "preview",
    content,
    timestamp: "",
    type: agentStatus === "ACTIVE" ? "DEPLOYED" : "ALERT"
  };
}

function deriveAgentStatus(latestTimestamp: number): AgentStatus {
  if (!latestTimestamp) return "PAUSED";
  const scanInterval = envNumber("SCAN_INTERVAL_SECONDS", DEFAULT_SCAN_INTERVAL_SECONDS);
  const stalenessSeconds = nowSeconds() - latestTimestamp;
  return stalenessSeconds <= scanInterval * 3 ? "ACTIVE" : "PAUSED";
}

function buildPoolMeta(
  state: BotState
): Map<string, { pair: string; protocol: string }> {
  const map = new Map<string, { pair: string; protocol: string }>();
  for (const snapshot of state.snapshots) {
    map.set(snapshot.poolId, {
      pair: snapshot.pair,
      protocol: snapshot.protocol
    });
  }

  if (state.position?.poolId) {
    const existing = map.get(state.position.poolId);
    map.set(state.position.poolId, {
      pair: state.position.pair ?? existing?.pair ?? "USDC/MON",
      protocol: state.position.protocol ?? existing?.protocol ?? "Unknown"
    });
  }

  return map;
}

function groupSnapshotsByPool(snapshots: BotSnapshot[]): Map<string, BotSnapshot[]> {
  const grouped = new Map<string, BotSnapshot[]>();
  for (const snapshot of snapshots) {
    const existing = grouped.get(snapshot.poolId) ?? [];
    existing.push(snapshot);
    grouped.set(snapshot.poolId, existing);
  }

  for (const [poolId, poolSnapshots] of grouped) {
    grouped.set(
      poolId,
      [...poolSnapshots].sort((a, b) => a.timestamp - b.timestamp)
    );
  }

  return grouped;
}

function inferLatestPoolId(snapshots: BotSnapshot[]): string | null {
  const latest = getLatestSnapshot(snapshots);
  return latest?.poolId ?? null;
}

function getLatestSnapshot(
  snapshots: BotSnapshot[] | undefined
): BotSnapshot | undefined {
  if (!snapshots?.length) return undefined;
  return snapshots[snapshots.length - 1];
}

function getLatestDecision(
  decisions: BotDecision[] | undefined
): BotDecision | undefined {
  if (!decisions?.length) return undefined;
  return decisions[decisions.length - 1];
}

function poolLabel(
  poolId: string,
  poolMetaById: Map<string, { pair: string; protocol: string }>
): string {
  const meta = poolMetaById.get(poolId);
  if (meta) return `${meta.protocol} ${meta.pair}`;
  return poolId
    .split(/[-_]/g)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ");
}

function inferPair(
  fromPoolId: string | null,
  toPoolId: string | null,
  poolMetaById: Map<string, { pair: string; protocol: string }>,
  vaultTokenSymbol: string
): string {
  if (toPoolId) return poolMetaById.get(toPoolId)?.pair ?? `${vaultTokenSymbol}/MON`;
  if (fromPoolId) return poolMetaById.get(fromPoolId)?.pair ?? `${vaultTokenSymbol}/MON`;
  return `${vaultTokenSymbol}/MON`;
}

function resolveNetApyAt(
  snapshotsByPool: Map<string, BotSnapshot[]>,
  poolId: string | null,
  timestamp: number
): number {
  if (!poolId) return 0;
  const snapshots = snapshotsByPool.get(poolId);
  if (!snapshots?.length) return 0;

  let candidate: BotSnapshot | null = null;
  for (const snapshot of snapshots) {
    if (snapshot.timestamp <= timestamp) {
      candidate = snapshot;
      continue;
    }
    break;
  }

  return bpsToPercent((candidate ?? snapshots[0]).netApyBps);
}

function getCurrentAprDropPercent(
  snapshots: BotSnapshot[],
  activePoolId: string | null
): number {
  if (!snapshots.length) return 0;

  const scoped = activePoolId
    ? snapshots.filter((snapshot) => snapshot.poolId === activePoolId)
    : snapshots;
  if (scoped.length < 2) return 0;

  const latest = scoped[scoped.length - 1];
  const previous = scoped[scoped.length - 2];
  if (previous.incentiveAprBps <= 0) return 0;

  const dropBps = previous.incentiveAprBps - latest.incentiveAprBps;
  if (dropBps <= 0) return 0;
  return (dropBps / previous.incentiveAprBps) * 100;
}

function thresholdToLevel(current: number, threshold: number): GuardStatusLevel {
  if (threshold <= 0) return "green";
  if (current <= threshold * 0.75) return "green";
  if (current <= threshold) return "yellow";
  return "red";
}

function takeNearestTxHash(
  tweets: BotTweet[],
  consumedTweetIndexes: Set<number>,
  expectedType: BotTweetType,
  decisionTimestamp: number
): string | null {
  let bestIndex = -1;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (let index = 0; index < tweets.length; index += 1) {
    if (consumedTweetIndexes.has(index)) continue;
    const tweet = tweets[index];
    if (tweet.type !== expectedType || !tweet.txHash) continue;

    const distance = Math.abs(tweet.timestamp - decisionTimestamp);
    if (distance <= 15 * 60 && distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  }

  if (bestIndex === -1) return null;
  consumedTweetIndexes.add(bestIndex);
  return tweets[bestIndex].txHash;
}

function mapTweetType(type: BotTweetType): Tweet["type"] {
  if (type === "EMERGENCY_EXIT") return "ALERT";
  return type;
}

function sanitizeTweetBody(body: string, isDryRun: boolean): string {
  const hasSyntheticHash = containsSyntheticTxHash(body);
  if (!isDryRun && !hasSyntheticHash) return body;
  return body.replace(
    /Tx:\s+\S+/gi,
    isDryRun ? "Tx: simulated (dry run)" : "Tx: simulated (historical dry run)"
  );
}

function containsSyntheticTxHash(body: string): boolean {
  const match = body.match(/0x[0-9a-fA-F]{64}/);
  if (!match) return false;
  return looksSyntheticTxHash(match[0]);
}

function looksSyntheticTxHash(hash: string): boolean {
  const normalized = hash.toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(normalized)) return false;
  const hex = normalized.slice(2);
  const firstNonZero = hex.search(/[1-9a-f]/);
  if (firstNonZero === -1) return true;
  // Synthetic hashes in this project are timestamp hex left-padded with zeros.
  return firstNonZero >= 48;
}

function safeNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function normalizeTimestamp(value: unknown): number | null {
  const parsed = safeNumber(value);
  if (!parsed) return null;
  return parsed > 1_000_000_000_000 ? Math.floor(parsed / 1000) : Math.floor(parsed);
}

function bpsToPercent(bps: number): number {
  return bps / 100;
}

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function envString(name: string, fallback: string): string {
  const raw = process.env[name];
  if (!raw) return fallback;
  const trimmed = raw.trim();
  return trimmed || fallback;
}

function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (!raw) return fallback;
  return raw.toLowerCase() === "true";
}

function envOptional(name: string): string | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const trimmed = raw.trim();
  return trimmed || undefined;
}

function envOptionalInteger(name: string): number | undefined {
  const raw = envOptional(name);
  if (!raw) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return undefined;
  return Math.max(0, Math.floor(parsed));
}

function resolveProfileOverrides(profile?: DashboardProfile): DashboardProfileOverrides {
  if (!profile) return {};

  const suffix = profile.toUpperCase();
  const remoteBotStateUrl =
    envOptional(`BOT_STATE_URL_${suffix}`) ??
    envOptional("BOT_STATE_URL") ??
    envOptional("BOT_STATE_JSON_URL");
  const remoteBotStateAuthToken =
    envOptional(`BOT_STATE_AUTH_TOKEN_${suffix}`) ?? envOptional("BOT_STATE_AUTH_TOKEN");

  if (profile === "usdc") {
    return {
      remoteBotStateUrl,
      remoteBotStateAuthToken,
      vaultAddress: envOptional("VAULT_ADDRESS_USDC") ?? envOptional("VAULT_ADDRESS"),
      vaultTokenAddress:
        envOptional("VAULT_DEPOSIT_TOKEN_ADDRESS_USDC") ??
        envOptional("USDC_TOKEN_ADDRESS") ??
        CHAIN_CONFIG.tokens.USDC,
      vaultTokenDecimals:
        envOptionalInteger("VAULT_DEPOSIT_TOKEN_DECIMALS_USDC") ??
        envOptionalInteger("USDC_DECIMALS") ??
        DEFAULT_VAULT_TOKEN_DECIMALS,
      vaultTokenSymbol: envOptional("VAULT_DEPOSIT_TOKEN_SYMBOL_USDC") ?? "USDC"
    };
  }

  if (profile === "ausd") {
    return {
      remoteBotStateUrl,
      remoteBotStateAuthToken,
      vaultAddress:
        envOptional("VAULT_ADDRESS_AUSD") ??
        envOptional("VAULT_AUSD_ADDRESS") ??
        envOptional("VAULT_ADDRESS"),
      vaultTokenAddress:
        envOptional("VAULT_DEPOSIT_TOKEN_ADDRESS_AUSD") ??
        envOptional("AUSD_TOKEN_ADDRESS") ??
        CHAIN_CONFIG.tokens.AUSD,
      vaultTokenDecimals:
        envOptionalInteger("VAULT_DEPOSIT_TOKEN_DECIMALS_AUSD") ??
        envOptionalInteger("AUSD_DECIMALS") ??
        6,
      vaultTokenSymbol: envOptional("VAULT_DEPOSIT_TOKEN_SYMBOL_AUSD") ?? "AUSD"
    };
  }

  return {
    remoteBotStateUrl,
    remoteBotStateAuthToken,
    vaultAddress:
      envOptional("VAULT_ADDRESS_SHMON") ??
      envOptional("VAULT_SHMON_ADDRESS") ??
      envOptional("VAULT_ADDRESS"),
    vaultTokenAddress:
      envOptional("VAULT_DEPOSIT_TOKEN_ADDRESS_SHMON") ??
      envOptional("TOKEN_SHMON_ADDRESS"),
    vaultTokenDecimals:
      envOptionalInteger("VAULT_DEPOSIT_TOKEN_DECIMALS_SHMON") ??
      envOptionalInteger("SHMON_DECIMALS") ??
      18,
    vaultTokenSymbol: envOptional("VAULT_DEPOSIT_TOKEN_SYMBOL_SHMON") ?? "shMON"
  };
}

function loadChainConfig(): ChainConfig {
  try {
    const raw = readFileSync(CHAIN_CONFIG_PATH, "utf8");
    const parsed = JSON.parse(raw) as Partial<ChainConfig>;
    return {
      chainId:
        typeof parsed.chainId === "number" && Number.isFinite(parsed.chainId)
          ? parsed.chainId
          : 143,
      tokens: {
        USDC:
          typeof parsed.tokens?.USDC === "string"
            ? parsed.tokens.USDC
            : "0x754704Bc059F8C67012fEd69BC8A327a5aafb603",
        AUSD:
          typeof parsed.tokens?.AUSD === "string"
            ? parsed.tokens.AUSD
            : "0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a",
        MON:
          typeof parsed.tokens?.MON === "string"
            ? parsed.tokens.MON
            : "0x0000000000000000000000000000000000000000",
        WMON:
          typeof parsed.tokens?.WMON === "string"
            ? parsed.tokens.WMON
            : "0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A"
      }
    };
  } catch {
    return {
      chainId: 143,
      tokens: {
        USDC: "0x754704Bc059F8C67012fEd69BC8A327a5aafb603",
        AUSD: "0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a",
        MON: "0x0000000000000000000000000000000000000000",
        WMON: "0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A"
      }
    };
  }
}

async function readVaultTokenBalance(input: {
  rpcUrl: string;
  vaultAddress: string;
  tokenAddress: string;
  tokenDecimals: number;
}): Promise<number | null> {
  if (!isAddress(input.vaultAddress) || !isAddress(input.tokenAddress)) {
    return null;
  }
  try {
    const client = createPublicClient({
      transport: http(input.rpcUrl)
    });
    const raw = await client.readContract({
      address: input.tokenAddress,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [input.vaultAddress]
    });
    const parsed = Number(formatUnits(raw, input.tokenDecimals));
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function resolveVaultAddresses(primaryVaultAddress: string): string[] {
  const configured = process.env.VAULT_ADDRESSES?.trim() || "";
  const candidates = configured
    ? configured
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean)
    : [primaryVaultAddress];
  const deduped = [...new Set(candidates)];
  return deduped.length ? deduped : [primaryVaultAddress];
}

async function readVaultAggregateMetrics(input: {
  rpcUrl: string;
  vaultAddresses: string[];
}): Promise<VaultAggregateMetrics> {
  const vaultAddresses = input.vaultAddresses.filter((address) => isAddress(address));
  if (!vaultAddresses.length) {
    return {
      totalDepositsUsd: null,
      totalLiquidityUsd: null,
      totalVaultCount: 0
    };
  }

  const client = createPublicClient({
    transport: http(input.rpcUrl)
  });

  const perVault: Array<{
    tokenSymbol: string;
    tokenDecimals: number;
    totalDepositsRaw: bigint | null;
    totalLiquidityRaw: bigint;
  }> = [];

  for (const vaultAddress of vaultAddresses) {
    try {
      const tokenAddress = (await client.readContract({
        address: vaultAddress,
        abi: TREASURY_VAULT_OVERVIEW_ABI,
        functionName: "depositToken"
      })) as string;
      if (!isAddress(tokenAddress)) continue;

      const [totalLiquidityRaw, tokenDecimalsRaw, cumulativeDepositsRaw] = await Promise.all([
        client.readContract({
          address: vaultAddress,
          abi: TREASURY_VAULT_OVERVIEW_ABI,
          functionName: "totalAssets"
        }),
        client.readContract({
          address: tokenAddress,
          abi: erc20Abi,
          functionName: "decimals"
        }),
        readVaultCumulativeDepositsRaw({
          client,
          vaultAddress
        })
      ]);

      const tokenDecimals = Number(tokenDecimalsRaw);
      perVault.push({
        tokenSymbol: resolveVaultTokenSymbol(tokenAddress),
        tokenDecimals: Number.isFinite(tokenDecimals) ? tokenDecimals : DEFAULT_VAULT_TOKEN_DECIMALS,
        totalDepositsRaw:
          typeof cumulativeDepositsRaw === "bigint" ? cumulativeDepositsRaw : null,
        totalLiquidityRaw: totalLiquidityRaw as bigint
      });
    } catch {
      continue;
    }
  }

  if (!perVault.length) {
    return {
      totalDepositsUsd: null,
      totalLiquidityUsd: null,
      totalVaultCount: 0
    };
  }

  const pricesBySymbol = await readTokenPricesUsd(
    [...new Set(perVault.map((row) => row.tokenSymbol.toUpperCase()))]
  );

  let totalDepositsUsd = 0;
  let totalLiquidityUsd = 0;
  let hasPricedVault = false;
  let hasUnknownDeposits = false;
  for (const row of perVault) {
    const price = pricesBySymbol[row.tokenSymbol.toUpperCase()];
    if (typeof price !== "number" || !Number.isFinite(price) || price <= 0) continue;
    const liquidity = Number(formatUnits(row.totalLiquidityRaw, row.tokenDecimals));
    if (Number.isFinite(liquidity)) {
      totalLiquidityUsd += liquidity * price;
      hasPricedVault = true;
    }
    if (row.totalDepositsRaw === null) {
      hasUnknownDeposits = true;
      continue;
    }
    const deposits = Number(formatUnits(row.totalDepositsRaw, row.tokenDecimals));
    if (!Number.isFinite(deposits)) continue;
    totalDepositsUsd += deposits * price;
  }

  return {
    totalDepositsUsd: hasPricedVault && !hasUnknownDeposits ? round(totalDepositsUsd, 2) : null,
    totalLiquidityUsd: hasPricedVault ? round(totalLiquidityUsd, 2) : null,
    totalVaultCount: perVault.length
  };
}

async function readVaultCumulativeDepositsRaw(input: {
  client: ReturnType<typeof createPublicClient>;
  vaultAddress: string;
}): Promise<bigint | null> {
  const vaultAddress = input.vaultAddress;
  if (!isAddress(vaultAddress)) return null;
  const key = vaultAddress.toLowerCase();
  const inflight = vaultDepositFlowInFlight.get(key);
  if (inflight) {
    return inflight;
  }

  const task = (async () => {
    const currentBlock = await input.client.getBlockNumber();
    const cached = vaultDepositFlowCache.get(key);
    if (cached && cached.lastScannedBlock >= currentBlock) {
      return cached.cumulativeDepositsRaw;
    }

    const explicitStartBlock = resolveDepositScanStartBlock(vaultAddress);
    const deploymentBlock =
      cached?.deploymentBlock ??
      explicitStartBlock ??
      (await findContractDeploymentBlock({
        client: input.client,
        vaultAddress,
        currentBlock
      }));
    const scanStartBlock = cached ? cached.lastScannedBlock + 1n : deploymentBlock;
    if (scanStartBlock > currentBlock) {
      const nextEntry: VaultDepositFlowCacheEntry = {
        deploymentBlock,
        lastScannedBlock: currentBlock,
        cumulativeDepositsRaw: cached?.cumulativeDepositsRaw ?? 0n
      };
      vaultDepositFlowCache.set(key, nextEntry);
      return nextEntry.cumulativeDepositsRaw;
    }

    let runningCumulativeDepositsRaw = cached?.cumulativeDepositsRaw ?? 0n;
    for (
      let fromBlock = scanStartBlock;
      fromBlock <= currentBlock;
      fromBlock += LOG_SCAN_MAX_BLOCK_RANGE
    ) {
      const toBlock = minBigInt(fromBlock + LOG_SCAN_MAX_BLOCK_RANGE - 1n, currentBlock);
      const deposits = await input.client.getLogs({
        address: vaultAddress,
        event: TREASURY_VAULT_USER_DEPOSITED_EVENT,
        fromBlock,
        toBlock
      });

      for (const log of deposits) {
        const amountIn = log.args.amountIn;
        if (typeof amountIn === "bigint") {
          runningCumulativeDepositsRaw += amountIn;
        }
      }

      if (toBlock < currentBlock) {
        await sleep(LOG_SCAN_THROTTLE_MS);
      }
    }

    vaultDepositFlowCache.set(key, {
      deploymentBlock,
      lastScannedBlock: currentBlock,
      cumulativeDepositsRaw: runningCumulativeDepositsRaw
    });
    return runningCumulativeDepositsRaw;
  })();

  vaultDepositFlowInFlight.set(key, task);
  try {
    return await task;
  } catch {
    const fallback = vaultDepositFlowCache.get(key);
    return fallback?.cumulativeDepositsRaw ?? null;
  } finally {
    vaultDepositFlowInFlight.delete(key);
  }
}

async function findContractDeploymentBlock(input: {
  client: ReturnType<typeof createPublicClient>;
  vaultAddress: string;
  currentBlock: bigint;
}): Promise<bigint> {
  const latestCode = await input.client.getCode({
    address: input.vaultAddress
  });
  if (!latestCode || latestCode === "0x") {
    return input.currentBlock;
  }

  let low = 0n;
  let high = input.currentBlock;
  let firstDeployed = input.currentBlock;
  while (low <= high) {
    const mid = (low + high) / 2n;
    const codeAtMid = await input.client.getCode({
      address: input.vaultAddress,
      blockNumber: mid
    });
    const hasCode = Boolean(codeAtMid && codeAtMid !== "0x");
    if (hasCode) {
      firstDeployed = mid;
      if (mid === 0n) break;
      high = mid - 1n;
    } else {
      low = mid + 1n;
    }
  }
  return firstDeployed;
}

function resolveDepositScanStartBlock(vaultAddress: string): bigint | null {
  const byAddress = process.env.VAULT_DEPOSIT_SCAN_START_BLOCKS?.trim() || "";
  if (byAddress) {
    const entries = byAddress
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
    for (const entry of entries) {
      const [addressPart, blockPart] = entry.split(":").map((value) => value.trim());
      if (!addressPart || !blockPart || !isAddress(addressPart)) continue;
      if (addressPart.toLowerCase() !== vaultAddress.toLowerCase()) continue;
      const parsed = parseNonNegativeBigInt(blockPart);
      if (parsed !== null) return parsed;
    }
  }

  const fallback = process.env.VAULT_DEPOSIT_SCAN_START_BLOCK?.trim() || "";
  if (!fallback) return null;
  return parseNonNegativeBigInt(fallback);
}

function parseNonNegativeBigInt(value: string): bigint | null {
  try {
    const parsed = BigInt(value);
    return parsed >= 0n ? parsed : null;
  } catch {
    return null;
  }
}

function minBigInt(left: bigint, right: bigint): bigint {
  return left < right ? left : right;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function readTokenPricesUsd(symbols: string[]): Promise<Record<string, number>> {
  const result: Record<string, number> = {};
  const stableSymbols = resolveStableSymbols();
  for (const symbol of symbols) {
    const normalized = symbol.trim().toUpperCase();
    if (!normalized) continue;
    if (stableSymbols.has(normalized)) {
      result[normalized] = 1;
    }
  }

  const idBySymbol = resolveCoingeckoIdBySymbol();
  const pairs = symbols
    .map((symbol) => symbol.trim().toUpperCase())
    .filter(Boolean)
    .map((symbol) => ({
      symbol,
      id: idBySymbol[symbol]
    }))
    .filter((item) => typeof item.id === "string" && item.id.length > 0) as Array<{
    symbol: string;
    id: string;
  }>;
  if (!pairs.length) return result;

  const ids = [...new Set(pairs.map((pair) => pair.id))];
  const endpoint = `${envString(
    "COINGECKO_API_BASE_URL",
    DEFAULT_COINGECKO_API_BASE_URL
  ).replace(/\/$/, "")}/simple/price?ids=${encodeURIComponent(ids.join(","))}&vs_currencies=usd`;
  const headers: Record<string, string> = {
    Accept: "application/json"
  };
  const apiKey = process.env.COINGECKO_API_KEY?.trim() || "";
  if (apiKey) {
    if (endpoint.toLowerCase().includes("pro-api.coingecko.com")) {
      headers["x-cg-pro-api-key"] = apiKey;
    } else {
      headers["x-cg-demo-api-key"] = apiKey;
    }
  }

  try {
    const response = await fetch(endpoint, {
      method: "GET",
      headers,
      cache: "no-store",
      next: { revalidate: 0 }
    });
    if (!response.ok) {
      return result;
    }
    const payload = (await response.json()) as Record<
      string,
      {
        usd?: number;
      }
    >;
    for (const { symbol, id } of pairs) {
      const price = payload[id]?.usd;
      if (typeof price === "number" && Number.isFinite(price) && price > 0) {
        result[symbol] = price;
      }
    }
  } catch {
    // Ignore network errors and fall back to any static stable prices already populated.
  }

  return result;
}

function resolveStableSymbols(): Set<string> {
  const configured = process.env.STABLE_PRICE_SYMBOLS?.trim() || "USDC,AUSD";
  const values = configured
    .split(",")
    .map((value) => value.trim().toUpperCase())
    .filter(Boolean);
  return new Set(values);
}

function resolveCoingeckoIdBySymbol(): Record<string, string> {
  const monId = envString("COINGECKO_ID_MON", "monad");
  return {
    USDC: envString("COINGECKO_ID_USDC", "usd-coin"),
    AUSD: envString("COINGECKO_ID_AUSD", ""),
    MON: monId,
    WMON: monId,
    SHMON: envString("COINGECKO_ID_SHMON", monId),
    KMON: envString("COINGECKO_ID_KMON", "")
  };
}

function resolveVaultTokenSymbol(tokenAddress: string): string {
  const explicit = process.env.VAULT_DEPOSIT_TOKEN_SYMBOL?.trim();
  if (explicit) return explicit;

  if (!isAddress(tokenAddress)) return "TOKEN";
  const normalized = tokenAddress.toLowerCase();

  const knownPairs: Array<[string | undefined, string]> = [
    [CHAIN_CONFIG.tokens.USDC, "USDC"],
    [CHAIN_CONFIG.tokens.AUSD, "AUSD"],
    [CHAIN_CONFIG.tokens.WMON, "WMON"],
    [process.env.TOKEN_SHMON, "shMON"],
    [process.env.TOKEN_SHMON_ADDRESS, "shMON"],
    [process.env.TOKEN_KMON, "kMON"],
    [process.env.TOKEN_KMON_ADDRESS, "kMON"]
  ];
  for (const [candidate, symbol] of knownPairs) {
    if (candidate && isAddress(candidate) && candidate.toLowerCase() === normalized) {
      return symbol;
    }
  }

  return "TOKEN";
}

function toIsoString(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function round(value: number, decimals = 2): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "unknown_error";
}
