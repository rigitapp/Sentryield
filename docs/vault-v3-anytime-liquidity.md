# Vault V3 - Anytime Deposit/Withdraw UX

This document defines the next contract generation needed to support a user-first flow:

- deposit anytime, even while capital is deployed
- withdraw anytime with one action (system unwinds LP as needed)
- rotate between pools without forcing users through manual operational steps

## Why V2 cannot support this safely

Current `TreasuryVault` v2 share accounting is based on idle USDC (`depositToken` balance), not full vault NAV.

- `depositUsdc()` reverts when `hasOpenLpPosition() == true`
- `withdrawToWallet()` reverts when `hasOpenLpPosition() == true`
- this avoids dilutive minting because deployed LP value is not included in share pricing

As a result, V2 must park to USDC before user mints/burns.

## V3 product goals

1. **Anytime deposit**
   - user deposits while LP is active
   - shares mint against full NAV, not idle cash only
2. **Anytime withdraw**
   - user requests USDC amount
   - vault unwinds LP as needed and sends USDC
3. **Simple UX**
   - user sees one action, not pause/exit/resume choreography
4. **Backwards-safe rails**
   - keep allowlists, role model, slippage/deadline constraints, pause controls

## Proposed V3 architecture

### 1) NAV-based share accounting

Introduce `totalAssets()`:

- idle USDC
- plus deployed LP value converted to USDC via valuation hooks

Share math:

- `sharesOut = amountIn * totalShares / totalAssetsBefore` (or 1:1 if first deposit)
- `sharesBurned = ceil(amountOut * totalShares / totalAssetsNow)`

### 2) Position valuation layer

Add valuation abstraction so each pool can quote LP->USDC:

- default path for ERC4626-like pools: `previewRedeem(lpShares)`
- adapter fallback interface for non-ERC4626 pools

This makes NAV robust across Curvance/Morpho and future protocols.

### 3) Liquidity manager for withdrawals

Add internal unwind path for user withdraw:

- if idle USDC >= requested amount, transfer directly
- else unwind only the deficit from active LP positions
- support partial unwinds under movement caps
- continue until request satisfied or fail with clear reason

### 4) Async intent support (recommended)

To prevent revert-heavy UX under rails/caps:

- `requestWithdraw(assetsOut, receiver)` records user intent
- bot executor fulfills queued intents over one or more ticks
- UI shows request status (`queued`, `partially fulfilled`, `completed`)

Same model can support `requestDepositIntoPool(...)` and migration intents.

## Contract deltas (high level)

- replace `hasOpenLpPosition` hard block in deposit/withdraw paths
- add NAV primitives:
  - `totalAssets()`
  - `convertToShares()`
  - `convertToAssets()`
- add valuation mappings:
  - lp token -> valuation strategy
  - pool metadata needed to unwind safely
- add withdraw fulfillment machinery:
  - sync + async paths
  - partial fulfillment events
- maintain current role and allowlist boundaries

## Bot/UI deltas

- bot:
  - fulfill user intents before strategy rotations
  - prioritize withdraw intents
  - continue partial exits automatically (already added in Phase A)
- UI:
  - one-click withdraw/deposit requests
  - progress state and ETA messaging
  - no operational terminology for end users

## Migration strategy (V2 -> V3)

1. deploy V3 vault + configure roles/allowlists
2. run old/new migration report snapshots
3. drain V2 LP in controlled steps
4. cut UI and bot to V3 endpoints
5. keep V2 in rollback-ready state for a defined window

## Security and audit focus

- share pricing manipulation resistance (NAV oracle/quote trust)
- withdrawal reentrancy and partial-fill invariants
- caps interaction with async fulfillment
- stale quote / slippage protections
- griefing via dust intents and queue spam

---

Phase A (already shipped) provides smart UX orchestration with existing V2 constraints.
Phase B (this document) defines the contract-level upgrade required for true anytime liquidity UX.
