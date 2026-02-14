"use client";

import { Info } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export function AgentHowItWorksCard() {
  return (
    <Card className="border-border bg-card">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-lg">
          <Info className="h-5 w-5 text-primary" />
          How The Agent Works
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-sm text-muted-foreground">
        <p>
          1) Funds are deposited as USDC into the vault. The bot evaluates enabled pools and their
          net APY, slippage, and risk guards each cycle.
        </p>
        <p>
          2) On enter/rotate decisions, the vault calls a target adapter (Curvance in v1) to move
          capital into the selected pool.
        </p>
        <p>
          3) Automatic loops do not enforce a 24h hold wait. Manual operator actions can pause,
          exit to USDC parking, or rotate to another pool. On anytime-liquidity vault versions,
          user wallet withdrawals can execute even while LP is active (the vault unwinds as
          needed).
        </p>
        <p>
          4) Yield comes from pool APY + incentives minus fees/costs. The dashboard reflects live
          decisions, rotations, and guard checks in near real time.
        </p>
      </CardContent>
    </Card>
  );
}
