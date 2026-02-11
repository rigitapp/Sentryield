"use client";

import { Pause, LogOut, RefreshCw, Clock, ArrowRightLeft } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import type { Position } from "@/lib/types";

interface CurrentPositionCardProps {
  position: Position;
}

export function CurrentPositionCard({ position }: CurrentPositionCardProps) {
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
        <CardTitle className="flex items-center justify-between text-lg">
          <span>Current Position</span>
          <Badge variant="outline" className="text-xs font-normal">
            {position.pair}
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-1">
          <p className="text-sm text-muted-foreground">Protocol / Pool</p>
          <p className="font-medium text-foreground">
            {position.protocol} / {position.pool}
          </p>
        </div>

        <div className="space-y-1">
          <p className="text-sm text-muted-foreground">Net APY</p>
          <p className="text-3xl font-bold text-primary">
            {position.netApy.toFixed(1)}%
          </p>
        </div>

        <div className="space-y-2 rounded-lg bg-secondary/50 p-3">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
            Breakdown
          </p>
          <div className="space-y-1.5 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Fees</span>
              <span className="text-success">+{position.breakdown.fees}%</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Incentives</span>
              <span className="text-success">
                +{position.breakdown.incentives}%
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Costs</span>
              <span className="text-destructive">
                -{position.breakdown.costs}%
              </span>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1">
            <p className="flex items-center gap-1 text-xs text-muted-foreground">
              <Clock className="h-3 w-3" /> Entered at
            </p>
            <p className="text-sm font-medium text-foreground">
              {formatDate(position.enteredAt)}
            </p>
          </div>
          <div className="space-y-1">
            <p className="flex items-center gap-1 text-xs text-muted-foreground">
              <Clock className="h-3 w-3" /> Intended hold
            </p>
            <p className="text-sm font-medium text-foreground">
              Min {position.intendedHoldHours}h
            </p>
          </div>
        </div>

        <div className="space-y-2 rounded-lg border border-border p-3">
          <p className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
            <ArrowRightLeft className="h-3 w-3" /> Switch Rules
          </p>
          <p className="text-sm text-foreground">
            Δ ≥ {position.switchRule.minDelta}%, payback ≤{" "}
            {position.switchRule.maxPaybackHours}h
          </p>
        </div>

        <div className="flex gap-2 pt-2">
          <Button
            variant="outline"
            size="sm"
            className="flex-1 gap-1 bg-transparent"
            disabled
          >
            <Pause className="h-3.5 w-3.5" />
            Pause
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="flex-1 gap-1 bg-transparent"
            disabled
          >
            <LogOut className="h-3.5 w-3.5" />
            Exit
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="flex-1 gap-1 bg-transparent"
            disabled
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Rotate
          </Button>
        </div>
        <p className="text-center text-xs text-muted-foreground">
          Controls disabled in v1 (read-only)
        </p>
      </CardContent>
    </Card>
  );
}
