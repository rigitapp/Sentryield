import type {
  Position,
  Snapshot,
  Rotation,
  GuardStatus,
  Tweet,
  AgentStatus,
} from "./types";

export const agentStatus: AgentStatus = "ACTIVE";

export const currentPosition: Position = {
  id: "pos-001",
  pair: "AUSD/MON",
  protocol: "Kuru DEX",
  pool: "AUSD/MON Concentrated",
  netApy: 24.7,
  breakdown: {
    fees: 18.2,
    incentives: 8.5,
    costs: 2.0,
  },
  enteredAt: "2026-02-01T14:30:00Z",
  intendedHoldHours: 24,
  switchRule: {
    minDelta: 2.0,
    maxPaybackHours: 72,
  },
};

export const apySnapshots: Snapshot[] = [
  { timestamp: "2026-01-27T00:00:00Z", netApy: 21.3 },
  { timestamp: "2026-01-27T12:00:00Z", netApy: 22.1 },
  { timestamp: "2026-01-28T00:00:00Z", netApy: 23.5 },
  { timestamp: "2026-01-28T12:00:00Z", netApy: 22.8 },
  { timestamp: "2026-01-29T00:00:00Z", netApy: 24.2 },
  { timestamp: "2026-01-29T12:00:00Z", netApy: 25.1 },
  { timestamp: "2026-01-30T00:00:00Z", netApy: 24.8 },
  { timestamp: "2026-01-30T12:00:00Z", netApy: 23.9 },
  { timestamp: "2026-01-31T00:00:00Z", netApy: 25.6 },
  { timestamp: "2026-01-31T12:00:00Z", netApy: 26.2 },
  { timestamp: "2026-02-01T00:00:00Z", netApy: 25.1 },
  { timestamp: "2026-02-01T12:00:00Z", netApy: 24.3 },
  { timestamp: "2026-02-02T00:00:00Z", netApy: 24.7 },
];

export const rotations: Rotation[] = [
  {
    id: "rot-001",
    timestamp: "2026-02-01T14:30:00Z",
    fromPool: "USDC/MON Wide",
    toPool: "AUSD/MON Concentrated",
    oldApy: 19.2,
    newApy: 24.7,
    reason: "Higher incentives",
    txHash: "0x1a2b3c4d5e6f7890abcdef1234567890abcdef12",
    pair: "AUSD/MON",
  },
  {
    id: "rot-002",
    timestamp: "2026-01-30T08:15:00Z",
    fromPool: "AUSD/MON Concentrated",
    toPool: "USDC/MON Wide",
    oldApy: 22.1,
    newApy: 19.2,
    reason: "Depeg risk detected",
    txHash: "0x2b3c4d5e6f7890abcdef1234567890abcdef1234",
    pair: "USDC/MON",
  },
  {
    id: "rot-003",
    timestamp: "2026-01-28T16:45:00Z",
    fromPool: "USDC/MON Narrow",
    toPool: "AUSD/MON Concentrated",
    oldApy: 18.5,
    newApy: 22.1,
    reason: "APY improvement ≥2%",
    txHash: "0x3c4d5e6f7890abcdef1234567890abcdef123456",
    pair: "AUSD/MON",
  },
  {
    id: "rot-004",
    timestamp: "2026-01-26T11:20:00Z",
    fromPool: "AUSD/MON Wide",
    toPool: "USDC/MON Narrow",
    oldApy: 15.8,
    newApy: 18.5,
    reason: "Higher fee tier",
    txHash: "0x4d5e6f7890abcdef1234567890abcdef12345678",
    pair: "USDC/MON",
  },
  {
    id: "rot-005",
    timestamp: "2026-01-24T09:00:00Z",
    fromPool: "Initial Deployment",
    toPool: "AUSD/MON Wide",
    oldApy: 0,
    newApy: 15.8,
    reason: "Initial deployment",
    txHash: "0x5e6f7890abcdef1234567890abcdef1234567890",
    pair: "AUSD/MON",
  },
];

export const guardStatus: GuardStatus = {
  depegGuard: {
    threshold: 1.0,
    status: "green",
    currentValue: 0.12,
  },
  slippageLimit: {
    threshold: 0.3,
    status: "green",
    currentValue: 0.08,
  },
  aprCliff: {
    threshold: 50,
    status: "green",
    currentDrop: 2.1,
  },
  lastCheckTime: "2026-02-02T10:45:00Z",
};

export const tweets: Tweet[] = [
  {
    id: "tweet-001",
    content:
      "🔄 ROTATED: Moved from USDC/MON Wide → AUSD/MON Concentrated\n\n📈 APY: 19.2% → 24.7% (+5.5%)\n💡 Reason: Higher incentives detected\n\n#Monad #DeFi #YieldOptimization",
    timestamp: "2026-02-01T14:32:00Z",
    type: "ROTATED",
  },
  {
    id: "tweet-002",
    content:
      "⚠️ ALERT: Depeg risk detected on AUSD pair\n\n🛡️ Moved to safer USDC/MON Wide position\n📊 Accepted lower APY (22.1% → 19.2%) for reduced risk\n\n#Monad #RiskManagement",
    timestamp: "2026-01-30T08:17:00Z",
    type: "ALERT",
  },
  {
    id: "tweet-003",
    content:
      "🔄 ROTATED: Moved from USDC/MON Narrow → AUSD/MON Concentrated\n\n📈 APY: 18.5% → 22.1% (+3.6%)\n💡 Reason: APY improvement ≥2%\n\n#Monad #DeFi #AutomatedYield",
    timestamp: "2026-01-28T16:47:00Z",
    type: "ROTATED",
  },
];

export const nextTweetPreview: Tweet = {
  id: "preview",
  content:
    "🤖 STATUS UPDATE: Sentryield\n\n📍 Current Position: AUSD/MON Concentrated\n📈 Net APY: 24.7%\n⏱️ Holding for: 12h 15m\n\n🛡️ All guards: ✅ GREEN\n\n#Monad #DeFi #AI",
  timestamp: "",
  type: "DEPLOYED",
};
