import {
  createPublicClient,
  getAddress,
  http,
  isAddress,
  keccak256,
  parseAbi,
  stringToHex
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { POOLS, POLICY, RUNTIME, TOKENS } from "./config.js";
import type { Address } from "./types.js";

type CheckStatus = "PASS" | "WARN" | "FAIL";

interface CheckResult {
  id: string;
  status: CheckStatus;
  detail: string;
}

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const EXECUTOR_ROLE = keccak256(stringToHex("EXECUTOR_ROLE"));

const VAULT_ABI = parseAbi([
  "function hasRole(bytes32 role,address account) view returns (bool)",
  "function paused() view returns (bool)",
  "function executor() view returns (address)",
  "function movementCapBps() view returns (uint16)",
  "function dailyMovementCapBps() view returns (uint16)",
  "function maxDeadlineDelay() view returns (uint32)",
  "function tokenAllowlist(address token) view returns (bool)",
  "function targetAllowlist(address target) view returns (bool)",
  "function poolAllowlist(address pool) view returns (bool)"
]);

const ERC20_ABI = parseAbi([
  "function balanceOf(address account) view returns (uint256)"
]);

function push(
  results: CheckResult[],
  id: string,
  status: CheckStatus,
  detail: string
): void {
  results.push({ id, status, detail });
}

function isZeroAddress(value: string): boolean {
  return value.toLowerCase() === ZERO_ADDRESS;
}

async function main(): Promise<void> {
  const results: CheckResult[] = [];

  if (RUNTIME.dryRun) {
    push(
      results,
      "mode.dry_run",
      "FAIL",
      "DRY_RUN=true. Set DRY_RUN=false for live execution mode."
    );
  } else {
    push(results, "mode.dry_run", "PASS", "DRY_RUN=false (live execution mode).");
  }

  if (RUNTIME.liveModeArmed) {
    push(
      results,
      "mode.live_mode_armed",
      "WARN",
      "LIVE_MODE_ARMED=true. Broadcasts are enabled; disarm before preflight-only checks."
    );
  } else {
    push(
      results,
      "mode.live_mode_armed",
      "PASS",
      "LIVE_MODE_ARMED=false (guarded mode, no broadcasts)."
    );
  }

  if (!RUNTIME.executorPrivateKey) {
    push(
      results,
      "executor.private_key",
      "FAIL",
      "BOT_EXECUTOR_PRIVATE_KEY is missing."
    );
    printReport(results);
    process.exitCode = 1;
    return;
  }

  const executorAccount = privateKeyToAccount(RUNTIME.executorPrivateKey);
  push(
    results,
    "executor.account",
    "PASS",
    `Executor signer loaded: ${executorAccount.address}`
  );

  const configuredExecutorAddress = (process.env.EXECUTOR_ADDRESS ?? "").trim();
  if (configuredExecutorAddress) {
    if (!isAddress(configuredExecutorAddress)) {
      push(
        results,
        "executor.address_format",
        "FAIL",
        "EXECUTOR_ADDRESS is not a valid EVM address."
      );
    } else if (
      getAddress(configuredExecutorAddress) !== getAddress(executorAccount.address)
    ) {
      push(
        results,
        "executor.address_match",
        "FAIL",
        "BOT_EXECUTOR_PRIVATE_KEY does not match EXECUTOR_ADDRESS."
      );
    } else {
      push(
        results,
        "executor.address_match",
        "PASS",
        "BOT_EXECUTOR_PRIVATE_KEY matches EXECUTOR_ADDRESS."
      );
    }
  } else {
    push(
      results,
      "executor.address_match",
      "WARN",
      "EXECUTOR_ADDRESS is not set; key/address match cannot be asserted."
    );
  }

  if (isZeroAddress(RUNTIME.vaultAddress)) {
    push(results, "vault.address", "FAIL", "VAULT_ADDRESS is zero address.");
    printReport(results);
    process.exitCode = 1;
    return;
  }

  const client = createPublicClient({
    transport: http(RUNTIME.rpcUrl)
  });

  try {
    const connectedChainId = await client.getChainId();
    if (connectedChainId === RUNTIME.chainId) {
      push(
        results,
        "rpc.chain_id",
        "PASS",
        `RPC reachable. chainId=${connectedChainId}`
      );
    } else {
      push(
        results,
        "rpc.chain_id",
        "FAIL",
        `RPC chain mismatch. expected=${RUNTIME.chainId}, actual=${connectedChainId}`
      );
    }
  } catch (error) {
    push(
      results,
      "rpc.chain_id",
      "FAIL",
      `RPC check failed: ${toErrorMessage(error)}`
    );
    printReport(results);
    process.exitCode = 1;
    return;
  }

  await checkCodeExists(results, client, "vault.code", RUNTIME.vaultAddress, "Vault");

  for (const pool of POOLS) {
    await checkCodeExists(
      results,
      client,
      `pool.${pool.id}.adapter_code`,
      pool.target,
      `${pool.id} target adapter`
    );
    await checkCodeExists(
      results,
      client,
      `pool.${pool.id}.pool_code`,
      pool.pool,
      `${pool.id} pool`
    );
    await checkCodeExists(
      results,
      client,
      `pool.${pool.id}.token_in_code`,
      pool.tokenIn,
      `${pool.id} tokenIn`
    );
    await checkCodeExists(
      results,
      client,
      `pool.${pool.id}.lp_token_code`,
      pool.lpToken,
      `${pool.id} lpToken`
    );
  }

  try {
    const paused = await client.readContract({
      address: RUNTIME.vaultAddress,
      abi: VAULT_ABI,
      functionName: "paused"
    });
    push(
      results,
      "vault.paused",
      paused ? "FAIL" : "PASS",
      paused ? "Vault is paused." : "Vault is unpaused."
    );
  } catch (error) {
    push(
      results,
      "vault.paused",
      "FAIL",
      `Failed to read paused(): ${toErrorMessage(error)}`
    );
  }

  try {
    const hasExecutorRole = await client.readContract({
      address: RUNTIME.vaultAddress,
      abi: VAULT_ABI,
      functionName: "hasRole",
      args: [EXECUTOR_ROLE, executorAccount.address]
    });
    push(
      results,
      "vault.executor_role",
      hasExecutorRole ? "PASS" : "FAIL",
      hasExecutorRole
        ? "Executor signer has EXECUTOR_ROLE."
        : "Executor signer does not have EXECUTOR_ROLE."
    );
  } catch (error) {
    push(
      results,
      "vault.executor_role",
      "FAIL",
      `Failed to read hasRole(EXECUTOR_ROLE): ${toErrorMessage(error)}`
    );
  }

  try {
    const configuredExecutor = await client.readContract({
      address: RUNTIME.vaultAddress,
      abi: VAULT_ABI,
      functionName: "executor"
    });
    const isMatch =
      getAddress(configuredExecutor as Address) === getAddress(executorAccount.address);
    push(
      results,
      "vault.executor_slot",
      isMatch ? "PASS" : "WARN",
      isMatch
        ? "Vault.executor matches bot signer."
        : "Vault.executor differs from bot signer (role may still permit execution)."
    );
  } catch (error) {
    push(
      results,
      "vault.executor_slot",
      "WARN",
      `Failed to read vault.executor: ${toErrorMessage(error)}`
    );
  }

  try {
    const [movementCapBps, dailyMovementCapBps, maxDeadlineDelay] = await Promise.all([
      client.readContract({
        address: RUNTIME.vaultAddress,
        abi: VAULT_ABI,
        functionName: "movementCapBps"
      }),
      client.readContract({
        address: RUNTIME.vaultAddress,
        abi: VAULT_ABI,
        functionName: "dailyMovementCapBps"
      }),
      client.readContract({
        address: RUNTIME.vaultAddress,
        abi: VAULT_ABI,
        functionName: "maxDeadlineDelay"
      })
    ]);

    push(
      results,
      "vault.movement_cap",
      Number(movementCapBps) > 0 ? "PASS" : "FAIL",
      `movementCapBps=${movementCapBps}`
    );
    push(
      results,
      "vault.daily_movement_cap",
      "PASS",
      `dailyMovementCapBps=${dailyMovementCapBps}`
    );
    push(
      results,
      "vault.deadline_window",
      Number(maxDeadlineDelay) >= POLICY.txDeadlineSeconds ? "PASS" : "FAIL",
      `maxDeadlineDelay=${maxDeadlineDelay}s, bot tx deadline=${POLICY.txDeadlineSeconds}s`
    );
  } catch (error) {
    push(
      results,
      "vault.rails",
      "FAIL",
      `Failed to read vault rail settings: ${toErrorMessage(error)}`
    );
  }

  for (const pool of POOLS) {
    await checkAllowlist(
      results,
      client,
      `allowlist.token.${pool.id}.tokenIn`,
      "tokenAllowlist",
      pool.tokenIn
    );
    await checkAllowlist(
      results,
      client,
      `allowlist.token.${pool.id}.lpToken`,
      "tokenAllowlist",
      pool.lpToken
    );
    await checkAllowlist(
      results,
      client,
      `allowlist.target.${pool.id}.adapter`,
      "targetAllowlist",
      pool.target
    );
    await checkAllowlist(
      results,
      client,
      `allowlist.target.${pool.id}.pool`,
      "targetAllowlist",
      pool.pool
    );
    await checkAllowlist(
      results,
      client,
      `allowlist.pool.${pool.id}.pool`,
      "poolAllowlist",
      pool.pool
    );
  }

  try {
    const usdcBalance = await client.readContract({
      address: TOKENS.USDC,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [RUNTIME.vaultAddress]
    });
    push(
      results,
      "vault.usdc_balance",
      usdcBalance > 0n ? "PASS" : "WARN",
      `Vault USDC balance: ${usdcBalance}`
    );
  } catch (error) {
    push(
      results,
      "vault.usdc_balance",
      "WARN",
      `Failed to read USDC balance: ${toErrorMessage(error)}`
    );
  }

  printReport(results);

  const hasFailure = results.some((result) => result.status === "FAIL");
  if (hasFailure) {
    process.exitCode = 1;
    return;
  }

  if (!RUNTIME.liveModeArmed) {
    console.log(
      "\nNext step: keep monitoring in guarded mode, then set LIVE_MODE_ARMED=true only after explicit approval."
    );
  }
}

async function checkCodeExists(
  results: CheckResult[],
  client: ReturnType<typeof createPublicClient>,
  id: string,
  address: Address,
  label: string
): Promise<void> {
  try {
    const code = await client.getCode({ address });
    const exists = Boolean(code && code !== "0x");
    push(
      results,
      id,
      exists ? "PASS" : "FAIL",
      exists ? `${label} has deployed bytecode.` : `${label} has no bytecode.`
    );
  } catch (error) {
    push(results, id, "FAIL", `${label} code check failed: ${toErrorMessage(error)}`);
  }
}

async function checkAllowlist(
  results: CheckResult[],
  client: ReturnType<typeof createPublicClient>,
  id: string,
  functionName: "tokenAllowlist" | "targetAllowlist" | "poolAllowlist",
  address: Address
): Promise<void> {
  try {
    const allowed = await client.readContract({
      address: RUNTIME.vaultAddress,
      abi: VAULT_ABI,
      functionName,
      args: [address]
    });
    push(
      results,
      id,
      allowed ? "PASS" : "FAIL",
      `${functionName}(${address}) => ${allowed}`
    );
  } catch (error) {
    push(results, id, "FAIL", `${functionName} read failed: ${toErrorMessage(error)}`);
  }
}

function printReport(results: CheckResult[]): void {
  console.log("=== Sentryield Go-Live Preflight (read-only) ===");
  for (const result of results) {
    console.log(`${result.status.padEnd(4)} | ${result.id} | ${result.detail}`);
  }

  const summary = {
    pass: results.filter((result) => result.status === "PASS").length,
    warn: results.filter((result) => result.status === "WARN").length,
    fail: results.filter((result) => result.status === "FAIL").length
  };
  console.log(
    `--- Summary: PASS=${summary.pass}, WARN=${summary.warn}, FAIL=${summary.fail} ---`
  );
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return JSON.stringify(error);
}

void main();
