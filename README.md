# Sentryield v1 Go-Live (Monad + Curvance)

Sentryield v1 is now wired around a **single deposit token per vault** and supports
multi-protocol pool routing per token:

- **Capital:** one `TreasuryVault` per deposit token (USDC, AUSD, shMON, kMON, ...)
- **Protocols:** Curvance, Morpho, Gearbox, TownSquare, Neverland (env-gated)
- **Execution model:** one bot runtime per vault/deposit token
- **Strategy labels:** pair labels are reporting metadata; execution uses each pool `tokenIn`

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
  - user wallet flow for the configured vault deposit token:
    - `depositUsdc(uint256)` (share-accounted deposit)
    - `withdrawToWallet(uint256,address)` (redeem deposit token back to wallet)
    - withdrawals are blocked while LP positions are open; first deposit requires an empty vault balance for that token
- Tests updated and expanded:
  - rails: token/target/pool allowlist, pause, per-tx cap, daily cap, deadline, slippage, roles
  - call path: enter / exit / rotate
- Rehearsal script added:
  - `onchain/scripts/rehearsal-fork.ts`
  - runs: enter -> exit -> simulated bad minOut failure (nonce unchanged, no broadcast)
- Additional ERC4626-style target adapters added:
  - `MorphoTargetAdapter`
  - `GearboxTargetAdapter`
  - `TownSquareTargetAdapter`
  - `NeverlandTargetAdapter`
  - deploy via `TARGET_ADAPTER_CONTRACT=<name> npm run deploy:adapter:monad`

### Bot

- Bot config reads the Curvance/Monad chain config JSON and supports env-driven
  pools across multiple protocols/pairs (disabled by default).
- Curvance adapter added: `bot/src/adapters/curvance.adapter.ts`
- Executor correctness fixes:
  - rotate enter `minOut` is now derived from expected exit proceeds (no `minOut=1`)
  - position size after tx uses on-chain `balanceOf(vault)` for receipt token
  - `enteredAt` resolves from mined block timestamp when available
- Training wheels mode added in execution stage:
  - `ENTER_ONLY=true` blocks rotations (emergency exits still allowed)
  - `MAX_ROTATIONS_PER_DAY`
  - `COOLDOWN_SECONDS` between rotations (unless emergency)
- Live data hardening:
  - no `pool.mock` fallbacks in runtime paths
  - scanner/adapters fail closed if onchain reads or quotes fail
  - price inputs come from live CoinGecko fetches (`STABLE_PRICE_SYMBOLS`, `COINGECKO_ID_*`)
- Multi-protocol expansion:
  - added adapter paths:
    - ERC4626 for `morpho`, `gearbox`, `townsquare`
    - Aave-style pool adapter for `neverland`
  - pools are env-driven and **disabled by default**
  - preflight checks only enabled pools
  - base APY auto-update:
    - Curvance via onchain protocol reader
    - Morpho via GraphQL vault API
    - ERC4626 protocols (Gearbox/TownSquare) via onchain share-price lookback
    - Neverland via reserve `currentLiquidityRate` (onchain pool read)

## Go-live steps

1. Fill `.env` from `.env.example`.
2. Deploy Curvance adapter contract.
3. Set `CURVANCE_TARGET_ADAPTER_ADDRESS` in `.env`.
4. Deploy Vault via `onchain/scripts/deploy.ts`.
   - for non-USDC vaults, set `VAULT_DEPLOY_DEPOSIT_TOKEN_ADDRESS` (and optional `VAULT_DEPLOY_DEPOSIT_TOKEN_SYMBOL`) before `npm run deploy:monad`
   - recommended: keep `DEPLOY_BOOTSTRAP_ALLOWLIST=false` and configure allowlists via owner/multisig scripts
5. Verify allowlists on Vault:
   - token allowlist includes USDC + receipt token
   - target allowlist includes adapter + Curvance market
   - pool allowlist includes Curvance market
6. Run fork rehearsal script before live bot execution.
7. Start bot with training wheels first.

### If OWNER is a multisig

- `configure:vault:monad` requires a signer with `OWNER_ROLE` and is not suitable for multisig-only owners.
- Generate multisig calldata plan instead:

```bash
cd onchain
npm run prepare:configure:vault:multisig:monad
```

- Execute generated transactions in your Safe/multisig UI (same order), then re-run the command to confirm no remaining actions.

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

### Deploy protocol adapter

```bash
cd onchain
# example
TARGET_ADAPTER_CONTRACT=MorphoTargetAdapter npm run deploy:adapter:monad
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

### Migration report (old/new vault cutover)

```bash
cd bot
# set MIGRATION_OLD_VAULT_ADDRESS + MIGRATION_NEW_VAULT_ADDRESS (+ optional state URLs)
npm run migration:report
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

## Enabling an additional protocol (safe rollout)

1. Deploy protocol target adapter contract:
   - `TARGET_ADAPTER_CONTRACT=<ProtocolTargetAdapter> npm run deploy:adapter:monad`
2. Set protocol env vars in bot runtime (addresses + APY params), keep `<PROTOCOL>_ENABLED=false`.
3. Add adapter/pool/pool-target addresses to vault allowlists (owner/multisig flow).
   - allowlist scripts read protocol env keys (`*_TOKEN_IN_ADDRESS`, `*_LP_TOKEN_ADDRESS`, `*_TARGET_ADAPTER_ADDRESS`, `*_POOL_ADDRESS`)
   - use `ALLOWLIST_INCLUDE_CURVANCE_DEFAULTS=false` for non-Curvance-only vault profiles if desired
   - keep least-privilege by default (`ALLOWLIST_INCLUDE_DISABLED_POOL_CONFIGS=false`) and use `ALLOWLIST_POOL_KEYS` to pre-allowlist specific disabled pools
   - for strict per-profile plans, set `ALLOWLIST_ONLY_POOL_KEYS=true`
   - optional batch generator for token vaults: `cd onchain && npm run prepare:configure:vault:rollout:monad`
4. Run `cd bot && npm run preflight` and confirm no FAILs.
5. Set `<PROTOCOL>_ENABLED=true` for one protocol only.
6. Keep `LIVE_MODE_ARMED=false` for first cycle validation.
7. Verify snapshots/decision quality, then arm live mode.

Known Monad discovery (current):
- Neverland pool `0x80F00661b13CC5F6ccd3885bE7b4C9c67545D585` lists reserves including `USDC`, `AUSD`, `shMON`; `kMON` was not detected in reserve list.
- Gearbox Monad pool addresses remain unset until verified deployments are available.
- Vault-per-token rollout runbook: `docs/vault-rollout-checklist.md`.

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
  - use **Deposit <vault token> To Vault** card
  - if prompted, approve the vault token then confirm deposit
  - if LP is active, UI auto-queues exit and continues deposit/withdraw when parked
5. Optional clean-cycle reset (backs up old state first):
   - `cd bot && npm run reset-state`
6. Re-run preflight and confirm `vault.deposit_token_balance` is non-zero.
7. Run one controlled armed cycle (no permanent `.env` edits needed):
   - `cd bot && npm run live-broadcast-once`
8. Verify real transaction hash on Monadscan and in dashboard history.
9. Optional dashboard aggregate metrics:
   - set `VAULT_ADDRESSES=<comma-separated vault addresses>`
   - UI Agent Activity card shows `Total Deposits` and `Liquidity / TVL` in USD across those vaults.

## Vault upgrade note (withdraw UX)

- The upgraded `TreasuryVault` constructor now includes a 6th argument: `depositToken` (your vault asset).
- If you are on an older vault deployment, redeploy vault + update `VAULT_ADDRESS` before using wallet withdrawals.
- Legacy vaults still support direct transfer deposits, but redeem-to-wallet is unavailable until upgrade.
- Single-vault limitation: one `TreasuryVault` can only support one `depositToken` at a time. To run USDC + AUSD + shMON + kMON simultaneously, deploy one vault per token.
- Recommended production architecture today: keep one vault + one bot runtime per token; treat a true multi-asset vault as a separate v2/v3 contract project.
- Full blue/green migration guide: `docs/migration-playbook.md`.
- V3 design for true anytime liquidity UX: `docs/vault-v3-anytime-liquidity.md`.

## Vercel notes (important)

- `Source: empty state` on Vercel usually means no bot state is mounted in the serverless runtime.
- Run the bot in loop mode (`RUN_ONCE=false`) and enable the built-in status server:
  - `BOT_STATUS_SERVER_ENABLED=true`
  - optional strict mode: `BOT_STATUS_SERVER_REQUIRED=true` (bot exits if health port cannot bind)
  - `BOT_STATUS_HOST=0.0.0.0`
  - `BOT_STATUS_PORT=8787`
  - optional hardening: `BOT_STATUS_AUTH_TOKEN=<secret>`
- Bot endpoints:
  - `/healthz` => liveness heartbeat (200 healthy, 503 stale/stuck)
  - `/readyz` => readiness after first successful tick
  - `/state` => `{ healthy, ready, runtime, state }` and returns 503 if unhealthy
- For hosted UI + separate bot process, point Next to the bot status endpoint:
  - `BOT_STATE_URL=https://<your-bot-domain>/state`
  - if protected: `BOT_STATE_AUTH_TOKEN=<same secret as BOT_STATUS_AUTH_TOKEN>`
- Single-project multi-token dashboards are supported:
  - `/usdc` reads `BOT_STATE_URL_USDC` (+ optional `BOT_STATE_AUTH_TOKEN_USDC`)
  - `/ausd` reads `BOT_STATE_URL_AUSD` (+ optional `BOT_STATE_AUTH_TOKEN_AUSD`)
  - `/shmon` reads `BOT_STATE_URL_SHMON` (+ optional `BOT_STATE_AUTH_TOKEN_SHMON`)
  - each route falls back to `BOT_STATE_URL` / `BOT_STATE_AUTH_TOKEN` when profile-specific vars are unset
- Next dashboard accepts remote state from `/state` only when `healthy=true` and `ready=true`.
- `NEXT_PUBLIC_*` values (including `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID`) are embedded at build time. After changing them in Vercel, you must redeploy.
- WalletConnect can still fail if the project settings do not allow your deployed domain; confirm your Vercel domain is approved in WalletConnect Cloud.

## Railway bot deploy

Deploy the bot as a separate Railway service (Vercel should host UI only).

1. Create a new Railway service from this repo.
2. Preferred setup:
   - keep service at repo root (default)
   - use root `railway.json` + `nixpacks.toml` (already configured to build/run `bot/`)
   - this avoids root `pnpm-lock.yaml` install issues by forcing `cd bot && npm ci`
3. Alternative setup:
   - set **Root Directory** to `bot` and use `bot/railway.json`
   - if Railway still selects pnpm, clear the builder cache and redeploy
4. Configure bot env vars on Railway:
   - required runtime: `MONAD_RPC_URL`, `MONAD_CHAIN_ID`, `VAULT_ADDRESS`, `CURVANCE_TARGET_ADAPTER_ADDRESS`, `BOT_EXECUTOR_PRIVATE_KEY`
   - for non-USDC vault runtimes, set `CURVANCE_ENABLED=false` unless that runtime is intentionally using the USDC Curvance market
   - mode flags: `DRY_RUN=false`, `LIVE_MODE_ARMED=<true|false>`
   - controls: `SCAN_INTERVAL_SECONDS`, `DEFAULT_TRADE_AMOUNT_RAW`, `TX_DEADLINE_SECONDS`
   - status endpoints: `BOT_STATUS_SERVER_ENABLED=true`, `BOT_STATUS_SERVER_REQUIRED=true`, optional `BOT_STATUS_AUTH_TOKEN=<secret>`
5. Deploy and verify:
   - `https://<railway-domain>/healthz` => 200
   - `https://<railway-domain>/readyz` => 200 (after first successful tick)
   - `https://<railway-domain>/state` => includes `{ healthy: true, ready: true, runtime, state }`
6. Point Vercel UI to Railway bot(s):
   - default fallback: `BOT_STATE_URL=https://<railway-domain>/state`
   - per-route endpoints in one Vercel project:
     - `BOT_STATE_URL_USDC=https://<usdc-railway-domain>/state`
     - `BOT_STATE_URL_AUSD=https://<ausd-railway-domain>/state`
     - `BOT_STATE_URL_SHMON=https://<shmon-railway-domain>/state`
   - if protected, set matching auth vars (`BOT_STATE_AUTH_TOKEN_*`) with each service's `BOT_STATUS_AUTH_TOKEN`
7. Redeploy Vercel so dashboard routes use live Railway bot state.
