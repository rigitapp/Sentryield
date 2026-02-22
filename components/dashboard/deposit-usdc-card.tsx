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
  tokenAddress: string;
  tokenDecimals: number;
  tokenSymbol: string;
  explorerTxBaseUrl: string;
  liveModeArmed: boolean;
}

type PendingAutomation =
  | {
      type: "withdraw";
      amount: string;
      queuedAtMs: number;
    }
  | null;

type PendingDepositIntent =
  | {
      amount: string;
      queuedAtMs: number;
    }
  | null;

type WithdrawDiagnosticResponse =
  | {
      ok: true;
    }
  | {
      ok: false;
      errorName?: string;
      message: string;
    }
  | {
      error: string;
    };

const TREASURY_VAULT_USER_ABI = parseAbi([
  "function depositUsdc(uint256 amountIn) returns (uint256 sharesOut)",
  "function withdrawToWallet(uint256 amountOut,address receiver) returns (uint256 sharesBurned)",
  "function userShares(address account) view returns (uint256)",
  "function maxWithdrawToWallet(address account) view returns (uint256)",
  "function hasOpenLpPosition() view returns (bool)",
  "function supportsAnytimeLiquidity() view returns (bool)",
  "error ZeroAddress()",
  "error InvalidBps(uint256 value)",
  "error InvalidDeadlineDelay(uint256 value)",
  "error InvalidAmount()",
  "error InvalidMinOut()",
  "error TokenNotAllowlisted(address token)",
  "error TargetNotAllowlisted(address target)",
  "error PoolNotAllowlisted(address pool)",
  "error DeadlineExpired(uint256 deadline)",
  "error DeadlineTooFar(uint256 deadline,uint256 maxAllowed)",
  "error MovementCapExceeded(address token,uint256 amount,uint256 cap)",
  "error DailyMovementCapExceeded(uint256 usedBps,uint256 attemptedBps,uint256 capBps)",
  "error InsufficientTokenBalance(address token,uint256 balance,uint256 requested)",
  "error TokenMismatch(address expected,address actual)",
  "error SlippageCheckFailed(uint256 actualOut,uint256 minOut)",
  "error NotGuardianOrOwner()",
  "error NativeTokenNotAccepted()",
  "error PositionStillActive()",
  "error InsufficientShares(uint256 balance,uint256 requested)",
  "error VaultHasUnaccountedAssets(uint256 currentBalance)",
  "error UnsupportedPoolAsset(address pool,address expected,address actual)",
  "error MissingLpRoute(address lpToken)",
  "error UnsupportedPoolPreview(address pool)",
  "error InsufficientLiquidityForWithdraw(uint256 available,uint256 requested)"
]);

function trimAmount(raw: string): string {
  return raw.replace(/[^\d.]/g, "");
}

function formatSignedTokenAmount(value: bigint, decimals: number): string {
  const sign = value < 0n ? "-" : "+";
  const absolute = value < 0n ? -value : value;
  const normalized = formatUnits(absolute, decimals);
  const [whole, fraction = ""] = normalized.split(".");
  const compactFraction = fraction.slice(0, 6).replace(/0+$/, "");
  return compactFraction ? `${sign}${whole}.${compactFraction}` : `${sign}${whole}`;
}

export function DepositUsdcCard({
  chainId,
  vaultAddress,
  tokenAddress: assetTokenAddress,
  tokenDecimals,
  tokenSymbol,
  explorerTxBaseUrl,
  liveModeArmed
}: DepositUsdcCardProps) {
  const [depositAmount, setDepositAmount] = useState("");
  const [withdrawAmount, setWithdrawAmount] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<
    "approve" | "deposit" | "legacy_transfer" | "withdraw" | null
  >(null);
  const [pendingAutomation, setPendingAutomation] = useState<PendingAutomation>(null);
  const [pendingDepositIntent, setPendingDepositIntent] = useState<PendingDepositIntent>(null);
  const [isQueueingExit, setIsQueueingExit] = useState(false);
  const [isDiagnosingWithdraw, setIsDiagnosingWithdraw] = useState(false);
  const [automationInfo, setAutomationInfo] = useState<string | null>(null);
  const [resumeQueuedDepositAfterApprove, setResumeQueuedDepositAfterApprove] =
    useState<string | null>(null);
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
    return isAddress(assetTokenAddress)
      ? (assetTokenAddress as `0x${string}`)
      : null;
  }, [assetTokenAddress]);
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
  const { data: supportsAnytimeLiquidityRaw } = useReadContract({
    abi: TREASURY_VAULT_USER_ABI,
    address: destinationAddress ?? undefined,
    functionName: "supportsAnytimeLiquidity",
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
  const supportsAnytimeLiquidity = supportsAnytimeLiquidityRaw === true;
  const canEstimatePnl = isVaultUserFlowAvailable && (supportsAnytimeLiquidity || !hasOpenLpPosition);
  const estimatedPnlRaw = canEstimatePnl ? maxWithdrawValue - userSharesValue : null;
  const estimatedPnlText =
    estimatedPnlRaw !== null
      ? `${formatSignedTokenAmount(estimatedPnlRaw, tokenDecimals)} ${tokenSymbol}`
      : null;

  const balanceText =
    walletBalanceValue !== null ? formatUnits(walletBalanceValue, tokenDecimals) : null;
  const sharesText = formatUnits(userSharesValue, tokenDecimals);
  const maxWithdrawText = formatUnits(maxWithdrawValue, tokenDecimals);

  const depositAmountRawPreview = useMemo(() => {
    if (!depositAmount) return null;
    try {
      return parseUnits(depositAmount, tokenDecimals);
    } catch {
      return null;
    }
  }, [depositAmount, tokenDecimals]);

  const needsApproval = Boolean(
    isVaultUserFlowAvailable &&
      depositAmountRawPreview !== null &&
      depositAmountRawPreview > 0n &&
      allowanceValue < depositAmountRawPreview
  );

  const txUrl = txHash ? `${explorerTxBaseUrl}${txHash}` : null;
  const isBusy = isWriting || isConfirming || isSwitching || isQueueingExit || isDiagnosingWithdraw;

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

  const queueExitForAutomation = async (amount: string): Promise<void> => {
    if (!liveModeArmed) {
      setLocalError(
        "Live mode is currently disarmed. Auto-exit cannot complete until LIVE_MODE_ARMED=true."
      );
      return;
    }
    setIsQueueingExit(true);
    setAutomationInfo(null);
    setLocalError(null);
    try {
      const response = await fetch("/api/agent-controls", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          action: "exit"
        })
      });
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) {
        throw new Error(payload.error ?? `Exit command failed: ${response.status}`);
      }
      setPendingAutomation({
        type: "withdraw",
        amount,
        queuedAtMs: Date.now()
      });
      setAutomationInfo(
        `Exit queued. Waiting for vault to park in ${tokenSymbol}, then continuing.`
      );
      void refetchHasOpenLpPosition();
      void refetchMaxWithdraw();
    } catch (requestError) {
      setLocalError(
        requestError instanceof Error
          ? requestError.message
          : `Failed to queue Exit to ${tokenSymbol}.`
      );
    } finally {
      setIsQueueingExit(false);
    }
  };

  useEffect(() => {
    if (!pendingAutomation && !pendingDepositIntent) return;
    const timer = setInterval(() => {
      void refetchHasOpenLpPosition();
      void refetchMaxWithdraw();
    }, 5_000);
    return () => clearInterval(timer);
  }, [pendingAutomation, pendingDepositIntent, refetchHasOpenLpPosition, refetchMaxWithdraw]);

  useEffect(() => {
    if (!pendingDepositIntent) return;
    if (hasOpenLpPosition) return;
    if (!isConnected || isWrongNetwork || isBusy) return;
    if (!destinationAddress || !tokenAddress) {
      setPendingDepositIntent(null);
      setLocalError("Vault or token address is not configured correctly.");
      return;
    }

    const queued = pendingDepositIntent;
    let amountRaw: bigint;
    try {
      amountRaw = parseUnits(queued.amount, tokenDecimals);
    } catch {
      setPendingDepositIntent(null);
      setLocalError(`Amount format invalid for ${tokenDecimals}-decimals ${tokenSymbol}.`);
      return;
    }
    if (amountRaw <= 0n) {
      setPendingDepositIntent(null);
      setLocalError("Deposit amount must be greater than zero.");
      return;
    }
    if (walletBalanceValue !== null && amountRaw > walletBalanceValue) {
      setPendingDepositIntent(null);
      setLocalError(`Insufficient ${tokenSymbol} wallet balance for queued deposit.`);
      return;
    }

    setDepositAmount(queued.amount);
    setPendingDepositIntent(null);
    setAutomationInfo(`Vault is parked in ${tokenSymbol}. Continuing your queued deposit.`);

    if (isVaultUserFlowAvailable && allowanceValue < amountRaw) {
      setPendingAction("approve");
      setResumeQueuedDepositAfterApprove(queued.amount);
      writeContract({
        abi: erc20Abi,
        address: tokenAddress,
        functionName: "approve",
        args: [destinationAddress, amountRaw],
        chainId
      });
      return;
    }

    if (isVaultUserFlowAvailable) {
      setPendingAction("deposit");
      writeContract({
        abi: TREASURY_VAULT_USER_ABI,
        address: destinationAddress,
        functionName: "depositUsdc",
        args: [amountRaw],
        chainId
      });
      setLastSubmittedDepositAmount(queued.amount);
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
    setLastSubmittedDepositAmount(queued.amount);
  }, [
    pendingDepositIntent,
    hasOpenLpPosition,
    isConnected,
    isWrongNetwork,
    isBusy,
    destinationAddress,
    tokenAddress,
    tokenDecimals,
    tokenSymbol,
    walletBalanceValue,
    isVaultUserFlowAvailable,
    allowanceValue,
    writeContract,
    chainId,
    address
  ]);

  useEffect(() => {
    if (!pendingAutomation) return;
    if (hasOpenLpPosition) return;
    if (!isConnected || isWrongNetwork || isBusy) return;
    if (!destinationAddress || !address) return;

    let amountRaw: bigint;
    try {
      amountRaw = parseUnits(pendingAutomation.amount, tokenDecimals);
    } catch {
      setPendingAutomation(null);
      setLocalError(`Amount format invalid for ${tokenDecimals}-decimals ${tokenSymbol}.`);
      return;
    }
    if (amountRaw <= 0n) {
      setPendingAutomation(null);
      setLocalError("Withdraw amount must be greater than zero.");
      return;
    }
    if (amountRaw > maxWithdrawValue) {
      const waitingMs = Date.now() - pendingAutomation.queuedAtMs;
      if (waitingMs > 120_000) {
        setPendingAutomation(null);
        setLocalError("Queued withdraw amount exceeds your updated withdrawable balance.");
        return;
      }
      setAutomationInfo("Exit confirmed. Waiting for withdrawable balance to refresh.");
      return;
    }

    setWithdrawAmount(pendingAutomation.amount);
    setPendingAutomation(null);
    setAutomationInfo(`Vault is parked in ${tokenSymbol}. Continuing your withdraw.`);
    setPendingAction("withdraw");
    writeContract({
      abi: TREASURY_VAULT_USER_ABI,
      address: destinationAddress,
      functionName: "withdrawToWallet",
      args: [amountRaw, address],
      chainId
    });
    setLastSubmittedWithdrawAmount(pendingAutomation.amount);
  }, [
    pendingAutomation,
    hasOpenLpPosition,
    isConnected,
    isWrongNetwork,
    isBusy,
    destinationAddress,
    address,
    tokenDecimals,
    tokenSymbol,
    maxWithdrawValue,
    writeContract,
    chainId
  ]);

  useEffect(() => {
    if (!resumeQueuedDepositAfterApprove) return;
    if (!isConfirmed || pendingAction !== "approve") return;
    if (!destinationAddress) return;

    let amountRaw: bigint;
    try {
      amountRaw = parseUnits(resumeQueuedDepositAfterApprove, tokenDecimals);
    } catch {
      setResumeQueuedDepositAfterApprove(null);
      setLocalError(`Amount format invalid for ${tokenDecimals}-decimals ${tokenSymbol}.`);
      return;
    }
    setPendingAction("deposit");
    setAutomationInfo("Approval confirmed. Continuing your queued deposit.");
    setResumeQueuedDepositAfterApprove(null);
    writeContract({
      abi: TREASURY_VAULT_USER_ABI,
      address: destinationAddress,
      functionName: "depositUsdc",
      args: [amountRaw],
      chainId
    });
    setLastSubmittedDepositAmount(resumeQueuedDepositAfterApprove);
  }, [
    resumeQueuedDepositAfterApprove,
    isConfirmed,
    pendingAction,
    destinationAddress,
    tokenDecimals,
    tokenSymbol,
    writeContract,
    chainId
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
      setLocalError(`Enter a ${tokenSymbol} amount.`);
      return;
    }

    let amountRaw: bigint;
    try {
      amountRaw = parseUnits(depositAmount, tokenDecimals);
    } catch {
      setLocalError(`Amount format invalid for ${tokenDecimals}-decimals ${tokenSymbol}.`);
      return;
    }
    if (amountRaw <= 0n) {
      setLocalError("Amount must be greater than zero.");
      return;
    }
    if (walletBalanceValue !== null && amountRaw > walletBalanceValue) {
      setLocalError(`Insufficient ${tokenSymbol} wallet balance.`);
      return;
    }

    if (isVaultUserFlowAvailable) {
      if (hasOpenLpPosition && !supportsAnytimeLiquidity) {
        setPendingDepositIntent({
          amount: depositAmount,
          queuedAtMs: Date.now()
        });
        setAutomationInfo(
          `Deposit request queued. It will execute automatically once the vault is parked in ${tokenSymbol}.`
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
    if (!withdrawAmount) {
      setLocalError("Enter a withdraw amount.");
      return;
    }

    let amountRaw: bigint;
    try {
      amountRaw = parseUnits(withdrawAmount, tokenDecimals);
    } catch {
      setLocalError(`Amount format invalid for ${tokenDecimals}-decimals ${tokenSymbol}.`);
      return;
    }
    if (amountRaw <= 0n) {
      setLocalError("Withdraw amount must be greater than zero.");
      return;
    }
    if (hasOpenLpPosition && !supportsAnytimeLiquidity) {
      void queueExitForAutomation(withdrawAmount);
      return;
    }
    if (amountRaw > maxWithdrawValue) {
      setLocalError("Amount exceeds your current withdrawable balance.");
      return;
    }

    const diagnoseAndSubmit = async () => {
      if (!address || !destinationAddress) return;
      setIsDiagnosingWithdraw(true);
      try {
        const response = await fetch("/api/withdraw-diagnostics", {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            vaultAddress: destinationAddress,
            account: address,
            receiver: address,
            amountRaw: amountRaw.toString()
          })
        });
        const payload = (await response.json().catch(() => ({}))) as WithdrawDiagnosticResponse;
        if (!response.ok) {
          const message =
            "error" in payload && typeof payload.error === "string"
              ? payload.error
              : "Withdraw precheck failed.";
          setLocalError(message);
          return;
        }
        if ("ok" in payload && payload.ok === false) {
          setLocalError(payload.message || "Withdraw simulation failed.");
          return;
        }
      } catch {
        setLocalError("Withdraw precheck request failed.");
        return;
      } finally {
        setIsDiagnosingWithdraw(false);
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

    void diagnoseAndSubmit();
  };

  return (
    <Card className="border-border bg-card">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center justify-between text-lg">
          <span className="flex items-center gap-2">
            <ArrowDownToLine className="h-5 w-5 text-primary" />
            Deposit {tokenSymbol} To Vault
          </span>
          <Badge variant="outline" className="text-xs font-normal">
            Live wallet tx
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="break-all text-xs text-muted-foreground">Vault: {vaultAddress}</p>
        <p className="break-all text-xs text-muted-foreground">
          {tokenSymbol}: {assetTokenAddress}
        </p>
        <p className="rounded-md bg-secondary/50 p-2 text-xs text-muted-foreground">
          {supportsAnytimeLiquidity
            ? "Heads-up: anytime liquidity is enabled. Deposits and wallet withdrawals can run while LP is active; the vault auto-unwinds liquidity as needed under configured rails."
            : `Heads-up: there is no mandatory 24h hold timer. Wallet withdrawals are available whenever funds are parked in ${tokenSymbol}; if capital is deployed, use Exit to park first.`}
        </p>

        {isVaultUserFlowAvailable ? (
          <div className="space-y-1 rounded-md border border-border p-2 text-xs text-muted-foreground">
            <p>Your vault shares: {sharesText}</p>
            <p>
              Withdrawable now: {maxWithdrawText} {tokenSymbol}
            </p>
            <p>
              Estimated PnL:{" "}
              {estimatedPnlText ??
                `unavailable while capital is deployed (visible when parked in ${tokenSymbol})`}
            </p>
            <p>
              Vault state:{" "}
              {hasOpenLpPosition
                ? supportsAnytimeLiquidity
                  ? "active LP position (anytime liquidity enabled)"
                  : "active LP position (legacy flow)"
                : `parked in ${tokenSymbol}`}
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
            placeholder={`Deposit amount in ${tokenSymbol}`}
          />
          <div className="flex items-center justify-between">
            <p className="text-xs text-muted-foreground">
              {balanceText !== null
                ? `Wallet balance: ${balanceText} ${tokenSymbol}`
                : "Wallet balance: -"}
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
          disabled={isBusy || !isConnected}
        >
          {isWrongNetwork
            ? "Switch To Monad"
            : isQueueingExit
              ? "Queueing Exit..."
            : isWriting
              ? "Confirm In Wallet..."
              : isConfirming
                ? "Waiting For Confirmation..."
                : isVaultUserFlowAvailable && hasOpenLpPosition && !supportsAnytimeLiquidity
                  ? "Queue Deposit Request"
                : isVaultUserFlowAvailable && needsApproval
                  ? `Approve ${tokenSymbol}`
                  : `Deposit ${tokenSymbol}`}
          {isBusy ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : null}
        </Button>

        {isVaultUserFlowAvailable && hasOpenLpPosition && !supportsAnytimeLiquidity ? (
          <p className="text-xs text-muted-foreground">
            Active LP detected. Deposit requests are queued and execute when vault liquidity is
            parked in {tokenSymbol}.
          </p>
        ) : null}

        {isVaultUserFlowAvailable ? (
          <div className="space-y-2 rounded-lg border border-border p-3">
            <p className="text-xs text-muted-foreground">Withdraw to wallet</p>
            <Input
              value={withdrawAmount}
              onChange={(event) => setWithdrawAmount(trimAmount(event.target.value))}
              inputMode="decimal"
              placeholder={`Withdraw amount in ${tokenSymbol}`}
            />
            <div className="flex items-center justify-between">
              <p className="text-xs text-muted-foreground">
                Available: {maxWithdrawText} {tokenSymbol}
              </p>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-xs"
                onClick={() => setWithdrawAmount(maxWithdrawText)}
                disabled={isBusy || maxWithdrawValue <= 0n}
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
                (!hasOpenLpPosition && maxWithdrawValue <= 0n)
              }
            >
              {isDiagnosingWithdraw
                ? "Checking Withdraw..."
                : hasOpenLpPosition && !supportsAnytimeLiquidity
                ? "Auto Exit + Withdraw"
                : "Withdraw To Wallet"}
            </Button>
          </div>
        ) : null}

        {!isConnected ? (
          <p className="text-xs text-warning">Connect a wallet adapter first.</p>
        ) : null}
        {automationInfo ? <p className="text-xs text-muted-foreground">{automationInfo}</p> : null}
        {localError ? <p className="text-xs text-warning">{localError}</p> : null}
        {writeError ? <p className="text-xs text-warning">{writeError.message}</p> : null}
        {receiptError ? <p className="text-xs text-warning">{receiptError.message}</p> : null}
        {isConfirmed && pendingAction === "approve" ? (
          <p className="text-xs text-success">
            Approval confirmed. Continuing deposit flow.
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
            Withdraw confirmed on-chain. {tokenSymbol} returned to your wallet.
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
            Session deposit submitted: {lastSubmittedDepositAmount} {tokenSymbol}
          </p>
        ) : null}
        {lastSubmittedWithdrawAmount ? (
          <p className="text-xs text-muted-foreground">
            Session withdraw submitted: {lastSubmittedWithdrawAmount} {tokenSymbol}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
