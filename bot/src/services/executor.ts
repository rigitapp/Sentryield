import type { StrategyAdapter } from "../adapters/adapter.interface.js";
import type {
  Address,
  Decision,
  ExecutionError,
  ExecutionResult,
  Hex,
  PoolConfig,
  PoolSnapshot,
  Position,
  StoredDecision
} from "../types.js";
import { parseAbi } from "viem";
import type { PublicClient, TransactionReceipt, WalletClient } from "viem";

const TREASURY_VAULT_ABI = parseAbi([
  "function enterPool((address target,address pool,address tokenIn,address lpToken,uint256 amountIn,uint256 minOut,uint256 deadline,bytes data,string pair,string protocol,uint16 netApyBps,uint32 intendedHoldSeconds) request) returns (uint256 lpReceived)",
  "function exitPool((address target,address pool,address lpToken,address tokenOut,uint256 amountIn,uint256 minOut,uint256 deadline,bytes data,string pair,string protocol) request) returns (uint256 amountOut)",
  "function rotate(((address target,address pool,address lpToken,address tokenOut,uint256 amountIn,uint256 minOut,uint256 deadline,bytes data,string pair,string protocol) exitRequest,(address target,address pool,address tokenIn,address lpToken,uint256 amountIn,uint256 minOut,uint256 deadline,bytes data,string pair,string protocol,uint16 netApyBps,uint32 intendedHoldSeconds) enterRequest,uint16 oldNetApyBps,uint16 newNetApyBps,uint8 reasonCode) request) returns (uint256 amountOut,uint256 lpReceived)",
  "function movementCapBps() view returns (uint16)",
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
  "error NativeTokenNotAccepted()"
]);

const ERC20_BALANCE_ABI = parseAbi([
  "function balanceOf(address account) view returns (uint256)"
]);

interface ExecutorConfig {
  vaultAddress: Address;
  vaultDepositToken: Address;
  dryRun: boolean;
  liveModeArmed: boolean;
  defaultTradeAmountRaw: bigint;
  txDeadlineSeconds: number;
  maxPriceImpactBps: number;
  minHoldSeconds: number;
  enterOnlyMode: boolean;
  maxRotationsPerDay: number;
  cooldownSeconds: number;
}

interface ExecuteInput {
  decision: Decision;
  position: Position | null;
  recentDecisions: StoredDecision[];
  snapshots: PoolSnapshot[];
  nowTs: number;
}

type VaultFunctionName = "enterPool" | "exitPool" | "rotate";

interface SimulateThenSendRequest {
  functionName: VaultFunctionName;
  args: unknown[];
}

interface SimulateThenSendResult {
  txHash: Hex | null;
  receipt: TransactionReceipt | null;
  error: ExecutionError | null;
}

export class ExecutorService {
  constructor(
    private readonly config: ExecutorConfig,
    private readonly publicClient: PublicClient,
    private readonly walletClient: WalletClient | null,
    private readonly poolById: Map<string, PoolConfig>,
    private readonly adapters: Map<string, StrategyAdapter>
  ) {}

  async execute(input: ExecuteInput): Promise<ExecutionResult | null> {
    const blocked = this.checkTrainingWheels(input);
    if (blocked) {
      return this.failed(input.decision.action, blocked, input.position);
    }

    switch (input.decision.action) {
      case "HOLD":
        return null;
      case "ENTER":
        return this.enter(input);
      case "ROTATE":
        return this.rotate(input);
      case "EXIT_TO_USDC":
        return this.exitToUsdc(input);
      default:
        return null;
    }
  }

  async getDeployableEnterAmount(tokenIn: Address): Promise<bigint> {
    return this.resolveEnterAmount(tokenIn);
  }

  private async enter(input: ExecuteInput): Promise<ExecutionResult> {
    const poolId = input.decision.chosenPoolId;
    if (!poolId) throw new Error("ENTER decision missing chosenPoolId");

    const pool = this.mustGetPool(poolId);
    const adapter = this.mustGetAdapter(pool.adapterId);
    const snapshot = input.snapshots.find((s) => s.poolId === pool.id);
    const amountIn = await this.resolveEnterAmount(pool.tokenIn);
    if (amountIn <= 0n) {
      return this.failed(
        "ENTER",
        {
          code: "POLICY_BLOCKED",
          message: "ENTER blocked: no deployable token balance available under movement caps."
        },
        input.position
      );
    }
    const deadline = BigInt(input.nowTs + this.config.txDeadlineSeconds);

    const request = await adapter.buildEnterRequest({
      pool,
      amountIn,
      minOut: this.minOut(amountIn),
      deadline,
      netApyBps: snapshot?.netApyBps ?? input.decision.newNetApyBps,
      intendedHoldSeconds: this.config.minHoldSeconds
    });

    const result = await this.simulateThenSend({
      functionName: "enterPool",
      args: [request]
    });
    if (result.error || !result.txHash) {
      return this.failed("ENTER", result.error, input.position);
    }

    const enteredAt = await this.resolveBlockTimestamp(input.nowTs, result.receipt);
    const lpBalance = await this.readVaultTokenBalance(pool.lpToken);

    return {
      action: "ENTER",
      txHashes: [result.txHash],
      updatedPosition: {
        poolId: pool.id,
        pair: pool.pair,
        protocol: pool.protocol,
        enteredAt,
        lpBalance: lpBalance.toString(),
        lastNetApyBps: snapshot?.netApyBps ?? input.decision.newNetApyBps,
        parkedToken: null
      }
    };
  }

  private async rotate(input: ExecuteInput): Promise<ExecutionResult> {
    if (!input.position?.poolId) {
      throw new Error("ROTATE decision requires an active position.");
    }
    const fromPool = this.mustGetPool(input.position.poolId);
    const toPoolId = input.decision.chosenPoolId;
    if (!toPoolId) throw new Error("ROTATE decision missing chosenPoolId");
    const toPool = this.mustGetPool(toPoolId);

    const fromAdapter = this.mustGetAdapter(fromPool.adapterId);
    const toAdapter = this.mustGetAdapter(toPool.adapterId);

    const amountIn = this.positionAmount(input.position);
    const deadline = BigInt(input.nowTs + this.config.txDeadlineSeconds);

    const exitRequest = await fromAdapter.buildExitRequest({
      pool: fromPool,
      tokenOut: toPool.tokenIn,
      amountIn,
      minOut: this.minOut(amountIn),
      deadline
    });

    const enterRequest = await toAdapter.buildEnterRequest({
      pool: toPool,
      amountIn: 0n,
      minOut: this.minOut(exitRequest.minOut),
      deadline,
      netApyBps: input.decision.newNetApyBps,
      intendedHoldSeconds: this.config.minHoldSeconds
    });

    const rotateRequest = {
      exitRequest,
      enterRequest,
      oldNetApyBps: input.decision.oldNetApyBps,
      newNetApyBps: input.decision.newNetApyBps,
      reasonCode: input.decision.reasonCode
    };

    const result = await this.simulateThenSend({
      functionName: "rotate",
      args: [rotateRequest]
    });
    if (result.error || !result.txHash) {
      return this.failed("ROTATE", result.error, input.position);
    }

    const enteredAt = await this.resolveBlockTimestamp(input.nowTs, result.receipt);
    const lpBalance = await this.readVaultTokenBalance(toPool.lpToken);

    return {
      action: "ROTATE",
      txHashes: [result.txHash],
      updatedPosition: {
        poolId: toPool.id,
        pair: toPool.pair,
        protocol: toPool.protocol,
        enteredAt,
        lpBalance: lpBalance.toString(),
        lastNetApyBps: input.decision.newNetApyBps,
        parkedToken: null
      }
    };
  }

  private async exitToUsdc(input: ExecuteInput): Promise<ExecutionResult> {
    if (!input.position?.poolId) {
      throw new Error("EXIT_TO_USDC decision requires an active position.");
    }

    const fromPool = this.mustGetPool(input.position.poolId);
    const fromAdapter = this.mustGetAdapter(fromPool.adapterId);
    const requestedAmountIn = this.positionAmount(input.position);
    const amountIn = await this.resolveCappedAmount(fromPool.lpToken, requestedAmountIn);
    if (amountIn <= 0n) {
      return this.failed(
        "EXIT_TO_USDC",
        {
          code: "POLICY_BLOCKED",
          message: "Exit blocked: no deployable LP balance available under movement caps."
        },
        input.position
      );
    }
    const deadline = BigInt(input.nowTs + this.config.txDeadlineSeconds);

    const exitRequest = await fromAdapter.buildExitRequest({
      pool: fromPool,
      tokenOut: this.config.vaultDepositToken,
      amountIn,
      minOut: this.minOut(amountIn),
      deadline
    });

    const result = await this.simulateThenSend({
      functionName: "exitPool",
      args: [exitRequest]
    });
    if (result.error || !result.txHash) {
      return this.failed("EXIT_TO_USDC", result.error, input.position);
    }

    const remainingLpBalance = await this.readVaultTokenBalance(fromPool.lpToken);
    if (remainingLpBalance > 0n) {
      return {
        action: "EXIT_TO_USDC",
        txHashes: [result.txHash],
        updatedPosition: {
          poolId: fromPool.id,
          pair: fromPool.pair,
          protocol: fromPool.protocol,
          enteredAt: input.position.enteredAt,
          lpBalance: remainingLpBalance.toString(),
          lastNetApyBps: input.position.lastNetApyBps,
          parkedToken: null
        }
      };
    }

    return {
      action: "EXIT_TO_USDC",
      txHashes: [result.txHash],
      updatedPosition: {
        poolId: null,
        pair: null,
        protocol: null,
        enteredAt: null,
        lpBalance: "0",
        lastNetApyBps: 0,
        parkedToken: "USDC"
      }
    };
  }

  private minOut(amountIn: bigint): bigint {
    const numerator = BigInt(10_000 - this.config.maxPriceImpactBps);
    const minOut = (amountIn * numerator) / 10_000n;
    return minOut > 0n ? minOut : 1n;
  }

  private positionAmount(position: Position): bigint {
    const parsed = BigInt(position.lpBalance || "0");
    if (parsed > 0n) return parsed;
    return this.config.defaultTradeAmountRaw;
  }

  private mustGetPool(poolId: string): PoolConfig {
    const pool = this.poolById.get(poolId);
    if (!pool) throw new Error(`Missing pool config: ${poolId}`);
    return pool;
  }

  private mustGetAdapter(adapterId: string): StrategyAdapter {
    const adapter = this.adapters.get(adapterId);
    if (!adapter) throw new Error(`Missing adapter: ${adapterId}`);
    return adapter;
  }

  private checkTrainingWheels(input: ExecuteInput): ExecutionError | null {
    if (input.decision.action !== "ROTATE" || input.decision.emergency) {
      return null;
    }

    if (this.config.enterOnlyMode) {
      return {
        code: "POLICY_BLOCKED",
        message: "ENTER_ONLY mode is enabled; rotation blocked."
      };
    }

    const dayAgo = input.nowTs - 24 * 60 * 60;
    const recentRotations = input.recentDecisions
      .filter((decision) => decision.action === "ROTATE" && decision.timestamp >= dayAgo)
      .sort((a, b) => b.timestamp - a.timestamp);

    if (recentRotations.length >= this.config.maxRotationsPerDay) {
      return {
        code: "POLICY_BLOCKED",
        message: `Rotation limit reached: ${recentRotations.length}/${this.config.maxRotationsPerDay} in last 24h.`
      };
    }

    const latestRotation = recentRotations[0];
    if (
      latestRotation &&
      this.config.cooldownSeconds > 0 &&
      input.nowTs - latestRotation.timestamp < this.config.cooldownSeconds
    ) {
      return {
        code: "POLICY_BLOCKED",
        message: `Rotation cooldown active (${this.config.cooldownSeconds}s).`
      };
    }

    return null;
  }

  private failed(
    action: ExecutionResult["action"],
    error: ExecutionError | null,
    currentPosition: Position | null
  ): ExecutionResult {
    return {
      action,
      txHashes: [],
      updatedPosition: currentPosition,
      error:
        error ??
        ({
          code: "CONFIG_ERROR",
          message: "Unknown execution failure."
        } satisfies ExecutionError)
    };
  }

  private async simulateThenSend(
    txRequest: SimulateThenSendRequest
  ): Promise<SimulateThenSendResult> {
    if (this.config.dryRun) {
      const synthetic = Date.now().toString(16).padStart(64, "0");
      return {
        txHash: `0x${synthetic}` as Hex,
        receipt: null,
        error: null
      };
    }

    if (!this.walletClient?.account) {
      return {
        txHash: null,
        receipt: null,
        error: {
          code: "CONFIG_ERROR",
          message: "Wallet client/account is required when DRY_RUN=false."
        }
      };
    }

    // Safety interlock: allow live simulations but block all broadcasts
    // until explicitly armed.
    if (!this.config.liveModeArmed) {
      try {
        await this.publicClient.simulateContract({
          account: this.walletClient.account,
          address: this.config.vaultAddress,
          abi: TREASURY_VAULT_ABI,
          functionName: txRequest.functionName,
          args: txRequest.args
        } as never);
      } catch (error) {
        return {
          txHash: null,
          receipt: null,
          error: {
            code: "SIMULATION_FAILED",
            message: `Simulation failed for ${txRequest.functionName}.`,
            details: this.toErrorMessage(error)
          }
        };
      }

      return {
        txHash: null,
        receipt: null,
        error: {
          code: "POLICY_BLOCKED",
          message:
            "LIVE_MODE_ARMED=false; simulation passed but transaction broadcast is blocked."
        }
      };
    }

    let simulatedRequest: unknown;
    try {
      const simulation = await this.publicClient.simulateContract({
        account: this.walletClient.account,
        address: this.config.vaultAddress,
        abi: TREASURY_VAULT_ABI,
        functionName: txRequest.functionName,
        args: txRequest.args
      } as never);
      simulatedRequest = simulation.request;
    } catch (error) {
      return {
        txHash: null,
        receipt: null,
        error: {
          code: "SIMULATION_FAILED",
          message: `Simulation failed for ${txRequest.functionName}.`,
          details: this.toErrorMessage(error)
        }
      };
    }

    try {
      const hash = await this.walletClient.writeContract(simulatedRequest as never);
      const receipt = await this.publicClient.waitForTransactionReceipt({ hash });
      return { txHash: hash, receipt, error: null };
    } catch (error) {
      return {
        txHash: null,
        receipt: null,
        error: {
          code: "SEND_FAILED",
          message: `Transaction broadcast failed for ${txRequest.functionName}.`,
          details: this.toErrorMessage(error)
        }
      };
    }
  }

  private async readVaultTokenBalance(token: Address): Promise<bigint> {
    try {
      return await this.publicClient.readContract({
        address: token,
        abi: ERC20_BALANCE_ABI,
        functionName: "balanceOf",
        args: [this.config.vaultAddress]
      });
    } catch {
      return 0n;
    }
  }

  private async readVaultMovementCapBps(): Promise<number> {
    try {
      const cap = await this.publicClient.readContract({
        address: this.config.vaultAddress,
        abi: TREASURY_VAULT_ABI,
        functionName: "movementCapBps"
      });
      const parsed = Number(cap);
      if (Number.isFinite(parsed) && parsed > 0 && parsed <= 10_000) {
        return parsed;
      }
      return 10_000;
    } catch {
      return 10_000;
    }
  }

  private async resolveEnterAmount(tokenIn: Address): Promise<bigint> {
    return this.resolveCappedAmount(tokenIn, this.config.defaultTradeAmountRaw);
  }

  private async resolveCappedAmount(token: Address, requestedAmount: bigint): Promise<bigint> {
    const balance = await this.readVaultTokenBalance(token);
    if (balance <= 0n) return 0n;

    const movementCapBps = await this.readVaultMovementCapBps();
    const movementCapAmount = (balance * BigInt(movementCapBps)) / 10_000n;
    const allowedByRails = movementCapAmount > 0n ? movementCapAmount : balance;

    const desired = requestedAmount > 0n ? requestedAmount : balance;
    const amount = desired < allowedByRails ? desired : allowedByRails;
    return amount <= balance ? amount : balance;
  }

  private async resolveBlockTimestamp(
    fallbackTimestamp: number,
    receipt: TransactionReceipt | null
  ): Promise<number> {
    if (!receipt) return fallbackTimestamp;
    try {
      const block = await this.publicClient.getBlock({ blockNumber: receipt.blockNumber });
      return Number(block.timestamp);
    } catch {
      return fallbackTimestamp;
    }
  }

  private toErrorMessage(error: unknown): string {
    if (error instanceof Error) return error.message;
    if (typeof error === "string") return error;
    return JSON.stringify(error);
  }
}
