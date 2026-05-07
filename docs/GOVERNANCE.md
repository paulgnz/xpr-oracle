# Governance: pair creation on `delphioracle`

**Onboarding as an oracle is self-service.** A BP with `linkauth` to `delphioracle::write` can push immediately — verified empirically on 2026-05-07 ([tx `b2df4931…`](https://explorer.xprnetwork.org/transaction/b2df49313fab7d09e14497dc4d33e9791b5e57cb0764a86d8ed9a58d99ceb800)). See [BP-ONBOARDING.md](BP-ONBOARDING.md) §3.

The on-chain governance step that *does* still apply is **adding a new pair** to the contract's pair set. Until a pair is registered, pushes naming it fail. As of 2026-05-07 only `xprusd` is registered.

This doc shows how to propose a new pair.

## Snapshot (2026-05-07)

| | |
|---|---|
| `delphioracle::pairs` | 1 row — `xprusd` (precision 6) |
| `delphioracle::users` | 2 rows — `saltant`, `protonnz` |
| `delphioracle::custodians` | 0 rows (empty) |
| `delphioracle::write` actions | ~10,000 ever, all by saltant until 2026-05-07 |
| `delphioracle@active` perm | threshold 1, keys: saltant's, plus `delphioracle@eosio.code` self-perm and `eosio.prods@active` (BP multisig) — any one can authorize |

## Two paths for adding a pair

The contract's `active` perm is threshold-1 with three weight-1 entries, so **either of these alone is sufficient**:

1. **Saltant signs solo.** He holds the key. DM him on the BP Telegram. ~Minutes.
2. **BP multisig** via `eosio.prods@active`. Requires 15-of-21 BP approvals. ~Days, much heavier.

In practice nobody has used path 2 since the contract was deployed in Feb 2025. Path 1 is the operational reality. Use BP multisig only if saltant declines or is unreachable.

## Pair shape — `eosio::newbounty` + `eosio::editbounty`

The standard DelphiOracle pair-creation flow is two actions: `newbounty` proposes the name, `editbounty` fills in the fields.

### Example: `xbtcusd` (XBTC priced in USD, fed from BTC CEX symbols)

**Action 1 — `delphioracle::newbounty`:**

```json
{
  "name": "xbtcusd",
  "proposer": "saltant"
}
```

**Action 2 — `delphioracle::editbounty`:**

```json
{
  "name": "xbtcusd",
  "base_symbol": "8,XBTC",
  "base_type": 4,
  "base_contract": "xtokens",
  "quote_symbol": "2,USD",
  "quote_type": 1,
  "quote_contract": "",
  "quoted_precision": 4
}
```

`base_type` and `quote_type` are enums in the contract's `asset_type` definition; `4` = a fungible token, `1` = a fiat reference. Match the convention used for the existing `xprusd` pair.

### Example: `btcusd` (BTC/USD reference, no XPR-side wrapper)

```json
{ "name": "btcusd", "proposer": "saltant" }
```

```json
{
  "name": "btcusd",
  "base_symbol": "8,BTC",
  "base_type": 4,
  "base_contract": "",
  "quote_symbol": "2,USD",
  "quote_type": 1,
  "quote_contract": "",
  "quoted_precision": 4
}
```

## How to actually propose

### Path 1: DM saltant (Telegram)

Copy this template, fill in the fields, post in the BP Telegram:

> Hi @Sa1tant — could you add the `<pair-name>` pair to delphioracle? Atomic Drops needs it for `<reason>`. Two actions:
>
> ```json
> // newbounty
> { "name": "<pair-name>", "proposer": "saltant" }
> ```
>
> ```json
> // editbounty
> {
>   "name": "<pair-name>",
>   "base_symbol": "<precision,SYMBOL>",
>   "base_type": 4,
>   "base_contract": "<contract>",
>   "quote_symbol": "2,USD",
>   "quote_type": 1,
>   "quote_contract": "",
>   "quoted_precision": <precision>
> }
> ```
>
> Both signed as `delphioracle@active`. Once landed, BPs will start feeding it on a 5-min interval.

### Path 2: BP multisig (only if path 1 stalls)

```bash
# Save the proposed transaction as JSON
cat > /tmp/addpair.json <<'EOF'
{
  "expiration": "2026-05-14T12:00:00",
  "ref_block_num": 0,
  "ref_block_prefix": 0,
  "max_net_usage_words": 0,
  "max_cpu_usage_ms": 0,
  "delay_sec": 0,
  "context_free_actions": [],
  "actions": [
    {
      "account": "delphioracle",
      "name": "newbounty",
      "authorization": [{"actor":"eosio.prods","permission":"active"}],
      "data": {"name":"xbtcusd","proposer":"saltant"}
    }
  ],
  "transaction_extensions": []
}
EOF

cleos --url http://127.0.0.1:8888 multisig propose_trx addxbtcusd \
  '[{"actor":"eosio.prods","permission":"active"}]' \
  /tmp/addpair.json \
  <proposer-bp>
```

15+ BPs approve via `cleos multisig approve <proposer-bp> addxbtcusd '{"actor":"<their-bp>","permission":"active"}' -p <their-bp>@active`. Then anyone executes via `cleos multisig exec <proposer-bp> addxbtcusd <executor> -p <executor>@active`.

## Verifying current state

```bash
# Active pairs
curl -s https://proton.eosusa.io/v1/chain/get_table_rows \
  -d '{"code":"delphioracle","scope":"delphioracle","table":"pairs","limit":50,"json":true}' \
  | jq '.rows[] | {name, active, base_symbol, quote_symbol, quoted_precision}'

# Registered users / oracles
curl -s https://proton.eosusa.io/v1/chain/get_table_rows \
  -d '{"code":"delphioracle","scope":"delphioracle","table":"users","limit":50,"json":true}'

# Full ABI
curl -s https://proton.eosusa.io/v1/chain/get_abi \
  -d '{"account_name":"delphioracle"}' | jq '.abi.actions, .abi.structs[] | select(.name=="newbounty" or .name=="editbounty")'
```

## A note on the future

The WAX blockchain has an [Oracle Integrity Group](https://oig.wax.io) (OIG) that requires participating BPs to feed the WAX oracle and applies penalties for missing pushes — making oracle uptime a measurable, enforceable BP duty rather than volunteer work. EOSUSA Michael floated this in the BP Telegram on 2026-05-07 as a model XPR could adopt once there's a stable cohort of pushers. Empty custodians today, custodians tomorrow, OIG-style enforcement eventually.
