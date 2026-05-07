# Governance: pairs and oracle approvals

The `delphioracle` contract on XPR Network mainnet is governed by the BP multisig — its `active` permission includes `eosio.prods@active`, so any change requires 15-of-21 BPs. There is no central admin. As of 2026-05, the contract has only one registered pair (`xprusd`) and an empty custodian set; reviving it is a community effort and the kind of work this repo is meant to support.

This document collects the on-chain shapes and `proton` CLI commands needed to add pairs and approve oracles via that BP multisig path.

## Verifying current state

```bash
# Active pairs
curl -s https://proton.eosusa.io/v1/chain/get_table_rows \
  -d '{"code":"delphioracle","scope":"delphioracle","table":"pairs","limit":50,"json":true}'

# Registered users / oracles
curl -s https://proton.eosusa.io/v1/chain/get_table_rows \
  -d '{"code":"delphioracle","scope":"delphioracle","table":"users","limit":50,"json":true}'

# Custodians (currently empty)
curl -s https://proton.eosusa.io/v1/chain/get_table_rows \
  -d '{"code":"delphioracle","scope":"delphioracle","table":"custodians","limit":50,"json":true}'

# Full ABI (action signatures)
curl -s https://proton.eosusa.io/v1/chain/get_abi \
  -d '{"account_name":"delphioracle"}'
```

## Available actions

The deployed ABI exposes these actions (relevant ones bolded):

| Action | Use |
|---|---|
| `configure` | Update contract config |
| `addcustodian` / `delcustodian` | Manage custodian set |
| **`reguser`** | Register a user/oracle |
| `updateusers` | Update user metadata |
| `voteabuser` | Flag misbehaving oracle |
| **`newbounty`** / `editbounty` / `cancelbounty` / `votebounty` / `unvotebounty` | Pair-creation bounty workflow |
| `editpair` / `deletepair` | Pair management |
| **`write`** | Submit a quote |
| `writehash` / `forfeithash` | Hash-then-reveal flow |
| `migratedata` / `clear` | Maintenance |

The standard DelphiOracle pair-creation flow is **bounty-based**: someone proposes a pair via `newbounty`, oracles signal interest by voting, custodians (or BP multisig in our case) approve, and the pair becomes active.

## Adding a new pair (BP multisig)

### 1. Draft the action

Use `newbounty` (or `editpair` if rehydrating an existing one). The exact JSON depends on the action — fetch the latest ABI and match its struct fields. Example shape for `newbounty`:

```json
{
  "name": "btcusd",
  "proposer": "delphioracle"
}
```

…then a follow-up `editbounty` to set base/quote symbols, contracts, precision, etc. Read the ABI before composing the JSON; the on-chain struct names are the source of truth.

### 2. Propose via multisig

```bash
proton multisig:propose \
  add-btcusd-pair \
  '[{"actor":"eosio.prods","permission":"active"}]' \
  '[{"actor":"delphioracle","permission":"active"}]' \
  delphioracle newbounty \
  '{"name":"btcusd","proposer":"delphioracle"}'
```

### 3. Collect approvals

Other BPs run:

```bash
proton multisig:approve <proposer> add-btcusd-pair \
  '{"actor":"<their-bp>","permission":"active"}'
```

15+ approvals required.

### 4. Execute

Anyone can execute once threshold is met:

```bash
proton multisig:exec <proposer> add-btcusd-pair <executor>
```

## Approving an oracle (BP multisig)

Same pattern, but the action is `reguser` (or whichever action the contract is using to populate the producers/users table — confirm via the ABI before you propose):

```bash
proton multisig:propose \
  approve-oracle-mybp \
  '[{"actor":"eosio.prods","permission":"active"}]' \
  '[{"actor":"delphioracle","permission":"active"}]' \
  delphioracle reguser \
  '{"name":"mybp"}'
```

Whichever action the deployed contract requires, keep the JSON in this repo under `governance/<request>.json` so the multisig is reproducible from the PR.

## Why route everything through this repo

- **Reproducibility.** The exact JSON proposed on-chain is in git history.
- **Visibility.** BPs reviewing a multisig can read the PR before approving.
- **Coordination.** The PR doubles as the place to track approvals and hand off the executing BP.

## Becoming a custodian (alternative, lower-friction model)

If the BP set wants a faster oracle-approval cadence than 15-of-21 multisig, the path is:

1. Use the BP multisig **once** to call `addcustodian` and seat 5–7 trusted custodians.
2. Custodians thereafter approve oracles and pairs without needing the full 15/21.

That's a meaningful governance shift — propose it as a separate discussion before the first technical multisig.
