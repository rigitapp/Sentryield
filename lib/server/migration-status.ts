import "server-only";

import { createPublicClient, erc20Abi, formatUnits, http, isAddress, parseAbi } from "viem";

const DEFAULT_RPC_URL = "https://rpc.monad.xyz";
const DEFAULT_USDC_TOKEN = "0x754704Bc059F8C67012fEd69BC8A327a5aafb603";
const DEFAULT_USDC_DECIMALS = 6;
const DEFAULT_CURVANCE_CUSDC = "0x21aDBb60a5fB909e7F1fB48aACC4569615CD97b5";

const VAULT_OPEN_POSITION_ABI = parseAbi([
  "function hasOpenLpPosition() view returns (bool)"
]);

interface TokenBalanceRow {
  token: string;
  symbol: string;
  balanceRaw: string;
  balanceFormatted: string;
}

interface VaultStatus {
  address: string;
  hasOpenLpPosition: boolean | null;
  usdcBalanceRaw: string;
  usdcBalanceFormatted: string;
  lpBalances: TokenBalanceRow[];
  hasLpExposure: boolean;
}

interface BotStatusSummary {
  configured: boolean;
  reachable: boolean;
  healthy: boolean | null;
  ready: boolean | null;
  reason: string | null;
  stateUrl: string | null;
  controlBaseUrl: string | null;
}

export interface MigrationStatusPayload {
  enabled: boolean;
  oldVault: VaultStatus | null;
  newVault: VaultStatus | null;
  oldBot: BotStatusSummary;
}

interface QueueOldExitResult {
  ok: boolean;
  status: number;
  message: string;
}

function envString(name: string, fallback = ""): string {
  const raw = process.env[name];
  if (!raw) return fallback;
  const trimmed = raw.trim();
  return trimmed || fallback;
}

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeAddressList(values: string[]): string[] {
  return [...new Set(values.filter((value) => isAddress(value)).map((value) => value.toLowerCase()))];
}

function resolveOldBotStateUrl(): string | null {
  const explicit = envString("MIGRATION_OLD_BOT_STATE_URL");
  if (explicit) return explicit;
  return null;
}

function resolveOldBotControlBaseUrl(): string | null {
  const explicit = envString("MIGRATION_OLD_BOT_CONTROL_URL");
  if (explicit) return explicit.replace(/\/$/, "");

  const stateUrl = resolveOldBotStateUrl();
  if (!stateUrl) return null;
  return stateUrl.replace(/\/state\/?$/i, "");
}

function resolveStatusToken(): string {
  return (
    envString("MIGRATION_BOT_STATE_AUTH_TOKEN") ||
    envString("BOT_STATE_AUTH_TOKEN") ||
    envString("BOT_STATUS_AUTH_TOKEN")
  );
}

function collectLpTokens(): string[] {
  return normalizeAddressList([
    DEFAULT_CURVANCE_CUSDC,
    envString("CURVANCE_USDC_MARKET_8EE9_POOL_ADDRESS"),
    envString("CURVANCE_USDC_MARKET_7C9D_POOL_ADDRESS"),
    envString("MORPHO_POOL_ADDRESS"),
    envString("MORPHO_POOL_2_ADDRESS")
  ]);
}

async function readVaultStatus(input: {
  rpcUrl: string;
  vaultAddress: string;
  usdcTokenAddress: string;
  usdcDecimals: number;
  lpTokens: string[];
}): Promise<VaultStatus | null> {
  if (!isAddress(input.vaultAddress)) return null;
  if (!isAddress(input.usdcTokenAddress)) return null;

  const client = createPublicClient({
    transport: http(input.rpcUrl)
  });

  const usdcBalance = await client.readContract({
    address: input.usdcTokenAddress,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [input.vaultAddress]
  });

  let hasOpenLpPosition: boolean | null = null;
  try {
    hasOpenLpPosition = await client.readContract({
      address: input.vaultAddress,
      abi: VAULT_OPEN_POSITION_ABI,
      functionName: "hasOpenLpPosition"
    });
  } catch {
    hasOpenLpPosition = null;
  }

  const lpBalances: TokenBalanceRow[] = [];
  for (const token of input.lpTokens) {
    if (!isAddress(token)) continue;
    try {
      const [balance, symbol, decimals] = await Promise.all([
        client.readContract({
          address: token,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [input.vaultAddress]
        }),
        client.readContract({
          address: token,
          abi: erc20Abi,
          functionName: "symbol"
        }),
        client.readContract({
          address: token,
          abi: erc20Abi,
          functionName: "decimals"
        })
      ]);
      lpBalances.push({
        token,
        symbol,
        balanceRaw: balance.toString(),
        balanceFormatted: formatUnits(balance, decimals)
      });
    } catch {
      // Ignore unreadable token rows.
    }
  }

  const hasLpExposure =
    hasOpenLpPosition === true ||
    lpBalances.some((row) => {
      try {
        return BigInt(row.balanceRaw) > 0n;
      } catch {
        return false;
      }
    });

  return {
    address: input.vaultAddress,
    hasOpenLpPosition,
    usdcBalanceRaw: usdcBalance.toString(),
    usdcBalanceFormatted: formatUnits(usdcBalance, input.usdcDecimals),
    lpBalances,
    hasLpExposure
  };
}

async function readOldBotStatus(): Promise<BotStatusSummary> {
  const stateUrl = resolveOldBotStateUrl();
  const controlBaseUrl = resolveOldBotControlBaseUrl();
  if (!stateUrl) {
    return {
      configured: false,
      reachable: false,
      healthy: null,
      ready: null,
      reason: "MIGRATION_OLD_BOT_STATE_URL not configured.",
      stateUrl: null,
      controlBaseUrl
    };
  }

  const token = resolveStatusToken();
  try {
    const response = await fetch(stateUrl, {
      headers: token
        ? {
            "x-bot-status-token": token
          }
        : undefined,
      cache: "no-store",
      next: { revalidate: 0 }
    });

    if (!response.ok) {
      return {
        configured: true,
        reachable: false,
        healthy: null,
        ready: null,
        reason: `State endpoint returned HTTP ${response.status}.`,
        stateUrl,
        controlBaseUrl
      };
    }

    const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    const healthy = typeof payload.healthy === "boolean" ? payload.healthy : null;
    const ready = typeof payload.ready === "boolean" ? payload.ready : null;
    const reason = typeof payload.reason === "string" ? payload.reason : null;

    return {
      configured: true,
      reachable: true,
      healthy,
      ready,
      reason,
      stateUrl,
      controlBaseUrl
    };
  } catch {
    return {
      configured: true,
      reachable: false,
      healthy: null,
      ready: null,
      reason: "Failed to reach old bot state endpoint.",
      stateUrl,
      controlBaseUrl
    };
  }
}

export async function getMigrationStatus(): Promise<MigrationStatusPayload> {
  const rpcUrl = envString("MONAD_RPC_URL", DEFAULT_RPC_URL);
  const usdcTokenAddress = envString("USDC_TOKEN_ADDRESS", DEFAULT_USDC_TOKEN);
  const usdcDecimals = Math.max(0, Math.floor(envNumber("USDC_DECIMALS", DEFAULT_USDC_DECIMALS)));
  const oldVaultAddress = envString("MIGRATION_OLD_VAULT_ADDRESS");
  const newVaultAddress = envString("VAULT_ADDRESS");
  const lpTokens = collectLpTokens();

  const [oldVault, newVault, oldBot] = await Promise.all([
    oldVaultAddress
      ? readVaultStatus({
          rpcUrl,
          vaultAddress: oldVaultAddress,
          usdcTokenAddress,
          usdcDecimals,
          lpTokens
        })
      : Promise.resolve(null),
    newVaultAddress
      ? readVaultStatus({
          rpcUrl,
          vaultAddress: newVaultAddress,
          usdcTokenAddress,
          usdcDecimals,
          lpTokens
        })
      : Promise.resolve(null),
    readOldBotStatus()
  ]);

  return {
    enabled: Boolean(oldVaultAddress),
    oldVault,
    newVault,
    oldBot
  };
}

export async function queueOldVaultExit(): Promise<QueueOldExitResult> {
  const controlBase = resolveOldBotControlBaseUrl();
  if (!controlBase) {
    return {
      ok: false,
      status: 400,
      message: "MIGRATION_OLD_BOT_CONTROL_URL/MIGRATION_OLD_BOT_STATE_URL not configured."
    };
  }

  const token = resolveStatusToken();
  try {
    const response = await fetch(`${controlBase}/controls/exit`, {
      method: "POST",
      headers: token
        ? {
            "x-bot-status-token": token
          }
        : undefined,
      cache: "no-store"
    });
    const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    const message =
      typeof payload.error === "string"
        ? payload.error
        : response.ok
          ? "Old vault exit queued."
          : `Old bot returned HTTP ${response.status}.`;
    return {
      ok: response.ok,
      status: response.status,
      message
    };
  } catch {
    return {
      ok: false,
      status: 502,
      message: "Failed to reach old bot controls endpoint."
    };
  }
}
