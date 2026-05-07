# xpr-oracle

A minimal, copy-pasteable price-pusher for **XPR Network Block Producers**. Fetches prices from CEXes, aggregates them, and submits to the on-chain `delphioracle` contract.

> Status: BP-runnable, single dormant pair (`xprusd`). Reviving the rest of the feed set is a community effort — see [docs/GOVERNANCE.md](docs/GOVERNANCE.md).

## Why this exists

A frequent question: *"Can every BP run an oracle on XPR Network?"* Yes — but **BPs do not deploy their own oracle contract**. XPR Network already has the `delphioracle` aggregator (a port of [eostitan/delphioracle](https://github.com/eostitan/delphioracle)). What BPs run is an **off-chain pusher**: a small daemon that fetches CEX prices and submits them to that one shared on-chain contract via the `write` action.

This repo is that daemon. It uses the same `cleos` + `keosd` pattern most BPs already have wired up for `claimrewards` — no new key-management story to invent.

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
   KuCoin  ────────▶│  xpr-oracle  │── cleos push action ──▶ your local nodeos ──▶ delphioracle::write
   Bitget  ────────▶│  (this repo) │   (signed via keosd)                                   │
   Coinbase────────▶│              │                                                        ▼
                    └──────────────┘                                                  on-chain median
                                                                                     (read by dApps)
```

## Quickstart

Prereqs: Node 20+, `cleos` and `keosd` (already on every BP node), an XPR account whitelisted on `delphioracle` (see [docs/BP-ONBOARDING.md](docs/BP-ONBOARDING.md)).

```bash
# 1. install
git clone https://github.com/paulgnz/xpr-oracle && cd xpr-oracle
npm install
npm run build

# 2. configure — set "account", "permission", and "endpoint" to your local nodeos
cp config.example.json config.json
$EDITOR config.json

# 3. import the oracle private key into your keosd wallet (one time)
cleos --url http://127.0.0.1:8888 wallet import   # paste the oracle-permission private key

# 4. drop the wallet password into a chmod-600 file
sudo install -m 0600 -o $(whoami) -g $(whoami) /dev/null /etc/xpr-oracle/wallet.pw
echo 'PW5K…your wallet password…' | sudo tee /etc/xpr-oracle/wallet.pw

# 5. dry run (no on-chain writes — also exercises the feed fetchers)
npm run dry-run

# 6. real run
npm start
```

The daemon mirrors the `claimrewards` cron pattern most BPs already use: `cleos wallet unlock` then `cleos push action`. No new key-management story.

When you're happy, install as a systemd unit — see [docs/BP-ONBOARDING.md](docs/BP-ONBOARDING.md).

## Config

`config.json`:

| Field | Notes |
|---|---|
| `account` | Your BP account (or a sub-account dedicated to oracle work). |
| `permission` | A dedicated permission like `oracle`, **never `active` or `owner`**. See [docs/PERMISSIONS.md](docs/PERMISSIONS.md). |
| `contract` | `delphioracle` |
| `endpoint` | URL passed to `cleos --url …`. Recommended: `http://127.0.0.1:8888` (your local nodeos). |
| `intervalSeconds` | 30–120 typical. Don't go below 5. |
| `expirationSeconds` | Tx expiration in seconds (default 240, matches the typical claimrewards cron). |
| `walletPasswordFile` | Path to a chmod-600 file with the keosd wallet password. Or set `XPR_ORACLE_WALLET_PW`. Or omit and keep keosd unlocked some other way. |
| `walletName` | Optional keosd wallet name; omit to use the default. |
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
