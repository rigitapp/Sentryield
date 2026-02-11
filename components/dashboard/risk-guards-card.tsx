"use client";

import { Shield, Clock } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { GuardStatus, GuardStatusLevel } from "@/lib/types";

interface RiskGuardsCardProps {
  guardStatus: GuardStatus;
}

function StatusIndicator({ status }: { status: GuardStatusLevel }) {
  const colors = {
    green: "bg-success",
    yellow: "bg-warning",
    red: "bg-destructive",
  };

  return (
    <div className="flex items-center gap-2">
      <span
        className={`h-2.5 w-2.5 rounded-full ${colors[status]} animate-pulse`}
      />
      <span className="text-xs uppercase text-muted-foreground">{status}</span>
    </div>
  );
}

export function RiskGuardsCard({ guardStatus }: RiskGuardsCardProps) {
  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  return (
    <Card className="border-border bg-card">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-lg">
          <Shield className="h-5 w-5 text-primary" />
          Risk Guards
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-3">
          <div className="flex items-center justify-between rounded-lg bg-secondary/50 p-3">
            <div>
              <p className="text-sm font-medium text-foreground">Depeg Guard</p>
              <p className="text-xs text-muted-foreground">
                Threshold: ±{guardStatus.depegGuard.threshold}%
              </p>
              <p className="text-xs text-muted-foreground">
                Current: ±{guardStatus.depegGuard.currentValue.toFixed(2)}%
              </p>
            </div>
            <StatusIndicator status={guardStatus.depegGuard.status} />
          </div>

          <div className="flex items-center justify-between rounded-lg bg-secondary/50 p-3">
            <div>
              <p className="text-sm font-medium text-foreground">
                Slippage Limit
              </p>
              <p className="text-xs text-muted-foreground">
                Threshold: {guardStatus.slippageLimit.threshold}%
              </p>
              <p className="text-xs text-muted-foreground">
                Current: {guardStatus.slippageLimit.currentValue.toFixed(2)}%
              </p>
            </div>
            <StatusIndicator status={guardStatus.slippageLimit.status} />
          </div>

          <div className="flex items-center justify-between rounded-lg bg-secondary/50 p-3">
            <div>
              <p className="text-sm font-medium text-foreground">APR Cliff</p>
              <p className="text-xs text-muted-foreground">
                Threshold: {guardStatus.aprCliff.threshold}% drop
              </p>
              <p className="text-xs text-muted-foreground">
                Current drop: {guardStatus.aprCliff.currentDrop.toFixed(1)}%
              </p>
            </div>
            <StatusIndicator status={guardStatus.aprCliff.status} />
          </div>
        </div>

        <div className="flex items-center gap-2 border-t border-border pt-3">
          <Clock className="h-4 w-4 text-muted-foreground" />
          <p className="text-xs text-muted-foreground">
            Last check: {formatDate(guardStatus.lastCheckTime)}
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
