"use client";

import { useMemo, useState } from "react";
import { ArrowDownToLine, ExternalLink, Loader2 } from "lucide-react";
import { erc20Abi, formatUnits, isAddress, parseUnits } from "viem";
import {
  useAccount,
  useBalance,
  useChainId,
  useSwitchChain,
  useWaitForTransactionReceipt,
  useWriteContract
} from "wagmi";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";

interface DepositUsdcCardProps {
  chainId: number;
  vaultAddress: string;
  usdcTokenAddress: string;
  usdcDecimals: number;
  explorerTxBaseUrl: string;
}

function trimAmount(raw: string): string {
  return raw.replace(/[^\d.]/g, "");
}

export function DepositUsdcCard({
  chainId,
  vaultAddress,
  usdcTokenAddress,
  usdcDecimals,
  explorerTxBaseUrl
}: DepositUsdcCardProps) {
  const [amount, setAmount] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  const { address, isConnected } = useAccount();
  const activeChainId = useChainId();
  const isWrongNetwork = isConnected && activeChainId !== chainId;
  const { switchChain, isPending: isSwitching } = useSwitchChain();
  const {
    data: txHash,
    error: writeError,
    isPending: isWriting,
    writeContract
  } = useWriteContract();
  const { isLoading: isConfirming, isSuccess: isConfirmed, error: receiptError } =
    useWaitForTransactionReceipt({ hash: txHash });

  const tokenAddress = useMemo(() => {
    return isAddress(usdcTokenAddress)
      ? (usdcTokenAddress as `0x${string}`)
      : null;
  }, [usdcTokenAddress]);
  const destinationAddress = useMemo(() => {
    return isAddress(vaultAddress) ? (vaultAddress as `0x${string}`) : null;
  }, [vaultAddress]);

  const { data: walletBalance } = useBalance({
    address,
    token: tokenAddress ?? undefined,
    chainId,
    query: {
      enabled: Boolean(address && tokenAddress)
    }
  });

  const balanceText = walletBalance
    ? formatUnits(walletBalance.value, usdcDecimals)
    : null;

  const txUrl = txHash ? `${explorerTxBaseUrl}${txHash}` : null;
  const isBusy = isWriting || isConfirming || isSwitching;

  const onDeposit = () => {
    setLocalError(null);
    if (!isConnected) {
      setLocalError("Connect a wallet first.");
      return;
    }
    if (!tokenAddress || !destinationAddress) {
      setLocalError("Vault or token address is not configured correctly.");
      return;
    }
    if (isWrongNetwork) {
      switchChain({ chainId });
      return;
    }
    if (!amount) {
      setLocalError("Enter a USDC amount.");
      return;
    }

    let amountRaw: bigint;
    try {
      amountRaw = parseUnits(amount, usdcDecimals);
    } catch {
      setLocalError(`Amount format invalid for ${usdcDecimals}-decimals USDC.`);
      return;
    }
    if (amountRaw <= 0n) {
      setLocalError("Amount must be greater than zero.");
      return;
    }
    if (walletBalance && amountRaw > walletBalance.value) {
      setLocalError("Insufficient USDC wallet balance.");
      return;
    }

    writeContract({
      abi: erc20Abi,
      address: tokenAddress,
      functionName: "transfer",
      args: [destinationAddress, amountRaw],
      chainId
    });
  };

  return (
    <Card className="border-border bg-card">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center justify-between text-lg">
          <span className="flex items-center gap-2">
            <ArrowDownToLine className="h-5 w-5 text-primary" />
            Deposit USDC To Vault
          </span>
          <Badge variant="outline" className="text-xs font-normal">
            Live wallet tx
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">Vault: {vaultAddress}</p>
        <p className="text-xs text-muted-foreground">USDC: {usdcTokenAddress}</p>
        <div className="space-y-2">
          <Input
            value={amount}
            onChange={(event) => setAmount(trimAmount(event.target.value))}
            inputMode="decimal"
            placeholder="Amount in USDC"
          />
          <div className="flex items-center justify-between">
            <p className="text-xs text-muted-foreground">
              {balanceText !== null ? `Wallet balance: ${balanceText} USDC` : "Wallet balance: -"}
            </p>
            {balanceText !== null ? (
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-xs"
                onClick={() => setAmount(balanceText)}
                disabled={isBusy}
              >
                Max
              </Button>
            ) : null}
          </div>
        </div>

        <Button
          className="w-full"
          onClick={onDeposit}
          disabled={isBusy || !isConnected}
        >
          {isWrongNetwork
            ? "Switch To Monad"
            : isWriting
              ? "Confirm In Wallet..."
              : isConfirming
                ? "Waiting For Confirmation..."
                : "Deposit USDC"}
          {isBusy ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : null}
        </Button>

        {!isConnected ? (
          <p className="text-xs text-warning">Connect a wallet adapter first.</p>
        ) : null}
        {localError ? <p className="text-xs text-warning">{localError}</p> : null}
        {writeError ? <p className="text-xs text-warning">{writeError.message}</p> : null}
        {receiptError ? <p className="text-xs text-warning">{receiptError.message}</p> : null}
        {txUrl ? (
          <a
            href={txUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
          >
            View tx <ExternalLink className="h-3 w-3" />
          </a>
        ) : null}
        {isConfirmed ? (
          <p className="text-xs text-success">
            Deposit confirmed on-chain. Bot can consume this balance in live mode.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
