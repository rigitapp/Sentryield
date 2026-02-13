"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDownToLine, ExternalLink, Loader2 } from "lucide-react";
import { erc20Abi, formatUnits, isAddress, parseAbi, parseUnits } from "viem";
import {
  useAccount,
  useChainId,
  useReadContract,
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

const TREASURY_VAULT_USER_ABI = parseAbi([
  "function depositUsdc(uint256 amountIn) returns (uint256 sharesOut)",
  "function withdrawToWallet(uint256 amountOut,address receiver) returns (uint256 sharesBurned)",
  "function userShares(address account) view returns (uint256)",
  "function maxWithdrawToWallet(address account) view returns (uint256)",
  "function hasOpenLpPosition() view returns (bool)",
  "error ZeroAddress()",
  "error InvalidAmount()",
  "error TokenNotAllowlisted(address token)",
  "error PositionStillActive()",
  "error InsufficientShares(uint256 balance,uint256 requested)",
  "error VaultHasUnaccountedAssets(uint256 currentBalance)"
]);

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
  const [depositAmount, setDepositAmount] = useState("");
  const [withdrawAmount, setWithdrawAmount] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<
    "approve" | "deposit" | "legacy_transfer" | "withdraw" | null
  >(null);
  const [lastSubmittedDepositAmount, setLastSubmittedDepositAmount] = useState<string | null>(null);
  const [lastSubmittedWithdrawAmount, setLastSubmittedWithdrawAmount] = useState<string | null>(null);
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
  const handledReceiptHashRef = useRef<string | null>(null);

  const tokenAddress = useMemo(() => {
    return isAddress(usdcTokenAddress)
      ? (usdcTokenAddress as `0x${string}`)
      : null;
  }, [usdcTokenAddress]);
  const destinationAddress = useMemo(() => {
    return isAddress(vaultAddress) ? (vaultAddress as `0x${string}`) : null;
  }, [vaultAddress]);

  const { data: walletUsdcBalance, refetch: refetchWalletBalance } = useReadContract({
    abi: erc20Abi,
    address: tokenAddress ?? undefined,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    chainId,
    query: {
      enabled: Boolean(address && tokenAddress)
    }
  });

  const { data: allowanceRaw, refetch: refetchAllowance } = useReadContract({
    abi: erc20Abi,
    address: tokenAddress ?? undefined,
    functionName: "allowance",
    args: address && destinationAddress ? [address, destinationAddress] : undefined,
    chainId,
    query: {
      enabled: Boolean(address && tokenAddress && destinationAddress)
    }
  });

  const {
    data: userSharesRaw,
    error: userSharesError,
    refetch: refetchUserShares
  } = useReadContract({
    abi: TREASURY_VAULT_USER_ABI,
    address: destinationAddress ?? undefined,
    functionName: "userShares",
    args: address ? [address] : undefined,
    chainId,
    query: {
      enabled: Boolean(address && destinationAddress)
    }
  });

  const {
    data: maxWithdrawRaw,
    error: maxWithdrawError,
    refetch: refetchMaxWithdraw
  } = useReadContract({
    abi: TREASURY_VAULT_USER_ABI,
    address: destinationAddress ?? undefined,
    functionName: "maxWithdrawToWallet",
    args: address ? [address] : undefined,
    chainId,
    query: {
      enabled: Boolean(address && destinationAddress)
    }
  });

  const {
    data: hasOpenLpPositionRaw,
    error: hasOpenLpPositionError,
    refetch: refetchHasOpenLpPosition
  } = useReadContract({
    abi: TREASURY_VAULT_USER_ABI,
    address: destinationAddress ?? undefined,
    functionName: "hasOpenLpPosition",
    chainId,
    query: {
      enabled: Boolean(destinationAddress)
    }
  });

  const isVaultUserFlowAvailable =
    Boolean(destinationAddress) &&
    !userSharesError &&
    !maxWithdrawError &&
    !hasOpenLpPositionError;
  const walletBalanceValue = typeof walletUsdcBalance === "bigint" ? walletUsdcBalance : null;
  const allowanceValue = typeof allowanceRaw === "bigint" ? allowanceRaw : 0n;
  const userSharesValue = typeof userSharesRaw === "bigint" ? userSharesRaw : 0n;
  const maxWithdrawValue = typeof maxWithdrawRaw === "bigint" ? maxWithdrawRaw : 0n;
  const hasOpenLpPosition = hasOpenLpPositionRaw === true;

  const balanceText =
    walletBalanceValue !== null ? formatUnits(walletBalanceValue, usdcDecimals) : null;
  const sharesText = formatUnits(userSharesValue, usdcDecimals);
  const maxWithdrawText = formatUnits(maxWithdrawValue, usdcDecimals);

  const depositAmountRawPreview = useMemo(() => {
    if (!depositAmount) return null;
    try {
      return parseUnits(depositAmount, usdcDecimals);
    } catch {
      return null;
    }
  }, [depositAmount, usdcDecimals]);

  const needsApproval = Boolean(
    isVaultUserFlowAvailable &&
      depositAmountRawPreview !== null &&
      depositAmountRawPreview > 0n &&
      allowanceValue < depositAmountRawPreview
  );

  const txUrl = txHash ? `${explorerTxBaseUrl}${txHash}` : null;
  const isBusy = isWriting || isConfirming || isSwitching;

  useEffect(() => {
    if (!txHash || !isConfirmed) return;
    if (handledReceiptHashRef.current === txHash) return;
    handledReceiptHashRef.current = txHash;

    void refetchAllowance();
    void refetchWalletBalance();
    void refetchUserShares();
    void refetchMaxWithdraw();
    void refetchHasOpenLpPosition();
  }, [
    isConfirmed,
    txHash,
    refetchAllowance,
    refetchWalletBalance,
    refetchUserShares,
    refetchMaxWithdraw,
    refetchHasOpenLpPosition
  ]);

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
    if (!depositAmount) {
      setLocalError("Enter a USDC amount.");
      return;
    }

    let amountRaw: bigint;
    try {
      amountRaw = parseUnits(depositAmount, usdcDecimals);
    } catch {
      setLocalError(`Amount format invalid for ${usdcDecimals}-decimals USDC.`);
      return;
    }
    if (amountRaw <= 0n) {
      setLocalError("Amount must be greater than zero.");
      return;
    }
    if (walletBalanceValue !== null && amountRaw > walletBalanceValue) {
      setLocalError("Insufficient USDC wallet balance.");
      return;
    }

    if (isVaultUserFlowAvailable) {
      if (hasOpenLpPosition) {
        setLocalError(
          "Vault currently has an active LP position. Use Exit to USDC first, then deposit."
        );
        return;
      }

      if (needsApproval) {
        setPendingAction("approve");
        writeContract({
          abi: erc20Abi,
          address: tokenAddress,
          functionName: "approve",
          args: [destinationAddress, amountRaw],
          chainId
        });
        return;
      }

      setPendingAction("deposit");
      writeContract({
        abi: TREASURY_VAULT_USER_ABI,
        address: destinationAddress,
        functionName: "depositUsdc",
        args: [amountRaw],
        chainId
      });
      setLastSubmittedDepositAmount(depositAmount);
      return;
    }

    setPendingAction("legacy_transfer");
    writeContract({
      abi: erc20Abi,
      address: tokenAddress,
      functionName: "transfer",
      args: [destinationAddress, amountRaw],
      chainId
    });
    setLastSubmittedDepositAmount(depositAmount);
  };

  const onWithdraw = () => {
    setLocalError(null);
    if (!isConnected) {
      setLocalError("Connect a wallet first.");
      return;
    }
    if (!destinationAddress) {
      setLocalError("Vault address is not configured correctly.");
      return;
    }
    if (isWrongNetwork) {
      switchChain({ chainId });
      return;
    }
    if (!isVaultUserFlowAvailable) {
      setLocalError("Vault withdraw flow is unavailable until the v2 vault is deployed.");
      return;
    }
    if (!address) {
      setLocalError("Wallet address is unavailable.");
      return;
    }
    if (hasOpenLpPosition) {
      setLocalError("Vault capital is deployed. Use Exit to USDC, then withdraw.");
      return;
    }
    if (!withdrawAmount) {
      setLocalError("Enter a withdraw amount.");
      return;
    }

    let amountRaw: bigint;
    try {
      amountRaw = parseUnits(withdrawAmount, usdcDecimals);
    } catch {
      setLocalError(`Amount format invalid for ${usdcDecimals}-decimals USDC.`);
      return;
    }
    if (amountRaw <= 0n) {
      setLocalError("Withdraw amount must be greater than zero.");
      return;
    }
    if (amountRaw > maxWithdrawValue) {
      setLocalError("Amount exceeds your current withdrawable balance.");
      return;
    }

    setPendingAction("withdraw");
    writeContract({
      abi: TREASURY_VAULT_USER_ABI,
      address: destinationAddress,
      functionName: "withdrawToWallet",
      args: [amountRaw, address],
      chainId
    });
    setLastSubmittedWithdrawAmount(withdrawAmount);
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
        <p className="break-all text-xs text-muted-foreground">Vault: {vaultAddress}</p>
        <p className="break-all text-xs text-muted-foreground">USDC: {usdcTokenAddress}</p>
        <p className="rounded-md bg-secondary/50 p-2 text-xs text-muted-foreground">
          Heads-up: there is no mandatory 24h hold timer. Wallet withdrawals are available whenever
          funds are parked in USDC; if capital is deployed, use Exit to park first.
        </p>

        {isVaultUserFlowAvailable ? (
          <div className="space-y-1 rounded-md border border-border p-2 text-xs text-muted-foreground">
            <p>Your vault shares: {sharesText}</p>
            <p>Withdrawable now: {maxWithdrawText} USDC</p>
            <p>
              Vault state: {hasOpenLpPosition ? "active LP position (withdraw locked)" : "parked in USDC"}
            </p>
          </div>
        ) : (
          <p className="rounded-md border border-border p-2 text-xs text-muted-foreground">
            Legacy vault detected: deposits use direct transfer. Withdraw to wallet unlocks after
            migrating to the upgraded vault contract.
          </p>
        )}

        <div className="space-y-2">
          <Input
            value={depositAmount}
            onChange={(event) => setDepositAmount(trimAmount(event.target.value))}
            inputMode="decimal"
            placeholder="Deposit amount in USDC"
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
                onClick={() => setDepositAmount(balanceText)}
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
          disabled={isBusy || !isConnected || (isVaultUserFlowAvailable && hasOpenLpPosition)}
        >
          {isWrongNetwork
            ? "Switch To Monad"
            : isWriting
              ? "Confirm In Wallet..."
              : isConfirming
                ? "Waiting For Confirmation..."
                : isVaultUserFlowAvailable && hasOpenLpPosition
                  ? "Exit To USDC First"
                : isVaultUserFlowAvailable && needsApproval
                  ? "Approve USDC"
                  : "Deposit USDC"}
          {isBusy ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : null}
        </Button>

        {isVaultUserFlowAvailable && hasOpenLpPosition ? (
          <p className="text-xs text-warning">
            Deposits are paused while capital is deployed in LP. Exit to USDC, then retry deposit.
          </p>
        ) : null}

        {isVaultUserFlowAvailable ? (
          <div className="space-y-2 rounded-lg border border-border p-3">
            <p className="text-xs text-muted-foreground">Withdraw to wallet</p>
            <Input
              value={withdrawAmount}
              onChange={(event) => setWithdrawAmount(trimAmount(event.target.value))}
              inputMode="decimal"
              placeholder="Withdraw amount in USDC"
            />
            <div className="flex items-center justify-between">
              <p className="text-xs text-muted-foreground">Available: {maxWithdrawText} USDC</p>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-xs"
                onClick={() => setWithdrawAmount(maxWithdrawText)}
                disabled={isBusy || maxWithdrawValue <= 0n || hasOpenLpPosition}
              >
                Max
              </Button>
            </div>
            <Button
              variant="outline"
              className="w-full bg-transparent"
              onClick={onWithdraw}
              disabled={
                isBusy ||
                !isConnected ||
                maxWithdrawValue <= 0n ||
                hasOpenLpPosition
              }
            >
              Withdraw To Wallet
            </Button>
          </div>
        ) : null}

        {!isConnected ? (
          <p className="text-xs text-warning">Connect a wallet adapter first.</p>
        ) : null}
        {localError ? <p className="text-xs text-warning">{localError}</p> : null}
        {writeError ? <p className="text-xs text-warning">{writeError.message}</p> : null}
        {receiptError ? <p className="text-xs text-warning">{receiptError.message}</p> : null}
        {isConfirmed && pendingAction === "approve" ? (
          <p className="text-xs text-success">
            Approval confirmed. Click Deposit USDC to complete the deposit.
          </p>
        ) : null}
        {isConfirmed && pendingAction === "deposit" ? (
          <p className="text-xs text-success">
            Deposit confirmed on-chain. Funds are now tracked for redeem-to-wallet.
          </p>
        ) : null}
        {isConfirmed && pendingAction === "legacy_transfer" ? (
          <p className="text-xs text-success">
            Deposit transfer confirmed on-chain.
          </p>
        ) : null}
        {isConfirmed && pendingAction === "withdraw" ? (
          <p className="text-xs text-success">
            Withdraw confirmed on-chain. USDC returned to your wallet.
          </p>
        ) : null}
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
        {lastSubmittedDepositAmount ? (
          <p className="text-xs text-muted-foreground">
            Session deposit submitted: {lastSubmittedDepositAmount} USDC
          </p>
        ) : null}
        {lastSubmittedWithdrawAmount ? (
          <p className="text-xs text-muted-foreground">
            Session withdraw submitted: {lastSubmittedWithdrawAmount} USDC
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
