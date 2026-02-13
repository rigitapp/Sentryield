"use client";

import { useEffect, useMemo, useState } from "react";
import { ArrowRightLeft, AlertTriangle, RefreshCw } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

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

interface MigrationStatusPayload {
  enabled: boolean;
  oldVault: VaultStatus | null;
  newVault: VaultStatus | null;
  oldBot: BotStatusSummary;
}

export function MigrationHelperCard() {
  const [status, setStatus] = useState<MigrationStatusPayload | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        setIsLoading(true);
        const response = await fetch("/api/migration-status", {
          cache: "no-store"
        });
        if (!response.ok) {
          throw new Error(`Migration status failed: ${response.status}`);
        }
        const payload = (await response.json()) as MigrationStatusPayload;
        if (cancelled) return;
        setStatus(payload);
        setError(null);
      } catch {
        if (cancelled) return;
        setError("Migration status is unavailable right now.");
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    };

    void load();
    const timer = setInterval(() => void load(), 15_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  const queueOldExit = async () => {
    setIsSubmitting(true);
    setActionMessage(null);
    setError(null);
    try {
      const response = await fetch("/api/migration-status", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          action: "queue_old_exit"
        })
      });
      const payload = (await response.json()) as {
        result?: {
          ok?: boolean;
          message?: string;
        };
        status?: MigrationStatusPayload;
        error?: string;
      };
      if (!response.ok) {
        throw new Error(payload.error || payload.result?.message || "Failed to queue old vault exit.");
      }
      if (payload.status) {
        setStatus(payload.status);
      }
      setActionMessage(payload.result?.message ?? "Old vault exit queued.");
    } catch (requestError) {
      setError(
        requestError instanceof Error
          ? requestError.message
          : "Failed to queue old vault exit."
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  const oldVaultLpRows = useMemo(() => {
    return status?.oldVault?.lpBalances?.filter((row) => {
      try {
        return BigInt(row.balanceRaw) > 0n;
      } catch {
        return false;
      }
    }) ?? [];
  }, [status?.oldVault?.lpBalances]);

  if (!status?.enabled) {
    return (
      <Card className="border-border bg-card">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-lg">
            <ArrowRightLeft className="h-5 w-5 text-primary" />
            Vault Migration Helper
          </CardTitle>
        </CardHeader>
        <CardContent className="text-xs text-muted-foreground">
          Set `MIGRATION_OLD_VAULT_ADDRESS` and old bot state/control env vars to enable guided
          old-to-new vault migration actions.
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="border-border bg-card">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center justify-between text-lg">
          <span className="flex items-center gap-2">
            <ArrowRightLeft className="h-5 w-5 text-primary" />
            Vault Migration Helper
          </span>
          <Badge variant="outline" className="text-xs font-normal">
            Old {"->"} New
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-1 rounded-md border border-border p-2 text-xs text-muted-foreground">
          <p className="break-all">Old vault: {status.oldVault?.address ?? "n/a"}</p>
          <p>USDC: {status.oldVault?.usdcBalanceFormatted ?? "0"}</p>
          <p>
            LP exposure: {status.oldVault?.hasLpExposure ? "active" : "none"}
            {status.oldVault?.hasOpenLpPosition === true ? " (open)" : ""}
          </p>
          {oldVaultLpRows.length ? (
            <p>
              Active LP balances:{" "}
              {oldVaultLpRows.map((row) => `${row.symbol} ${row.balanceFormatted}`).join(" | ")}
            </p>
          ) : null}
        </div>

        <div className="space-y-1 rounded-md border border-border p-2 text-xs text-muted-foreground">
          <p className="break-all">New vault: {status.newVault?.address ?? "n/a"}</p>
          <p>USDC: {status.newVault?.usdcBalanceFormatted ?? "0"}</p>
          <p>
            LP exposure: {status.newVault?.hasLpExposure ? "active" : "none"}
            {status.newVault?.hasOpenLpPosition === true ? " (open)" : ""}
          </p>
        </div>

        <div className="rounded-md bg-secondary/50 p-2 text-xs text-muted-foreground">
          <p>
            Old bot status:{" "}
            {status.oldBot.configured
              ? status.oldBot.reachable
                ? `${status.oldBot.healthy ? "healthy" : "unhealthy"}, ${
                    status.oldBot.ready ? "ready" : "not ready"
                  }`
                : "unreachable"
              : "not configured"}
          </p>
          {status.oldBot.reason ? <p className="mt-1">{status.oldBot.reason}</p> : null}
        </div>

        <Button
          variant="outline"
          className="w-full gap-2 bg-transparent"
          onClick={queueOldExit}
          disabled={
            isSubmitting ||
            !status.oldBot.controlBaseUrl ||
            !status.oldBot.configured
          }
        >
          <RefreshCw className={`h-4 w-4 ${isSubmitting ? "animate-spin" : ""}`} />
          Queue Old Vault Exit
        </Button>

        {isLoading ? <p className="text-xs text-muted-foreground">Refreshing migration status...</p> : null}
        {actionMessage ? <p className="text-xs text-success">{actionMessage}</p> : null}
        {error ? (
          <p className="flex items-center gap-1 text-xs text-warning">
            <AlertTriangle className="h-3.5 w-3.5" />
            {error}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
