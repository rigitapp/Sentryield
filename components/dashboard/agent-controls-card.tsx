"use client";

import { useEffect, useMemo, useState } from "react";
import { Pause, Play, LogOut, RefreshCw, AlertTriangle } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select";
import type { PoolOption, Position } from "@/lib/types";

interface OperatorAction {
  type: "EXIT_TO_USDC" | "ROTATE";
  requestedAt: string;
  requestedBy: string;
  poolId?: string;
}

interface OperatorState {
  paused: boolean;
  pendingAction: OperatorAction | null;
  lastAppliedAction: OperatorAction | null;
  updatedAt: string;
}

interface AgentControlsCardProps {
  availablePools: PoolOption[];
  currentPosition: Position;
  vaultTokenSymbol: string;
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}

export function AgentControlsCard({
  availablePools,
  currentPosition,
  vaultTokenSymbol
}: AgentControlsCardProps) {
  const [state, setState] = useState<OperatorState | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedPoolId, setSelectedPoolId] = useState("");

  const rotatePoolOptions = useMemo(() => {
    return availablePools.filter((pool) => pool.id !== currentPosition.id);
  }, [availablePools, currentPosition.id]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const response = await fetch("/api/agent-controls", { cache: "no-store" });
        if (!response.ok) {
          const payload = (await response.json()) as { error?: string };
          throw new Error(payload.error ?? `Failed: ${response.status}`);
        }
        const payload = (await response.json()) as OperatorState;
        if (cancelled) return;
        setState(payload);
        setError(null);
      } catch (loadError) {
        if (cancelled) return;
        setError(loadError instanceof Error ? loadError.message : "Controls unavailable.");
      }
    };
    void load();
    const timer = setInterval(() => void load(), 10_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  const sendAction = async (
    action: "pause" | "resume" | "exit" | "rotate",
    poolId?: string
  ) => {
    setIsSubmitting(true);
    setError(null);
    try {
      const response = await fetch("/api/agent-controls", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          action,
          poolId
        })
      });
      const payload = (await response.json()) as OperatorState & { error?: string };
      if (!response.ok) {
        throw new Error(payload.error ?? `Command failed: ${response.status}`);
      }
      setState(payload);
    } catch (requestError) {
      setError(
        requestError instanceof Error
          ? requestError.message
          : "Failed to send control command."
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  const pendingActionLabel = state?.pendingAction
    ? state.pendingAction.type === "ROTATE"
      ? `Rotate queued: ${state.pendingAction.poolId ?? "unknown"}`
      : `Exit to ${vaultTokenSymbol} queued`
    : "No queued manual action";

  return (
    <Card className="border-border bg-card">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center justify-between text-lg">
          <span>Manual Controls</span>
          <Badge variant="outline" className="text-xs font-normal">
            Operator override
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="rounded-lg bg-secondary/50 p-3 text-xs text-muted-foreground">
          <p>Automatic loops have no mandatory 24h hold wait.</p>
          <p className="mt-1">
            Manual actions can override automation. Vault v1 does not support direct wallet
            withdrawals; exits park funds in vault {vaultTokenSymbol}.
          </p>
        </div>

        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            className="flex-1 gap-1 bg-transparent"
            onClick={() => sendAction(state?.paused ? "resume" : "pause")}
            disabled={isSubmitting}
          >
            {state?.paused ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
            {state?.paused ? "Resume" : "Pause"}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="flex-1 gap-1 bg-transparent"
            onClick={() => sendAction("exit")}
            disabled={isSubmitting}
          >
            <LogOut className="h-3.5 w-3.5" />
            Exit to {vaultTokenSymbol}
          </Button>
        </div>

        <div className="space-y-2 rounded-lg border border-border p-3">
          <p className="text-xs text-muted-foreground">Rotate target pool</p>
          <div className="flex gap-2">
            <Select value={selectedPoolId} onValueChange={setSelectedPoolId}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Select destination pool" />
              </SelectTrigger>
              <SelectContent>
                {rotatePoolOptions.length ? (
                  rotatePoolOptions.map((pool) => (
                    <SelectItem key={pool.id} value={pool.id}>
                      {pool.label}
                    </SelectItem>
                  ))
                ) : (
                  <SelectItem value="__none" disabled>
                    No alternate pool available
                  </SelectItem>
                )}
              </SelectContent>
            </Select>
            <Button
              size="sm"
              variant="outline"
              className="gap-1 bg-transparent"
              disabled={isSubmitting || !selectedPoolId || selectedPoolId === "__none"}
              onClick={() => sendAction("rotate", selectedPoolId)}
            >
              <RefreshCw className="h-3.5 w-3.5" />
              Rotate
            </Button>
          </div>
        </div>

        <div className="rounded-lg border border-border p-3 text-xs text-muted-foreground">
          <p>{pendingActionLabel}</p>
          {state?.updatedAt ? <p className="mt-1">Updated: {formatTime(state.updatedAt)}</p> : null}
        </div>

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
