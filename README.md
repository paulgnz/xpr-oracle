# xpr-oracle

A minimal, copy-pasteable price-pusher for **XPR Network Block Producers**. Fetches prices from CEXes, aggregates them, and submits to the on-chain `delphioracle` contract via your local `nodeos` and `keosd`.

## Why this matters now

On 2026-05-07, **Rob @AtomicHub** asked all active XPR Network BPs in the BP Telegram channel to start running a `delphioracle` pusher. **Atomic Drops uses delphioracle to peg drops to a stable USD price**, and the **Atomic Assets API** depends on it directly. Until today, only `saltant` was pushing, hourly — meaning the on-chain median was effectively single-sourced.

This repo is the daemon that fixes that.

We **proved the contract has no governance gate for being an oracle** by bootstrapping `protonnz` end-to-end in this repo's first session. First-time push: tx [`b2df4931…`](https://explorer.xprnetwork.org/transaction/b2df49313fab7d09e14497dc4d33e9791b5e57cb0764a86d8ed9a58d99ceb800), block 380898553, 2026-05-07 06:48:06 UTC. The on-chain `xprusd` median jumped from single-sourced (`saltant=2850`) to dual-sourced (`median=2887` blending saltant + protonnz). **Any BP can self-bootstrap** — no whitelist request, no multisig, no saltant approval.

## What it does

```
                    ┌──────────────┐
   KuCoin ─────────▶│              │
   Bitget ─────────▶│  xpr-oracle  │── cleos push action ──▶ your local nodeos ──▶ delphioracle::write
   MEXC   ─────────▶│  (this repo) │   (signed via keosd)                                   │
   Gate.io─────────▶│              │                                                        ▼
   CoinGecko ──────▶│              │                                                  on-chain median
                    └──────────────┘                                                 (Atomic Drops, etc.)
```

1. Loads pair config (which CEX feeds, what precision).
2. Every `intervalSeconds` (300s recommended), queries each feed in parallel.
3. Computes a median, drops outliers (`maxDeviationPct`), recomputes.
4. Preflight: confirms local nodeos is fresh via `get_info` (drops the tick if stale).
5. Shells out to `cleos push action delphioracle write …` to submit the quote, signed by `keosd`.
6. Touches a heartbeat file on success so `monitor.sh` can alert via Telegram if the pusher goes stale.

Zero runtime npm dependencies. Mirrors the `claimrewards` cron pattern most BPs already have wired up — no new key-management story.

## Quickstart (interactive)

Prereqs: Node ≥20, `cleos` and `keosd` (already on every BP/API node from [`xpr.start`](https://github.com/XPRNetwork/xpr.start)), `jq`, `curl`. Recommended: run on your **API node**, not your producer node — see [docs/HOSTING.md](docs/HOSTING.md).

```bash
git clone https://github.com/paulgnz/xpr-oracle && cd xpr-oracle
./install.sh
```

The installer:
- checks prereqs (cleos, keosd, node, jq, curl)
- auto-detects your nodeos endpoint from `xpr.start` config.ini
- prompts for BP account, permission, pairs, feeds, interval, wallet password file
- verifies on-chain: account exists, oracle permission has linkauth to delphioracle::write
- builds the daemon, generates `config.json`
- optionally installs the systemd unit

If `oracle` permission isn't set up yet, the installer points you at [docs/PERMISSIONS.md](docs/PERMISSIONS.md). It's a one-time two-transaction setup (`updateauth` + `linkauth`).

## Quickstart (non-interactive, agent / CI)

```bash
./install.sh --non-interactive \
  --account=<bp> \
  --permission=oracle \
  --endpoint=http://127.0.0.1:8888 \
  --pairs=xprusd \
  --interval=300 \
  --wallet-password-file=/etc/xpr-oracle/wallet.pw \
  --install-systemd
```

All flags also accept env-var equivalents (`XPR_ORACLE_NONINTERACTIVE=1`, `XPR_ORACLE_WALLET_PW=…`). See `./install.sh --help`.

### Hand-off prompt for an agent

If you want your local AI agent (Claude Code, Cursor, etc.) to perform the install, paste this:

> Clone https://github.com/paulgnz/xpr-oracle to my home directory. Read `AGENTS.md` for project context. Then run `./install.sh --non-interactive --account=<MY-BP> --pairs=xprusd --interval=300 --install-systemd` and verify the systemd unit is active. If `oracle` permission isn't set up on-chain yet, follow `docs/PERMISSIONS.md` to do `updateauth` + `linkauth` first. Run `npm test` and `npm run dry-run` before going live. After enabling the unit, confirm a successful push appears in `journalctl -u xpr-oracle` and on https://explorer.xprnetwork.org/account/delphioracle.

## Config

| Field | Notes |
|---|---|
| `account` | Your BP account (or a sub-account dedicated to oracle work). |
| `permission` | A dedicated permission like `oracle`, **never `active` or `owner`**. |
| `contract` | `delphioracle` |
| `endpoint` | URL passed to `cleos --url …`. Recommended: `http://127.0.0.1:8888` (your local nodeos). |
| `intervalSeconds` | 300 (5 min) is the recommended cadence per BP coordination. Don't go below 60. |
| `expirationSeconds` | Tx expiration in seconds (default 240). |
| `walletPasswordFile` | Path to a chmod-600 file with the keosd wallet password. Or set `XPR_ORACLE_WALLET_PW`. Or omit and keep keosd unlocked some other way. |
| `walletName` | Optional keosd wallet name; omit to use the default. |
| `heartbeatFile` | Optional path touched after every successful push. Used by `monitor.sh`. |
| `pairs[].name` | On-chain pair name, e.g. `xprusd`. |
| `pairs[].feeds` | `"<exchange>:<symbol>"` list. Built-in CEX adapters: `binance`, `kucoin`, `bitget`, `coinbase`, `kraken`, `bitfinex`, `okx`, `bybit`, `mexc`, `gate`. Aggregator: `coingecko` (use sparingly — see [docs/FEEDS.md](docs/FEEDS.md)). |
| `pairs[].quotedPrecision` | Must match the on-chain pair's `quoted_precision` (xprusd is 6). |
| `pairs[].maxDeviationPct` | Reject feed samples this far from the initial median. |
| `pairs[].minSources` | Skip pair if fewer feeds survive. |

## Pairs currently registered on `delphioracle`

| Pair | Status | Notes |
|---|---|---|
| `xprusd` | ✅ active, precision 6 | The only registered pair as of 2026-05-07. |
| `xbtcusd`, `xethusd`, `xusdcusd`, `xmdusd` | ⏳ requested by Rob @AtomicHub | Need pair registration via `newbounty`/`editbounty` — see [docs/GOVERNANCE.md](docs/GOVERNANCE.md). |

For pegged tokens (`xbtcusd`, `xethusd`, `xusdcusd`, `xmdusd`), the on-chain pair name is `x<asset>usd` but the *feed* uses the underlying asset's CEX symbol (e.g., `xbtcusd` is fed from `kucoin:BTC-USDT`, not from any XPR-side market). See [docs/FEEDS.md](docs/FEEDS.md).

## Sibling: Metallicus `oracles` contract

XPR Network also has a separate Metallicus-operated `oracles` account ([explorer](https://explorer.xprnetwork.org/account/oracles)) with 22 feeds (XPR/USD, BTC/USD, ETH/USD, USDC/USD, USDT/USD, XMD/USD, plus DOGE, SOL, XRP, HBAR, ADA, XLM, …). The two contracts coexist intentionally:

- **`delphioracle`** — what Atomic Assets API and Atomic Drops consume.
- **`oracles`** — what Metallicus tooling (wallet, MetalX) consumes.

Pushing to both is straightforward (just add another `linkauth` and another contract entry — see [docs/PERMISSIONS.md](docs/PERMISSIONS.md)).

## Documentation

- **[AGENTS.md](AGENTS.md)** — context for AI agents working in this repo.
- **[docs/BP-ONBOARDING.md](docs/BP-ONBOARDING.md)** — full BP setup, end-to-end.
- **[docs/PERMISSIONS.md](docs/PERMISSIONS.md)** — `oracle` permission with linked auth (with worked example from `protonnz`).
- **[docs/LOCAL-NODE.md](docs/LOCAL-NODE.md)** — pointing the daemon at your nodeos.
- **[docs/HOSTING.md](docs/HOSTING.md)** — API node vs producer node, sizing.
- **[docs/FEEDS.md](docs/FEEDS.md)** — feed taxonomy, pair-feed compatibility, pegged-token guidance.
- **[docs/GOVERNANCE.md](docs/GOVERNANCE.md)** — adding new pairs (the only on-chain governance step).

## Monitoring

`monitor.sh` watches the heartbeat file and pings a Telegram chat if the daemon stops pushing. Configure via env vars (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `MAX_AGE_MINUTES`) and run from cron — see the script's header comment.

## Disclaimer

Smart contracts and the data feeding them are real-money infrastructure. Run `npm run dry-run` for ≥1h before going live. Use a dedicated permission with linkauth — never your `active` or `owner` keys. Run on an API node, not a producer node. Monitor freshness.

## License

MIT — see [LICENSE](LICENSE).
