export type Address = `0x${string}`;
export type Hex = `0x${string}`;

export type Pair = "AUSD/MON" | "USDC/MON" | "WMON/MON" | "shMON/MON" | "kMON/MON";
export type PoolTier = "S" | "R";
export type DecisionAction = "HOLD" | "ENTER" | "ROTATE" | "EXIT_TO_USDC";
export type TweetType = "DEPLOYED" | "ROTATED" | "EMERGENCY_EXIT";

export enum DecisionReasonCode {
  INITIAL_DEPLOY = 1,
  APY_UPGRADE = 2,
  DEPEG_EXIT = 3,
  APR_CLIFF_EXIT = 4,
  MIN_HOLD_ACTIVE = 5,
  DELTA_BELOW_THRESHOLD = 6,
  PAYBACK_TOO_LONG = 7,
  SLIPPAGE_TOO_HIGH = 8,
  NO_ELIGIBLE_POOL = 9
}

export interface PoolMockInputs {
  tvlUsd: number;
  rewardRatePerSecond: number;
  priceImpactBps: number;
  rotationCostBps: number;
  protocolFeeBps: number;
}

export interface PoolConfig {
  id: string;
  protocol: string;
  pair: Pair;
  tier: PoolTier;
  enabled: boolean;
  adapterId: string;
  target: Address;
  pool: Address;
  lpToken: Address;
  tokenIn: Address;
  rewardTokenSymbol: string;
  baseApyBps: number;
  mock: PoolMockInputs;
}

export interface TokenConfig {
  USDC: Address;
  MON: Address;
  WMON: Address;
}

export interface PolicyConfig {
  minHoldSeconds: number;
  rotationDeltaApyBps: number;
  maxPaybackHours: number;
  depegThresholdBps: number;
  maxPriceImpactBps: number;
  aprCliffDropBps: number;
  txDeadlineSeconds: number;
}

export interface RuntimeConfig {
  rpcUrl: string;
  chainId: number;
  vaultAddress: Address;
  executorPrivateKey?: Hex;
  explorerTxBaseUrl: string;
  dryRun: boolean;
  scanIntervalSeconds: number;
  defaultTradeAmountRaw: bigint;
  enterOnlyMode: boolean;
  maxRotationsPerDay: number;
  cooldownSeconds: number;
}

export interface PoolOnChainState {
  tvlUsd: number;
  rewardRatePerSecond: number;
  rewardTokenSymbol: string;
  baseApyBps: number;
  protocolFeeBps: number;
}

export interface PoolSnapshot {
  poolId: string;
  pair: Pair;
  protocol: string;
  timestamp: number;
  tvlUsd: number;
  incentiveAprBps: number;
  netApyBps: number;
  slippageBps: number;
  rewardRatePerSecond: number;
  rewardTokenPriceUsd: number;
}

export interface Position {
  poolId: string | null;
  pair: Pair | null;
  protocol: string | null;
  enteredAt: number | null;
  lpBalance: string;
  lastNetApyBps: number;
  parkedToken: "USDC" | null;
}

export interface Decision {
  timestamp: number;
  action: DecisionAction;
  reason: string;
  reasonCode: DecisionReasonCode;
  chosenPoolId: string | null;
  fromPoolId: string | null;
  emergency: boolean;
  oldNetApyBps: number;
  newNetApyBps: number;
  estimatedPaybackHours: number | null;
}

export interface GuardResult {
  triggered: boolean;
  reason: string;
  details?: string;
}

export interface VaultEnterRequest {
  target: Address;
  pool: Address;
  tokenIn: Address;
  lpToken: Address;
  amountIn: bigint;
  minOut: bigint;
  deadline: bigint;
  data: Hex;
  pair: string;
  protocol: string;
  netApyBps: number;
  intendedHoldSeconds: number;
}

export interface VaultExitRequest {
  target: Address;
  pool: Address;
  lpToken: Address;
  tokenOut: Address;
  amountIn: bigint;
  minOut: bigint;
  deadline: bigint;
  data: Hex;
  pair: string;
  protocol: string;
}

export interface VaultRotateRequest {
  exitRequest: VaultExitRequest;
  enterRequest: VaultEnterRequest;
  oldNetApyBps: number;
  newNetApyBps: number;
  reasonCode: number;
}

export interface ExecutionError {
  code: "SIMULATION_FAILED" | "SEND_FAILED" | "CONFIG_ERROR" | "POLICY_BLOCKED";
  message: string;
  details?: string;
}

export interface ExecutionResult {
  action: DecisionAction;
  txHashes: Hex[];
  updatedPosition: Position | null;
  error?: ExecutionError;
}

export interface StoredDecision {
  timestamp: number;
  chosenPoolId: string | null;
  reason: string;
  action: DecisionAction;
  reasonCode: DecisionReasonCode;
}

export interface TweetRecord {
  timestamp: number;
  type: TweetType;
  txHash: Hex | null;
  body: string;
}

export interface DbState {
  position: Position | null;
  snapshots: PoolSnapshot[];
  decisions: StoredDecision[];
  tweets: TweetRecord[];
}
