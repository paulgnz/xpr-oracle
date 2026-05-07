# xpr-oracle

A minimal, copy-pasteable price-pusher for **XPR Network Block Producers**. Fetches prices from CEXes, aggregates them, and submits to the on-chain `delphioracle` contract.

> Status: BP-runnable, single dormant pair (`xprusd`). Reviving the rest of the feed set is a community effort — see [docs/GOVERNANCE.md](docs/GOVERNANCE.md).

## Why this exists

A frequent question: *"Can every BP run an oracle on XPR Network?"* Yes — but **BPs do not deploy their own oracle contract**. XPR Network already has the `delphioracle` aggregator (a port of [eostitan/delphioracle](https://github.com/eostitan/delphioracle)). What BPs run is an **off-chain pusher**: a small daemon that fetches CEX prices and submits them to that one shared on-chain contract via the `write` action.

This repo is that daemon.

## What it does

1. Loads pair config (which CEX feeds, what precision).
2. Every `intervalSeconds`, queries each feed in parallel.
3. Computes a median, drops outliers (`maxDeviationPct`), recomputes.
4. Shells out to `proton action delphioracle write …` to submit the quote.
5. Logs to stdout / journald and keeps going.

Zero runtime npm dependencies. ~300 lines of TypeScript. Designed to live alongside an existing BP node as a separate systemd unit.

## Architecture

```
                    ┌──────────────┐
   Binance ────────▶│              │
   KuCoin  ────────▶│  xpr-oracle  │── proton action ──▶ delphioracle::write
   Bitget  ────────▶│  (this repo) │                          │
   Coinbase────────▶│              │                          ▼
                    └──────────────┘                    on-chain median
                                                       (read by dApps)
```

## Quickstart

Prereqs: Node 20+, `@proton/cli`, an XPR account whitelisted on `delphioracle` (see [docs/BP-ONBOARDING.md](docs/BP-ONBOARDING.md)).

```bash
# 1. install
git clone https://github.com/paulgnz/xpr-oracle && cd xpr-oracle
npm install
npm run build

# 2. configure
cp config.example.json config.json
$EDITOR config.json   # set "account" and "permission" to your BP's signer

# 3. point the proton CLI at your local nodeos (recommended for BPs)
#    see docs/LOCAL-NODE.md for the full story
proton chain:add proton-local \
  384da888112027f0321850a169f737c33e53b388aad48b5adace4bab97f437e0 \
  http://127.0.0.1:8888
proton chain:set proton-local
# or fall back to the public endpoint:
# proton chain:set proton

# 4. import the signing key (no password needed for non-interactive signing)
proton key:add        # paste the oracle-permission private key

# 5. dry run (no on-chain writes)
npm run dry-run

# 6. real run
npm start
```

When you're happy, install as a systemd unit — see [docs/BP-ONBOARDING.md](docs/BP-ONBOARDING.md).

## Config

`config.json`:

| Field | Notes |
|---|---|
| `account` | Your BP account (or a sub-account dedicated to oracle work). |
| `permission` | A dedicated permission like `oracle`, **never `active` or `owner`**. See [docs/PERMISSIONS.md](docs/PERMISSIONS.md). |
| `contract` | `delphioracle` |
| `intervalSeconds` | 30–120 typical. Don't go below 5. |
| `pairs[].name` | On-chain pair name, e.g. `xprusd`. |
| `pairs[].feeds` | `"<exchange>:<symbol>"` list. Built-in CEX adapters: `binance`, `kucoin`, `bitget`, `coinbase`, `kraken`, `bitfinex`, `okx`, `bybit`, `mexc`, `gate`. Aggregator: `coingecko` (use sparingly — see [docs/FEEDS.md](docs/FEEDS.md)). |
| `pairs[].quotedPrecision` | Must match the on-chain pair's `quoted_precision`. |
| `pairs[].maxDeviationPct` | Reject feed samples this far from the initial median. |
| `pairs[].minSources` | Skip pair if fewer feeds survive. |

## Adding an exchange

`src/feeds.ts` — add one entry to the `adapters` map. Adapters return a `number` and `throw` on bad data; the rest of the pipeline handles errors.

## Adding a pair

The pair must exist on-chain first. See [docs/GOVERNANCE.md](docs/GOVERNANCE.md) for how to propose a new pair via the `eosio.prods` BP multisig.

## Documentation

- **[docs/BP-ONBOARDING.md](docs/BP-ONBOARDING.md)** — full BP setup: account, permission, whitelist request, hosting, systemd install.
- **[docs/PERMISSIONS.md](docs/PERMISSIONS.md)** — least-privilege oracle permission with linked auth (with worked example).
- **[docs/LOCAL-NODE.md](docs/LOCAL-NODE.md)** — pointing the daemon at your own nodeos (xpr.start integration).
- **[docs/HOSTING.md](docs/HOSTING.md)** — running on your BP node vs Railway vs a VPS.
- **[docs/FEEDS.md](docs/FEEDS.md)** — feed taxonomy, adding exchanges, picking a healthy mix.
- **[docs/GOVERNANCE.md](docs/GOVERNANCE.md)** — proposing pairs and whitelisting oracles via BP multisig.

## Disclaimer

Smart contracts and the data feeding them are real-money infrastructure. Before deploying anything to mainnet review the code, run dry-run against testnet, monitor freshness, and use a dedicated permission with linked auth.

## License

MIT — see [LICENSE](LICENSE).
