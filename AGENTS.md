# AGENTS.md — context for AI agents working in this repo

This file is the agent-readable orientation for `xpr-oracle`. It exists so an
agent dropped into this codebase can produce useful work in minutes, not hours.
If you are a human, [README.md](README.md) is friendlier.

## What this is

A price-pusher daemon for XPR Network's `delphioracle` smart contract.
Block Producers run this on their **API node** (not the producer node) to
contribute CEX-aggregated price data to the on-chain median, which is consumed
by Atomic Drops, the Atomic Assets API, and any other contract reading
`delphioracle::datapoints`.

## Stack

- **TypeScript daemon** in `src/`. Node ≥20. Zero runtime npm deps.
- Pushes via **`cleos push action`** (subprocess). Signing via local **`keosd`**.
- Endpoint URL is a config field — talks to whatever URL is set, typically the local nodeos at `http://127.0.0.1:8888`.
- **No `proton CLI` runtime dependency.** It's optional for human-side ops only.
- **No `@proton/js`, no `eosjs`, no key-on-disk in the daemon.** keosd holds the key.

## Architectural decisions worth knowing

1. **`cleos` over `@proton/cli`.** The proton CLI's `endpoint:set` silently discards arbitrary URLs and forces a picker against a hardcoded foundation/community endpoint list (verified by reading `lib/commands/endpoint/set.js`). cleos accepts `--url` cleanly and ships with nodeos.
2. **Wallet password via stdin, never argv.** `cleos wallet unlock --password $PW` would put the password in `/proc/<pid>/cmdline`. We pipe via stdin — invisible to `ps -ef`.
3. **Permanent-error backoff.** A not-yet-whitelisted BP would otherwise hammer the chain with `missing authority` every interval. Permanent errors trigger 60s → 120s → ... → 30min exponential backoff. Transient errors (timeouts, 5xx, ECONNREFUSED) keep normal cadence.
4. **Stale-nodeos preflight.** `get_info` head_block_time freshness check before each push prevents pre-expired transactions when the local node is lagging.
5. **No on-chain governance gate for being an oracle.** Verified empirically on 2026-05-07 — a BP with `linkauth` to `delphioracle::write` can push successfully on first call. The contract auto-registers users. No saltant approval, no BP multisig, no producer table to be added to. Onboarding is purely a BP-side permission setup.
6. **Pair registration IS governance.** Adding a new pair (e.g. `btcusd`) goes through `newbounty` / `editbounty` and requires saltant's auth (he holds delphioracle@active threshold-1) or BP multisig (`eosio.prods@active` is also in the threshold).

## Layout

```
xpr-oracle/
├── install.sh           ← interactive + --non-interactive setup
├── monitor.sh           ← Telegram heartbeat monitor (optional, cron-friendly)
├── src/
│   ├── index.ts         ← main loop, config validation, signal handling
│   ├── push.ts          ← cleos shellout, wallet unlock via stdin
│   ├── feeds.ts         ← CEX adapters (Binance, KuCoin, Bitget, Coinbase,
│   │                       Kraken, Bitfinex, OKX, Bybit, MEXC, Gate.io, CoinGecko)
│   ├── aggregate.ts     ← median + outlier rejection
│   ├── backoff.ts       ← permanent-vs-transient error classification
│   ├── health.ts        ← nodeos get_info preflight
│   ├── types.ts
│   ├── log.ts
│   └── *.test.ts        ← node --test, no test framework dep
├── docs/
│   ├── BP-ONBOARDING.md ← end-to-end setup
│   ├── PERMISSIONS.md   ← oracle permission + linkauth
│   ├── LOCAL-NODE.md    ← pointing at your nodeos
│   ├── HOSTING.md       ← API node, not producer node
│   ├── FEEDS.md         ← pair/feed compatibility, pegged-token guidance
│   └── GOVERNANCE.md    ← adding new pairs (the only governance step)
├── systemd/xpr-oracle.service
└── config.example.json
```

## How to do common tasks

### "Install for a BP" (the most likely ask)
Use `./install.sh`. It handles prereqs, xpr.start auto-detect, on-chain checks, build, config gen, optional systemd. For autonomous installs:
```bash
./install.sh --non-interactive \
  --account=<bp> \
  --endpoint=http://127.0.0.1:8888 \
  --pairs=xprusd \
  --interval=300 \
  --wallet-password-file=/etc/xpr-oracle/wallet.pw \
  --install-systemd
```

### "Add a new exchange"
One entry in `src/feeds.ts` `adapters` map: `(symbol) => Promise<number>`. Add it to `docs/FEEDS.md` with the symbol-format gotcha. No daemon plumbing needed.

### "Add a new pair"
1. Compose the `delphioracle::newbounty` + `editbounty` action JSON (see `docs/GOVERNANCE.md`).
2. Either DM saltant on Telegram (he can sign solo) or open a BP multisig.
3. Once registered on-chain, add the pair to `config.json` and update the pair→feeds map in `install.sh`.

### "Verify a BP's setup is correct"
```bash
# linkauth on-chain?
curl -fsS https://proton.eosusa.io/v1/chain/get_account \
  -d '{"account_name":"<bp>"}' \
  | jq '.permissions[] | select(.perm_name=="oracle") | .linked_actions'
# expected: [ { "account": "delphioracle", "action": "write" } ]

# pushes landing on-chain?
curl -fsS https://proton.eosusa.io/v2/history/get_actions?account=delphioracle\&act.name=write\&limit=5 \
  | jq '.actions[] | {time: .["@timestamp"], owner: .act.data.owner, quotes: .act.data.quotes}'
```

### "Debug a daemon that's not pushing"
1. `journalctl -u xpr-oracle -f` — look for stale-nodeos warnings, backoff messages, cleos error output.
2. `cleos --url http://127.0.0.1:8888 wallet list` — is the wallet unlocked?
3. `XPR_ORACLE_INSECURE_KEY=1 npm run dry-run` from the install dir — does the fetch+aggregate path work without involving cleos?
4. If the error is `missing authority`, recheck the linkauth (#1).
5. If the error is `expired_tx_exception`, the local nodeos head is stale — `cleos --url <ep> get info` and verify head_block_time vs wall clock.

## Conventions

- **No new runtime npm deps without justification.** "Zero deps" is a feature.
- **Match the surrounding code.** Same logging pattern, same error-throwing style. `log.info / log.warn / log.error`, error messages as plain `Error` instances with informative `.message`.
- **Tests in `src/*.test.ts`** using Node's built-in `node --test`. No Jest, no Vitest.
- **`tsconfig.json` excludes `*.test.ts`** from build output.
- **Commits**: feature commits explain the *why*, especially when reverting / pivoting.

## What NOT to do

- Don't reintroduce `@proton/cli` for daemon signing (the architectural decision in commit `3726408` killed it for cause — see commit message).
- Don't reintroduce `@proton/js` either (commit `27efc08` removed it; we shell out to cleos instead).
- Don't put the wallet password on the cleos CLI (`--password $PW`). Stdin only. See `src/push.ts`.
- Don't write a "BP multisig whitelist" flow into onboarding — it's not how the contract gates anything (verified 2026-05-07).
- Don't relax the chmod-600 check on `walletPasswordFile` without a corresponding env-var bypass.
- Don't add `console.log(password)` — even briefly during debugging. The string is only on the heap because there's no way around it; don't expand the surface.

## When stuck

- The actual maintainer is `paulgnz`. The repo is https://github.com/paulgnz/xpr-oracle.
- BP coordination happens in the XPR Network Block Producers Telegram. Saltant is responsive there for delphioracle questions.
- When in doubt, prefer simpler — the codebase has been pivoted three times to remove complexity, not add it.
