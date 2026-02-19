# Vault-Per-Token Rollout Checklist

This runbook is for production rollout with one `TreasuryVault` per deposit token and one bot runtime per vault.

## 1) Deployment Matrix

| Vault | Deposit token | Current protocol candidates | Status |
| --- | --- | --- | --- |
| `vault-usdc` | `USDC` | Curvance, Morpho, Neverland (USDC), Gearbox (pending addresses) | Ready for existing USDC flows |
| `vault-ausd` | `AUSD` | Curvance AUSD, Morpho AUSD, Neverland AUSD, Gearbox AUSD (pending addresses) | Ready once allowlists are added |
| `vault-shmon` | `shMON` | Morpho shMON, Neverland shMON, Gearbox shMON (pending addresses) | Ready once allowlists + pool addresses are added |
| `vault-kmon` | `kMON` | Morpho kMON, Gearbox kMON (pending), Neverland kMON (not detected) | Blocked on verified pool availability |

## 2) Verified Neverland Monad Pool Surface

- Pool address: `0x80F00661b13CC5F6ccd3885bE7b4C9c67545D585`
- Verified reserves used in this repo:
  - `USDC` asset -> `nUSDC` aToken
  - `AUSD` asset -> `nAUSD` aToken
  - `shMON` asset -> `nSHMON` aToken
- `kMON` reserve was not detected in current Neverland reserve list.

## 3) Per-Vault Bot Runtime Rules

- Run **one bot process per vault** with a separate env file.
- Required per-runtime core vars:
  - `VAULT_ADDRESS`
  - `VAULT_DEPOSIT_TOKEN_ADDRESS`
  - `VAULT_DEPOSIT_TOKEN_SYMBOL`
  - `VAULT_DEPOSIT_TOKEN_DECIMALS`
- Only enable pools whose `tokenIn` equals `VAULT_DEPOSIT_TOKEN_ADDRESS`.
- Keep all other `<PROTOCOL>_*_ENABLED=false` in that runtime.

## 4) Allowlist Preparation (Owner / Multisig)

`onchain/scripts/configure-vault.ts` and `onchain/scripts/prepare-configure-vault-multisig.ts` now collect allowlist candidates from protocol env keys:

- `*_TOKEN_IN_ADDRESS`
- `*_LP_TOKEN_ADDRESS`
- `*_TARGET_ADAPTER_ADDRESS`
- `*_POOL_ADDRESS`

Additional controls:

- `ALLOWLIST_INCLUDE_CURVANCE_DEFAULTS=true|false` (default `true`)
- `ALLOWLIST_INCLUDE_DISABLED_POOL_CONFIGS=true|false` (default `false`)
- `ALLOWLIST_POOL_KEYS=<comma-separated pool keys>` to pre-allowlist disabled pools
- `ALLOWLIST_ONLY_POOL_KEYS=true|false` (default `false`) to ignore currently enabled pools and use only explicit keys
- `INIT_TOKEN_ALLOWLIST`, `INIT_TARGET_ALLOWLIST`, `INIT_POOL_ALLOWLIST` (optional comma-separated extras)
- `DAILY_MOVEMENT_CAP_BPS` (optional explicit cap update)

### Example: generate multisig plan for AUSD vault

```bash
cd onchain
set VAULT_ADDRESS=<vault-ausd-address>
set ALLOWLIST_INCLUDE_CURVANCE_DEFAULTS=false
set ALLOWLIST_POOL_KEYS=MORPHO_AUSD,NEVERLAND_AUSD
set MORPHO_AUSD_TARGET_ADAPTER_ADDRESS=<morpho-adapter>
set MORPHO_AUSD_POOL_ADDRESS=<morpho-ausd-vault>
set MORPHO_AUSD_LP_TOKEN_ADDRESS=<morpho-ausd-vault>
set NEVERLAND_AUSD_TARGET_ADAPTER_ADDRESS=<neverland-adapter>
set NEVERLAND_AUSD_POOL_ADDRESS=0x80F00661b13CC5F6ccd3885bE7b4C9c67545D585
set NEVERLAND_AUSD_LP_TOKEN_ADDRESS=0x784999fc2Dd132a41D1Cc0F1aE9805854BaD1f2D
npm run prepare:configure:vault:multisig:monad
```

### One-command rollout plan generation

After setting vault addresses in `.env`, generate both AUSD and shMON plans automatically:

```bash
cd onchain
# requires VAULT_AUSD_ADDRESS and/or VAULT_SHMON_ADDRESS
npm run prepare:configure:vault:rollout:monad
```

Outputs:
- `onchain/multisig-plan.vault-ausd.json`
- `onchain/multisig-plan.vault-shmon.json`

## 5) Safe Enablement Sequence (Per Vault)

1. Deploy protocol adapters needed for that vault (`TARGET_ADAPTER_CONTRACT=<...>`).
2. Add env addresses for pool/adapter/lp token.
3. Run multisig plan and execute allowlist txs.
4. Run `cd bot && npm run preflight` with that vault env.
5. Set target `<PROTOCOL>_*_ENABLED=true`.
6. Keep `LIVE_MODE_ARMED=false` for first validation cycle.
7. After verification, arm live mode deliberately.

## 6) Current Hard Blocks

- Gearbox Monad pool addresses are still unverified in this workspace.
- Neverland `kMON` reserve is currently not detected.
