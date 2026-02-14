import { NextResponse } from "next/server";
import {
  createPublicClient,
  decodeErrorResult,
  encodeFunctionData,
  formatUnits,
  http,
  isAddress,
  parseAbi
} from "viem";

export const dynamic = "force-dynamic";

const DEFAULT_RPC_URL = "https://rpc.monad.xyz";
const DEFAULT_USDC_DECIMALS = 6;

const WITHDRAW_ABI = parseAbi([
  "function withdrawToWallet(uint256 amountOut,address receiver) returns (uint256 sharesBurned)"
]);

const TREASURY_VAULT_ERRORS_ABI = parseAbi([
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

interface DiagnoseRequestBody {
  vaultAddress?: string;
  account?: string;
  receiver?: string;
  amountRaw?: string;
}

interface DecodedDiagnostic {
  ok: false;
  errorName: string;
  message: string;
}

function resolveRpcUrl(): string {
  const raw = process.env.MONAD_RPC_URL?.trim() || process.env.NEXT_PUBLIC_MONAD_RPC_URL?.trim();
  return raw || DEFAULT_RPC_URL;
}

function resolveUsdcDecimals(): number {
  const raw = process.env.USDC_DECIMALS?.trim();
  if (!raw) return DEFAULT_USDC_DECIMALS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_USDC_DECIMALS;
  return Math.floor(parsed);
}

function formatErrorMessage(errorName: string, args: unknown[]): string {
  const usdcDecimals = resolveUsdcDecimals();
  if (errorName === "InsufficientLiquidityForWithdraw") {
    const available = typeof args[0] === "bigint" ? args[0] : 0n;
    const requested = typeof args[1] === "bigint" ? args[1] : 0n;
    return `Withdraw exceeds immediate vault liquidity rails. Available now: ${formatUnits(
      available,
      usdcDecimals
    )} USDC, requested: ${formatUnits(
      requested,
      usdcDecimals
    )} USDC. Try a smaller amount or wait for additional unwind capacity.`;
  }
  if (errorName === "MissingLpRoute") {
    return "Vault LP route is missing for one of the active positions. Configure LP routes before withdrawing.";
  }
  if (errorName === "UnsupportedPoolPreview") {
    return "Vault cannot preview LP unwind on the current pool. Check adapter/pool compatibility.";
  }
  if (errorName === "UnsupportedPoolAsset") {
    return "LP pool asset does not match vault deposit token. Check pool/token routing config.";
  }
  if (errorName === "InsufficientShares") {
    return "Requested withdraw exceeds your share-backed balance.";
  }
  if (errorName === "TokenNotAllowlisted") {
    return "Vault token allowlist blocks this withdraw path.";
  }
  if (errorName === "TargetNotAllowlisted" || errorName === "PoolNotAllowlisted") {
    return "Vault allowlist blocks unwind target or pool for this withdraw.";
  }
  return `${errorName}: withdraw simulation reverted.`;
}

function decodeCustomError(revertData: string | undefined): DecodedDiagnostic | null {
  if (!revertData || !revertData.startsWith("0x")) return null;
  try {
    const decoded = decodeErrorResult({
      abi: TREASURY_VAULT_ERRORS_ABI,
      data: revertData
    });
    const args = Array.isArray(decoded.args) ? decoded.args : [];
    return {
      ok: false,
      errorName: decoded.errorName,
      message: formatErrorMessage(decoded.errorName, args)
    };
  } catch {
    return null;
  }
}

function parseTraceRevertData(traceResult: unknown): string | undefined {
  if (!traceResult || typeof traceResult !== "object") return undefined;
  const candidate = traceResult as Record<string, unknown>;
  return typeof candidate.output === "string" ? candidate.output : undefined;
}

export async function POST(request: Request): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as DiagnoseRequestBody;
  const vaultAddress = body.vaultAddress?.trim() || "";
  const account = body.account?.trim() || "";
  const receiver = body.receiver?.trim() || account;
  const amountRawText = body.amountRaw?.trim() || "";

  if (!isAddress(vaultAddress) || !isAddress(account) || !isAddress(receiver)) {
    return NextResponse.json(
      {
        error: "vaultAddress/account/receiver must be valid addresses."
      },
      { status: 400 }
    );
  }

  let amountRaw: bigint;
  try {
    amountRaw = BigInt(amountRawText);
  } catch {
    return NextResponse.json(
      {
        error: "amountRaw must be a positive integer string."
      },
      { status: 400 }
    );
  }
  if (amountRaw <= 0n) {
    return NextResponse.json(
      {
        error: "amountRaw must be greater than zero."
      },
      { status: 400 }
    );
  }

  const client = createPublicClient({
    transport: http(resolveRpcUrl())
  });
  const calldata = encodeFunctionData({
    abi: WITHDRAW_ABI,
    functionName: "withdrawToWallet",
    args: [amountRaw, receiver]
  });

  const tx = {
    from: account,
    to: vaultAddress,
    data: calldata,
    value: "0x0"
  };

  try {
    const traceResult = await client.request({
      method: "debug_traceCall",
      params: [tx, "latest", {}]
    });
    const maybeRevertData = parseTraceRevertData(traceResult);
    const candidate = traceResult as { error?: unknown };
    if (candidate?.error) {
      const decoded = decodeCustomError(maybeRevertData);
      if (decoded) return NextResponse.json(decoded, { status: 200 });
      return NextResponse.json(
        {
          ok: false,
          errorName: "ExecutionReverted",
          message: "Withdraw simulation reverted for an unknown reason."
        },
        { status: 200 }
      );
    }
    return NextResponse.json({ ok: true }, { status: 200 });
  } catch {
    try {
      await client.call({
        account,
        to: vaultAddress,
        data: calldata
      });
      return NextResponse.json({ ok: true }, { status: 200 });
    } catch (callError) {
      const maybeError = callError as {
        cause?: { data?: string };
        data?: string;
      };
      const revertData = maybeError.cause?.data || maybeError.data;
      const decoded = decodeCustomError(revertData);
      if (decoded) return NextResponse.json(decoded, { status: 200 });
      return NextResponse.json(
        {
          ok: false,
          errorName: "ExecutionReverted",
          message: "Withdraw simulation reverted and RPC did not return a decodable error payload."
        },
        { status: 200 }
      );
    }
  }
}
