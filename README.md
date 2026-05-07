# xpr-oracle

A minimal, copy-pasteable price-pusher for **XPR Network Block Producers**. Fetches prices from CEXes, aggregates them, and submits to the on-chain `delphioracle` contract via your local `nodeos` and `keosd`.

## Why this matters now

On 2026-05-07, [**Rob ([@robrigo](https://github.com/robrigo))**](https://github.com/robrigo) from **AtomicHub** asked active XPR Network BPs in the BP Telegram channel to start running a `delphioracle` pusher. **Atomic Drops uses delphioracle to peg drops to a stable USD price**, and the **Atomic Assets API** depends on it directly.

`saltant` deployed `delphioracle` on XPR Network in February 2025 and has run the sole pusher reliably ever since — this repo's contribution is a turnkey daemon to make it easy for more BPs to join in, broadening the on-chain median.

We bootstrapped `protonnz` end-to-end in this repo's first session and verified the daemon works against live mainnet. First push: tx [`b2df4931…`](https://explorer.xprnetwork.org/transaction/b2df49313fab7d09e14497dc4d33e9791b5e57cb0764a86d8ed9a58d99ceb800), block 380898553, 2026-05-07 06:48:06 UTC. The on-chain `xprusd` median moved from single-sourced (`saltant=2850`) to dual-sourced (`median=2887` blending both pushers). The contract's only on-chain prerequisite is a properly configured `linkauth` from your BP to `delphioracle::write` — once that's in place, you can push.

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

## One-time on-chain setup (oracle permission + linkauth)

Two transactions signed by `<bp>@active`, ~45 seconds apart. Generate a fresh keypair on the pusher host (`cleos create key --to-console`), then:

**Anchor / Bloks / WebAuth (most BPs):** open https://explorer.xprnetwork.org/account/eosio → **Contract** → **Actions**. Run **`updateauth`** (`account=<bp>`, `permission=oracle`, `parent=active`, `auth={threshold:1, keys:[{key:PUB_K1_…, weight:1}]}`), then **`linkauth`** (`account=<bp>`, `code=delphioracle`, `type=write`, `requirement=oracle`).

**cleos** (if `<bp>@active` is in your local keosd): `cleos set account permission <bp> oracle PUB_K1_… active -p <bp>@active`, then `cleos set action permission <bp> delphioracle write oracle -p <bp>@active`.

Verify, recovery, threat model, and the worked `protonnz` example are in [docs/PERMISSIONS.md](docs/PERMISSIONS.md). **`install.sh` does not perform this step — it verifies the result and refuses to install if linkauth is missing.**

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

If you want your local AI agent (Claude Code, Cursor, etc.) to perform the install, paste this whole block (GitHub's copy-button on the top-right of the code block makes this one click):

```text
Clone https://github.com/paulgnz/xpr-oracle to my home directory. Read AGENTS.md for project context. Then run:

  ./install.sh --non-interactive --account=<MY-BP> --pairs=xprusd --interval=300 --install-systemd

Verify the systemd unit is active. If the `oracle` permission isn't set up on-chain yet, follow docs/PERMISSIONS.md to do `updateauth` + `linkauth` first (use the explorer UI flow if my active key is in Anchor/Bloks/WebAuth, the cleos flow if it's in keosd). Run `npm test` and `npm run dry-run` before going live. After enabling the unit, confirm a successful push appears in `journalctl -u xpr-oracle` and on https://explorer.xprnetwork.org/account/delphioracle.

Replace <MY-BP> with my BP account name. Don't push to mainnet during dry-run. If anything fails, surface the error and ask before retrying.
```

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

| Pair | Precision | Notes |
|---|---|---|
| `xprusd` | 6 | XPR/USD (active since the contract was deployed in Feb 2025) |
| `btcusd` | 4 | BTC/USD reference price |
| `ethusd` | 4 | ETH/USD reference price |
| `usdcusd` | 6 | USDC/USD (≈1; tracks the peg) |
| `xprbtc` | 8 | XPR/BTC cross-rate (currently sourced from CoinGecko `vs_currencies=btc`; synthetic from xprusd/btcusd is cleaner once daemon support lands) |

**Naming convention.** Pair names price the **underlying asset**, not the XPR-side wrapper — `btcusd` (the price of BTC), not `xbtcusd` (the price of XBTC-the-wrapper). Same data is fed from CEX BTC markets either way, but the underlying name is what Metallicus's `oracles` contract and the rest of the ecosystem use.

XPR-native assets (XPR via `eosio.token`, XMD via `xmd.token`) keep the `x` prefix because they have no off-chain reference market. See [docs/FEEDS.md](docs/FEEDS.md) for the per-pair feed table.

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
- **[docs/CONSUMERS.md](docs/CONSUMERS.md)** — how dApps and contracts **read** the prices this daemon pushes (off-chain curl/JS, on-chain AssemblyScript/C++, freshness + best practices).
- **[docs/GOVERNANCE.md](docs/GOVERNANCE.md)** — adding new pairs (the only on-chain governance step).

## Upgrading

```bash
cd ~/xpr-oracle && ./bin/upgrade.sh
```

Handles `git pull` + `npm install` + `npm run build` + `systemctl restart` in one command. **Required** when source has changed: systemd's `ExecStart` runs the compiled `dist/index.js`, so `git pull` alone won't pick up source updates without a rebuild.

## Monitoring

`monitor.sh` watches the heartbeat file and pings a Telegram chat if the daemon stops pushing. Configure via env vars (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `MAX_AGE_MINUTES`) and run from cron — see the script's header comment.

## Disclaimer

Smart contracts and the data feeding them are real-money infrastructure. Run `npm run dry-run` for ≥1h before going live. Use a dedicated permission with linkauth — never your `active` or `owner` keys. Run on an API node, not a producer node. Monitor freshness.

## License

MIT — see [LICENSE](LICENSE).
