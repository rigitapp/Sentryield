"use client";

import { useState, useMemo } from "react";
import { Search, ExternalLink, ArrowRightLeft } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import type { Rotation } from "@/lib/types";

interface RotationsTableProps {
  rotations: Rotation[];
}

export function RotationsTable({ rotations }: RotationsTableProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const [pairFilter, setPairFilter] = useState<string>("all");

  const filteredRotations = useMemo(() => {
    return rotations.filter((rotation) => {
      const matchesSearch =
        rotation.fromPool.toLowerCase().includes(searchQuery.toLowerCase()) ||
        rotation.toPool.toLowerCase().includes(searchQuery.toLowerCase()) ||
        rotation.reason.toLowerCase().includes(searchQuery.toLowerCase());

      const matchesPair =
        pairFilter === "all" || rotation.pair === pairFilter;

      return matchesSearch && matchesPair;
    });
  }, [rotations, searchQuery, pairFilter]);

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  const truncateHash = (hash: string) => {
    return `${hash.slice(0, 6)}...${hash.slice(-4)}`;
  };

  return (
    <Card className="border-border bg-card">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-lg">
          <ArrowRightLeft className="h-5 w-5 text-primary" />
          Rotation History
        </CardTitle>
        <div className="flex flex-col gap-3 pt-3 sm:flex-row">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search pools or reasons..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9"
            />
          </div>
          <Select value={pairFilter} onValueChange={setPairFilter}>
            <SelectTrigger className="w-full sm:w-[160px]">
              <SelectValue placeholder="Filter by pair" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Pairs</SelectItem>
              <SelectItem value="AUSD/MON">AUSD/MON</SelectItem>
              <SelectItem value="USDC/MON">USDC/MON</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-foreground">
                <th className="pb-3 pr-4 font-medium">Time</th>
                <th className="pb-3 pr-4 font-medium">From</th>
                <th className="pb-3 pr-4 font-medium">To</th>
                <th className="pb-3 pr-4 font-medium text-right">Old APY</th>
                <th className="pb-3 pr-4 font-medium text-right">New APY</th>
                <th className="pb-3 pr-4 font-medium">Reason</th>
                <th className="pb-3 font-medium">Tx</th>
              </tr>
            </thead>
            <tbody className="text-sm">
              {filteredRotations.map((rotation) => {
                const apyChange = rotation.newApy - rotation.oldApy;
                return (
                  <tr
                    key={rotation.id}
                    className="border-b border-border/50 last:border-0"
                  >
                    <td className="py-3 pr-4 text-muted-foreground">
                      {formatDate(rotation.timestamp)}
                    </td>
                    <td className="py-3 pr-4">
                      <span className="text-foreground">{rotation.fromPool}</span>
                    </td>
                    <td className="py-3 pr-4">
                      <span className="text-foreground">{rotation.toPool}</span>
                    </td>
                    <td className="py-3 pr-4 text-right text-muted-foreground">
                      {rotation.oldApy > 0 ? `${rotation.oldApy}%` : "—"}
                    </td>
                    <td className="py-3 pr-4 text-right">
                      <span className="text-foreground">
                        {rotation.newApy}%
                      </span>
                      {apyChange !== 0 && rotation.oldApy > 0 && (
                        <span
                          className={`ml-1 text-xs ${
                            apyChange > 0 ? "text-success" : "text-destructive"
                          }`}
                        >
                          ({apyChange > 0 ? "+" : ""}
                          {apyChange.toFixed(1)}%)
                        </span>
                      )}
                    </td>
                    <td className="py-3 pr-4">
                      <Badge
                        variant="outline"
                        className="text-xs font-normal"
                      >
                        {rotation.reason}
                      </Badge>
                    </td>
                    <td className="py-3">
                      <a
                        href={`https://explorer.monad.xyz/tx/${rotation.txHash}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-primary hover:underline"
                      >
                        {truncateHash(rotation.txHash)}
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    </td>
                  </tr>
                );
              })}
              {filteredRotations.length === 0 && (
                <tr>
                  <td
                    colSpan={7}
                    className="py-8 text-center text-muted-foreground"
                  >
                    No rotations found matching your filters.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}
