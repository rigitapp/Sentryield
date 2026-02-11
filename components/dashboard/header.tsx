"use client";

import { useMemo, useState } from "react";
import { ChevronDown, LogOut, Network, Wallet } from "lucide-react";
import { useAccount, useChainId, useConnect, useDisconnect, useSwitchChain } from "wagmi";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu";
import type { AgentStatus } from "@/lib/types";

interface HeaderProps {
  status: AgentStatus;
}

function shortAddress(address: string): string {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

export function Header({ status }: HeaderProps) {
  const [walletError, setWalletError] = useState<string | null>(null);
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const { connect, connectors, error: connectError, isPending, variables } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain, isPending: isSwitching } = useSwitchChain();

  const targetChainId = useMemo(() => {
    const raw = Number(process.env.NEXT_PUBLIC_MONAD_CHAIN_ID ?? "143");
    return Number.isFinite(raw) ? raw : 143;
  }, []);

  const isWrongNetwork = isConnected && chainId !== targetChainId;
  const hasWalletConnect = Boolean(
    process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID?.trim()
  );
  const pendingConnectorId = variables?.connector?.id;
  const activeError = walletError ?? connectError?.message ?? null;

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
      <div className="flex flex-col items-end gap-1">
        <div className="flex items-center gap-2">
          {isConnected ? (
            <Badge
              variant="outline"
              className={
                isWrongNetwork
                  ? "border-destructive text-destructive"
                  : "border-success text-success"
              }
            >
              {isWrongNetwork ? `Wrong Network (${chainId})` : "Monad Mainnet"}
            </Badge>
          ) : null}

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" className="gap-2 bg-transparent">
                <Wallet className="h-4 w-4" />
                {isPending
                  ? "Connecting..."
                  : isConnected && address
                    ? shortAddress(address)
                    : "Connect Wallet"}
                <ChevronDown className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-64">
              {!isConnected ? (
                <>
                  <DropdownMenuLabel>Wallet adapters</DropdownMenuLabel>
                  {connectors.map((connector) => (
                    <DropdownMenuItem
                      key={connector.uid}
                      onClick={() => {
                        setWalletError(null);
                        connect({ connector });
                      }}
                    >
                      <Wallet className="h-4 w-4" />
                      {connector.name}
                      {isPending && pendingConnectorId === connector.id
                        ? " (connecting...)"
                        : ""}
                    </DropdownMenuItem>
                  ))}
                  {!hasWalletConnect ? (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem disabled>
                        WalletConnect disabled (set NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID)
                      </DropdownMenuItem>
                    </>
                  ) : null}
                </>
              ) : (
                <>
                  <DropdownMenuLabel>
                    Connected {address ? shortAddress(address) : ""}
                  </DropdownMenuLabel>
                  {isWrongNetwork ? (
                    <DropdownMenuItem
                      onClick={() => {
                        setWalletError(null);
                        switchChain({ chainId: targetChainId });
                      }}
                      disabled={isSwitching}
                    >
                      <Network className="h-4 w-4" />
                      {isSwitching
                        ? "Switching..."
                        : `Switch to Monad (${targetChainId})`}
                    </DropdownMenuItem>
                  ) : null}
                  <DropdownMenuItem
                    onClick={() => {
                      setWalletError(null);
                      disconnect();
                    }}
                  >
                    <LogOut className="h-4 w-4" />
                    Disconnect
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        {activeError ? (
          <p className="max-w-72 text-right text-xs text-warning">{activeError}</p>
        ) : null}
      </div>
    </header>
  );
}
