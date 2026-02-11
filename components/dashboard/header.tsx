"use client";

import { Wallet } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import type { AgentStatus } from "@/lib/types";

interface HeaderProps {
  status: AgentStatus;
}

export function Header({ status }: HeaderProps) {
  return (
    <header className="flex items-center justify-between border-b border-border px-6 py-4">
      <div className="flex items-center gap-4">
        <h1 className="text-xl font-semibold text-foreground">
          Monad Yield Agent
        </h1>
        <Badge
          variant={status === "ACTIVE" ? "default" : "secondary"}
          className={
            status === "ACTIVE"
              ? "bg-success text-success-foreground"
              : "bg-muted text-muted-foreground"
          }
        >
          {status}
        </Badge>
      </div>
      <Button variant="outline" className="gap-2 bg-transparent">
        <Wallet className="h-4 w-4" />
        Connect Wallet
      </Button>
    </header>
  );
}
