"use client";

import { useMemo, useState } from "react";
import { Search, ExternalLink, History } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import type { AgentTransaction } from "@/lib/types";

interface TransactionsTableProps {
  transactions: AgentTransaction[];
  explorerTxBaseUrl: string;
  isDryRun: boolean;
  liveModeArmed: boolean;
}

function formatDate(dateString: string): string {
  return new Date(dateString).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function truncateHash(hash: string): string {
  return `${hash.slice(0, 6)}...${hash.slice(-4)}`;
}

function actionLabel(action: AgentTransaction["action"]): string {
  if (action === "EXIT_TO_USDC") return "Withdraw";
  return "Enter";
}

export function TransactionsTable({
  transactions,
  explorerTxBaseUrl,
  isDryRun,
  liveModeArmed
}: TransactionsTableProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const [actionFilter, setActionFilter] = useState<"all" | AgentTransaction["action"]>("all");
  const [pairFilter, setPairFilter] = useState<string>("all");

  const pairOptions = useMemo(() => {
    return Array.from(new Set(transactions.map((transaction) => transaction.pair))).sort();
  }, [transactions]);

  const filteredTransactions = useMemo(() => {
    const normalizedSearch = searchQuery.toLowerCase();
    return transactions.filter((transaction) => {
      const matchesSearch =
        transaction.fromPool.toLowerCase().includes(normalizedSearch) ||
        transaction.toPool.toLowerCase().includes(normalizedSearch) ||
        transaction.reason.toLowerCase().includes(normalizedSearch) ||
        actionLabel(transaction.action).toLowerCase().includes(normalizedSearch);

      const matchesAction =
        actionFilter === "all" || transaction.action === actionFilter;
      const matchesPair = pairFilter === "all" || transaction.pair === pairFilter;

      return matchesSearch && matchesAction && matchesPair;
    });
  }, [transactions, searchQuery, actionFilter, pairFilter]);

  return (
    <Card className="border-border bg-card">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-lg">
          <History className="h-5 w-5 text-primary" />
          Transaction History
        </CardTitle>
        <div className="flex flex-col gap-3 pt-3 lg:flex-row">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search pools, action, or reason..."
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              className="pl-9"
            />
          </div>
          <Select
            value={actionFilter}
            onValueChange={(value) =>
              setActionFilter(value as "all" | AgentTransaction["action"])
            }
          >
            <SelectTrigger className="w-full lg:w-[160px]">
              <SelectValue placeholder="Filter by action" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Actions</SelectItem>
              <SelectItem value="ENTER">Enter</SelectItem>
              <SelectItem value="EXIT_TO_USDC">Withdraw</SelectItem>
            </SelectContent>
          </Select>
          <Select value={pairFilter} onValueChange={setPairFilter}>
            <SelectTrigger className="w-full lg:w-[160px]">
              <SelectValue placeholder="Filter by pair" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Pairs</SelectItem>
              {pairOptions.map((pair) => (
                <SelectItem key={pair} value={pair}>
                  {pair}
                </SelectItem>
              ))}
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
                <th className="pb-3 pr-4 font-medium">Action</th>
                <th className="pb-3 pr-4 font-medium">From</th>
                <th className="pb-3 pr-4 font-medium">To</th>
                <th className="pb-3 pr-4 font-medium">Reason</th>
                <th className="pb-3 font-medium">Tx</th>
              </tr>
            </thead>
            <tbody className="text-sm">
              {filteredTransactions.map((transaction) => {
                const txHash = transaction.txHash;
                const isWithdraw = transaction.action === "EXIT_TO_USDC";
                return (
                  <tr
                    key={transaction.id}
                    className="border-b border-border/50 last:border-0"
                  >
                    <td className="py-3 pr-4 text-muted-foreground">
                      {formatDate(transaction.timestamp)}
                    </td>
                    <td className="py-3 pr-4">
                      <Badge
                        variant="outline"
                        className={
                          isWithdraw
                            ? "border-amber-500/40 text-amber-700 dark:text-amber-300"
                            : "border-blue-500/40 text-blue-700 dark:text-blue-300"
                        }
                      >
                        {actionLabel(transaction.action)}
                      </Badge>
                    </td>
                    <td className="py-3 pr-4 text-foreground">{transaction.fromPool}</td>
                    <td className="py-3 pr-4 text-foreground">{transaction.toPool}</td>
                    <td className="py-3 pr-4">
                      <Badge variant="outline" className="text-xs font-normal">
                        {transaction.reason}
                      </Badge>
                    </td>
                    <td className="py-3">
                      {txHash ? (
                        <a
                          href={`${explorerTxBaseUrl}${txHash}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 text-primary hover:underline"
                        >
                          {truncateHash(txHash)}
                          <ExternalLink className="h-3 w-3" />
                        </a>
                      ) : (
                        <span className="text-muted-foreground">
                          {isDryRun
                            ? "Simulated"
                            : liveModeArmed
                              ? "—"
                              : "Blocked"}
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
              {filteredTransactions.length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-8 text-center text-muted-foreground">
                    No transactions found matching your filters.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}
