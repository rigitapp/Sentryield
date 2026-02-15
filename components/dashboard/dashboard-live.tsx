"use client";

import { useEffect, useMemo, useState } from "react";
import { Header } from "@/components/dashboard/header";
import { CurrentPositionCard } from "@/components/dashboard/current-position-card";
import { AgentActivityCard } from "@/components/dashboard/agent-activity-card";
import { DepositUsdcCard } from "@/components/dashboard/deposit-usdc-card";
import { AgentControlsCard } from "@/components/dashboard/agent-controls-card";
import { AgentHowItWorksCard } from "@/components/dashboard/agent-how-it-works-card";
import { RiskGuardsCard } from "@/components/dashboard/risk-guards-card";
import { ApyChart } from "@/components/dashboard/apy-chart";
import { RotationsTable } from "@/components/dashboard/rotations-table";
import { TweetFeed } from "@/components/dashboard/tweet-feed";
import type { DashboardData } from "@/lib/types";

interface DashboardLiveProps {
  initialData: DashboardData;
  refreshIntervalMs?: number;
}

const DEFAULT_REFRESH_INTERVAL_MS = 10_000;

function formatTimestamp(isoString: string): string {
  return new Date(isoString).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}

export function DashboardLive({
  initialData,
  refreshIntervalMs = DEFAULT_REFRESH_INTERVAL_MS
}: DashboardLiveProps) {
  const [data, setData] = useState<DashboardData>(initialData);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const refresh = async () => {
      try {
        setIsRefreshing(true);
        const response = await fetch("/api/dashboard", { cache: "no-store" });
        if (!response.ok) {
          throw new Error(`Dashboard refresh failed: ${response.status}`);
        }

        const payload = (await response.json()) as DashboardData;
        if (cancelled) return;
        setData(payload);
        setRefreshError(null);
      } catch {
        if (cancelled) return;
        setRefreshError("Live refresh is temporarily unavailable.");
      } finally {
        if (!cancelled) {
          setIsRefreshing(false);
        }
      }
    };

    void refresh();

    if (refreshIntervalMs <= 0) {
      return () => {
        cancelled = true;
      };
    }

    const timer = setInterval(() => {
      void refresh();
    }, refreshIntervalMs);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [refreshIntervalMs]);

  const lastSyncLabel = useMemo(() => {
    return formatTimestamp(data.updatedAt);
  }, [data.updatedAt]);

  return (
    <div className="min-h-screen bg-background">
      <Header status={data.agentStatus} />

      <main className="container mx-auto p-4 lg:p-6">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-muted-foreground">
            Source: {data.dataSource === "bot_state" ? "bot state" : "empty state"}
          </p>
          <p className="text-xs text-muted-foreground">
            {isRefreshing ? "Refreshing..." : `Last sync: ${lastSyncLabel}`}
          </p>
        </div>
        {data.isDryRun ? (
          <p className="mb-4 text-xs text-warning">
            DRY RUN is enabled. Transactions are simulated and will not exist on-chain.
          </p>
        ) : !data.liveModeArmed ? (
          <p className="mb-4 text-xs text-warning">
            Live mode is disarmed. Simulations run, but transaction broadcasts are blocked
            until LIVE_MODE_ARMED=true.
          </p>
        ) : (
          <p className="mb-4 text-xs text-muted-foreground">
            Live mode. Tx links use {data.explorerTxBaseUrl}.
          </p>
        )}
        {refreshError ? (
          <p className="mb-4 text-xs text-warning">{refreshError}</p>
        ) : null}

        <div className="grid gap-6 lg:grid-cols-12">
          <div className="space-y-6 lg:col-span-4">
            <CurrentPositionCard position={data.currentPosition} />
            <AgentActivityCard
              vaultUsdcBalance={data.vaultUsdcBalance}
              latestDecision={data.latestDecision}
            />
            <DepositUsdcCard
              chainId={data.chainId}
              vaultAddress={data.vaultAddress}
              usdcTokenAddress={data.usdcTokenAddress}
              usdcDecimals={data.usdcDecimals}
              explorerTxBaseUrl={data.explorerTxBaseUrl}
              liveModeArmed={data.liveModeArmed}
            />
            <AgentControlsCard
              availablePools={data.availablePools}
              currentPosition={data.currentPosition}
            />
            <RiskGuardsCard guardStatus={data.guardStatus} />
            <AgentHowItWorksCard />
          </div>

          <div className="space-y-6 lg:col-span-8">
            <ApyChart snapshots={data.apySnapshots} />

            <div className="grid gap-6 xl:grid-cols-5">
              <div className="xl:col-span-3">
                <RotationsTable
                  rotations={data.rotations}
                  explorerTxBaseUrl={data.explorerTxBaseUrl}
                  isDryRun={data.isDryRun}
                  liveModeArmed={data.liveModeArmed}
                />
              </div>
              <div className="xl:col-span-2">
                <TweetFeed tweets={data.tweets} previewTweet={data.nextTweetPreview} />
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
