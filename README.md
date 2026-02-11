# Sentryield v1 Go-Live (Monad + Curvance)

Sentryield v1 is now wired for a **single live strategy**:

- **Capital:** one treasury Vault
- **Protocol:** Curvance only
- **Market:** Curvance USDC market only
- **Strategy label:** `USDC/MON` (reporting label), but funds are supplied as USDC

## Sources used for live interface/address selection

References used while wiring this release:

- Curvance docs: **Protocol Overview -> Contract Addresses** (Monad Mainnet addresses)
- Curvance docs: **Developer Docs -> Quick Start Guides -> Integration Cookbook**
- Curvance docs: **Developer Docs -> Lending Protocol -> cToken**
- Monad docs: **Developer Essentials -> Network Information - Mainnet**
- Monad ecosystem repo: `monad-crypto/protocols` mainnet files (`Curvance.jsonc`, `Circle_USDC.json`, `CANONICAL.jsonc`)

## Address config (single source of truth)

- Onchain: `onchain/config/curvance.monad.mainnet.json`
- Bot: `bot/config/curvance.monad.mainnet.json`

Both files intentionally contain identical address payload:

- chain/network metadata
- USDC + WMON token addresses
- Curvance central registry
- Curvance USDC market (`cUSDC`) + controller

## What changed for go-live

### Onchain

- Real Curvance-style adapter surface in `onchain/contracts/adapters/CurvanceTargetAdapter.sol`
  - uses cToken `deposit(assets, receiver)` and `redeem(shares, receiver, owner)`
  - enforces `deadline`, `amountIn > 0`, `minOut` (via previews + post-check)
  - zeroes approvals after deposit path
- Vault hardening in `onchain/contracts/TreasuryVault.sol`
  - `poolAllowlist` + `setPoolAllowlist`
  - optional global rolling 24h movement budget:
    - `dailyMovementCapBps` (0 disables)
    - tracked via `dailyMovementWindowStart` and `dailyMovementBpsUsed`
- Tests updated and expanded:
  - rails: token/target/pool allowlist, pause, per-tx cap, daily cap, deadline, slippage, roles
  - call path: enter / exit / rotate
- Rehearsal script added:
  - `onchain/scripts/rehearsal-fork.ts`
  - runs: enter -> exit -> simulated bad minOut failure (nonce unchanged, no broadcast)

### Bot

- Bot config now reads the Curvance mainnet JSON file and uses one pool only.
- Curvance adapter added: `bot/src/adapters/curvance.adapter.ts`
- Executor correctness fixes:
  - rotate enter `minOut` is now derived from expected exit proceeds (no `minOut=1`)
  - position size after tx uses on-chain `balanceOf(vault)` for receipt token
  - `enteredAt` resolves from mined block timestamp when available
- Training wheels mode added in execution stage:
  - `ENTER_ONLY=true` blocks rotations (emergency exits still allowed)
  - `MAX_ROTATIONS_PER_DAY`
  - `COOLDOWN_SECONDS` between rotations (unless emergency)

## Go-live steps

1. Fill `.env` from `.env.example`.
2. Deploy Curvance adapter contract.
3. Set `CURVANCE_TARGET_ADAPTER_ADDRESS` in `.env`.
4. Deploy Vault via `onchain/scripts/deploy.ts`.
5. Verify allowlists on Vault:
   - token allowlist includes USDC + receipt token
   - target allowlist includes adapter + Curvance market
   - pool allowlist includes Curvance market
6. Run fork rehearsal script before live bot execution.
7. Start bot with training wheels first.

### Guarded live mode (recommended)

To prevent accidental mainnet broadcasts while validating readiness:

- set `DRY_RUN=false`
- keep `LIVE_MODE_ARMED=false` (broadcast block enabled)
- run bot preflight checks:

```bash
cd bot
npm run preflight
```

Only after preflight passes and you explicitly approve broadcast, set:

- `LIVE_MODE_ARMED=true`

## Commands

### Onchain build + tests

```bash
cd onchain
npm install
npm run build
npm run test
```

### Fork rehearsal

```bash
cd onchain
cp ../.env.example ../.env
# set FORK_MONAD=true and MONAD_RPC_URL
# optionally set FORK_USDC_WHALE for real forked USDC funding
npm run rehearsal:fork
```

### Bot dry run

```bash
cd bot
npm install
cp ../.env.example ../.env
# DRY_RUN=true
# RUN_ONCE=true
npm run dev
```

### Bot live mode

```bash
cd bot
# DRY_RUN=false
# LIVE_MODE_ARMED=false   # guarded live mode (no broadcasts)
# VAULT_ADDRESS=<deployed vault>
# CURVANCE_TARGET_ADAPTER_ADDRESS=<deployed adapter>
# BOT_EXECUTOR_PRIVATE_KEY=<executor key>
npm run dev
```

## Mainnet checklist

- Curvance config JSON matches current official addresses.
- `CURVANCE_TARGET_ADAPTER_ADDRESS` set and allowlisted in Vault.
- Vault roles split correctly (`OWNER`, `EXECUTOR`, `GUARDIAN`).
- `movementCapBps` and optional `dailyMovementCapBps` reviewed.
- Rehearsal script passes on fork (including simulated bad `minOut` no-broadcast behavior).
- Bot starts in training wheels mode (`ENTER_ONLY=true`) for initial monitoring window.
- Alerting/observability enabled for failed simulations, pauses, and execution errors.
- Private keys stored in secure secret manager (not plaintext files).

## True Live Test Runbook (UI deposit + broadcast)

1. Set bot to guarded live mode first:
   - `DRY_RUN=false`
   - `LIVE_MODE_ARMED=false`
2. Run read-only preflight:
   - `cd bot && npm run preflight`
3. Start UI + bot loop:
   - `cd . && npm run dev`
   - `cd bot && npm run dev`
4. From UI:
   - connect wallet (Injected / Coinbase / WalletConnect)
   - switch to Monad chain
   - use **Deposit USDC To Vault** card to transfer USDC to `VAULT_ADDRESS`
5. Optional clean-cycle reset (backs up old state first):
   - `cd bot && npm run reset-state`
6. Re-run preflight and confirm `vault.usdc_balance` is non-zero.
7. Run one controlled armed cycle (no permanent `.env` edits needed):
   - `cd bot && npm run live-broadcast-once`
9. Verify real transaction hash on Monadscan and in dashboard history.
