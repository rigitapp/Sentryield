export type AgentStatus = "ACTIVE" | "PAUSED";
export type Pair = string;

export type GuardStatusLevel = "green" | "yellow" | "red";

export interface Position {
  id: string;
  pair: Pair;
  protocol: string;
  pool: string;
  netApy: number;
  breakdown: {
    fees: number;
    incentives: number;
    costs: number;
  };
  enteredAt: string;
  intendedHoldHours: number;
  switchRule: {
    minDelta: number;
    maxPaybackHours: number;
  };
}

export interface Snapshot {
  timestamp: string;
  netApy: number;
}

export interface Rotation {
  id: string;
  timestamp: string;
  fromPool: string;
  toPool: string;
  oldApy: number;
  newApy: number;
  reason: string;
  txHash: string | null;
  pair: Pair;
}

export interface AgentTransaction {
  id: string;
  timestamp: string;
  action: "ENTER" | "EXIT_TO_USDC";
  fromPool: string;
  toPool: string;
  reason: string;
  txHash: string | null;
  pair: Pair;
}

export interface GuardStatus {
  depegGuard: {
    threshold: number;
    status: GuardStatusLevel;
    currentValue: number;
  };
  slippageLimit: {
    threshold: number;
    status: GuardStatusLevel;
    currentValue: number;
  };
  aprCliff: {
    threshold: number;
    status: GuardStatusLevel;
    currentDrop: number;
  };
  lastCheckTime: string;
}

export interface Tweet {
  id: string;
  content: string;
  timestamp: string;
  type: "DEPLOYED" | "ROTATED" | "ALERT";
}

export interface PoolOption {
  id: string;
  label: string;
  pair: string;
  protocol: string;
}

export interface LatestDecision {
  action: "HOLD" | "ENTER" | "ROTATE" | "EXIT_TO_USDC";
  reason: string;
  timestamp: string;
}

export interface DashboardData {
  agentStatus: AgentStatus;
  currentPosition: Position;
  apySnapshots: Snapshot[];
  rotations: Rotation[];
  transactions: AgentTransaction[];
  guardStatus: GuardStatus;
  tweets: Tweet[];
  nextTweetPreview: Tweet;
  updatedAt: string;
  dataSource: "bot_state" | "empty";
  botStateSource: "remote" | "local" | "empty";
  stateWarnings: string[];
  isDryRun: boolean;
  liveModeArmed: boolean;
  chainId: number;
  vaultAddress: string;
  vaultTokenAddress: string;
  vaultTokenDecimals: number;
  vaultTokenSymbol: string;
  vaultTokenBalance: number | null;
  totalDepositsUsd: number | null;
  totalLiquidityUsd: number | null;
  totalVaultCount: number;
  usdcTokenAddress: string;
  usdcDecimals: number;
  vaultUsdcBalance: number | null;
  availablePools: PoolOption[];
  latestDecision: LatestDecision | null;
  explorerTxBaseUrl: string;
}
