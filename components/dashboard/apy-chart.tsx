"use client";

import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Area,
  AreaChart,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { TrendingUp } from "lucide-react";
import type { Snapshot } from "@/lib/types";

interface ApyChartProps {
  snapshots: Snapshot[];
}

export function ApyChart({ snapshots }: ApyChartProps) {
  const chartData = snapshots.map((snapshot) => ({
    date: new Date(snapshot.timestamp).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
    }),
    time: new Date(snapshot.timestamp).toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
    }),
    apy: snapshot.netApy,
  }));

  return (
    <Card className="border-border bg-card">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-lg">
          <TrendingUp className="h-5 w-5 text-primary" />
          Net APY (Last 7 Days)
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="h-[250px] w-full">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart
              data={chartData}
              margin={{ top: 10, right: 10, left: -10, bottom: 0 }}
            >
              <defs>
                <linearGradient id="apyGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop
                    offset="0%"
                    stopColor="oklch(0.7 0.15 160)"
                    stopOpacity={0.3}
                  />
                  <stop
                    offset="100%"
                    stopColor="oklch(0.7 0.15 160)"
                    stopOpacity={0}
                  />
                </linearGradient>
              </defs>
              <CartesianGrid
                strokeDasharray="3 3"
                stroke="oklch(0.25 0.005 285)"
                vertical={false}
              />
              <XAxis
                dataKey="date"
                stroke="oklch(0.6 0 0)"
                fontSize={11}
                tickLine={false}
                axisLine={false}
              />
              <YAxis
                stroke="oklch(0.6 0 0)"
                fontSize={11}
                tickLine={false}
                axisLine={false}
                tickFormatter={(value) => `${value}%`}
                domain={["dataMin - 2", "dataMax + 2"]}
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: "oklch(0.14 0.005 285)",
                  border: "1px solid oklch(0.25 0.005 285)",
                  borderRadius: "8px",
                  color: "oklch(0.95 0 0)",
                }}
                labelStyle={{ color: "oklch(0.6 0 0)" }}
                formatter={(value: number) => [`${value.toFixed(1)}%`, "APY"]}
              />
              <Area
                type="monotone"
                dataKey="apy"
                stroke="oklch(0.7 0.15 160)"
                strokeWidth={2}
                fill="url(#apyGradient)"
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}
