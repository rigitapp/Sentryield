"use client";

import { Activity, Wallet, Bot, Clock3 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { LatestDecision } from "@/lib/types";

interface AgentActivityCardProps {
  totalDepositsUsd: number | null;
  totalLiquidityUsd: number | null;
  totalVaultCount: number;
  latestDecision: LatestDecision | null;
}

function formatTimestamp(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}

export function AgentActivityCard({
  totalDepositsUsd,
  totalLiquidityUsd,
  totalVaultCount,
  latestDecision
}: AgentActivityCardProps) {
  const formatUsd = (value: number | null): string => {
    if (value === null || !Number.isFinite(value)) return "Unavailable";
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 2
    }).format(value);
  };

  return (
    <Card className="border-border bg-card">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-lg">
          <Activity className="h-5 w-5 text-primary" />
          Agent Activity
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-2 md:grid-cols-2">
          <div className="rounded-lg bg-secondary/50 p-3">
            <p className="mb-1 flex items-center gap-1 text-xs text-muted-foreground">
              <Wallet className="h-3.5 w-3.5" />
              Total deposits ({totalVaultCount} vaults)
            </p>
            <p className="text-lg font-semibold text-foreground">{formatUsd(totalDepositsUsd)}</p>
          </div>
          <div className="rounded-lg bg-secondary/50 p-3">
            <p className="mb-1 flex items-center gap-1 text-xs text-muted-foreground">
              <Wallet className="h-3.5 w-3.5" />
              Liquidity / TVL ({totalVaultCount} vaults)
            </p>
            <p className="text-lg font-semibold text-foreground">{formatUsd(totalLiquidityUsd)}</p>
          </div>
        </div>

        <div className="rounded-lg border border-border p-3">
          <p className="mb-1 flex items-center gap-1 text-xs text-muted-foreground">
            <Bot className="h-3.5 w-3.5" />
            Latest agent decision
          </p>
          {latestDecision ? (
            <>
              <p className="text-sm font-medium text-foreground">{latestDecision.action}</p>
              <p className="mt-1 text-xs text-muted-foreground">{latestDecision.reason}</p>
              <p className="mt-2 flex items-center gap-1 text-xs text-muted-foreground">
                <Clock3 className="h-3.5 w-3.5" />
                {formatTimestamp(latestDecision.timestamp)}
              </p>
            </>
          ) : (
            <p className="text-xs text-muted-foreground">No decision yet.</p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
