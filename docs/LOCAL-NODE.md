# Pointing the daemon at your local nodeos

If you run a BP or API node on XPR Network, you almost certainly already have a `nodeos` instance serving HTTP RPC — push through it instead of the public foundation endpoint.

## Why

| | Public endpoint (`proton.eosusa.io`) | Your local nodeos |
|---|---|---|
| Latency | 50–300ms | <5ms |
| Rate limits | Yes (shared) | No |
| Failure mode | Someone else's outage breaks your pushes | You already monitor this node |
| TaPoS freshness | Whatever they're at | What you're at |
| Trust | You're trusting their infra to relay your signed tx | You're trusting your own |

This is the integration point with the canonical [`xpr.start`](https://github.com/XPRNetwork/xpr.start) BP/API node stack — if you're running that, you have everything you need.

## How the daemon picks its endpoint

The daemon shells out to `cleos --url <endpoint> push action …`. The endpoint comes from `config.endpoint`, full stop — no third-party discovery service, no fallback chain, no library magic. Whatever URL you put in config is the URL `cleos` hits.

Set it in `config.json`:

```json
{ "endpoint": "http://127.0.0.1:8888" }
```

Or any URL your node serves on. The daemon will only ever contact that URL.

> **Why not `@proton/cli`?** `@proton/cli@0.1.98` ignores the positional URL argument to `endpoint:set` and forces an interactive picker against a hardcoded list of foundation/community endpoints (verified by reading `lib/commands/endpoint/set.js`). It cannot be pointed at an arbitrary local node. `cleos` accepts `--url` cleanly and ships with nodeos, so it's the better fit anyway.

## nodeos requirements

For the daemon to push, your nodeos needs:

- **`http_plugin` enabled** with an HTTP endpoint:
  ```
  plugin = eosio::http_plugin
  http-server-address = 127.0.0.1:8888
  ```
- **`chain_api_plugin` enabled** — needed for `get_info` (TaPoS reference) and `push_transaction`:
  ```
  plugin = eosio::chain_api_plugin
  ```
- **CORS not required** — the daemon connects server-side.
- **`producer_api_plugin` should NOT be exposed.** It enables block-producer-only RPCs that you do not want reachable from anywhere except `localhost` for emergency operations. Most `xpr.start` configs already get this right.

Verify your node responds:

```bash
curl -s http://127.0.0.1:8888/v1/chain/get_info | jq '{chain_id, head_block_num, head_block_time}'
```

You should see the mainnet `chain_id` and a recent `head_block_time`.

## Use `127.0.0.1`, not the public IP

Bind nodeos's HTTP listener to loopback (`127.0.0.1:8888`), not the public interface. If your daemon and nodeos are on the same host (recommended) loopback is all you need. Exposing `/v1/chain/push_transaction` to the public internet is fine *technically* (signed transactions are valid regardless of how they arrive) but it makes you a free public RPC for anyone who finds your IP — and any rate-limit or DoS surface on `nodeos` becomes your problem.

If the daemon and node are on different hosts, use a private network (VPC, WireGuard, Tailscale) — never the public IP.

## TaPoS / head-block freshness

Every transaction includes a TaPoS (transaction-as-proof-of-stake) reference to a recent block. The proton CLI fetches that reference from whichever node it's pointed at. If your local node is lagging behind the network, your transactions can expire before propagating. Two safeguards:

1. **Monitor head-block lag.** A simple cron:
   ```bash
   curl -s http://127.0.0.1:8888/v1/chain/get_info \
     | jq -r '.head_block_time' \
     | xargs -I {} date -d {} +%s \
     | awk '{ now=systime(); if (now - $1 > 10) print "lag:", now-$1, "s" }'
   ```
2. **Have a fallback chain entry.** Keep `proton chain:add proton` (the public endpoint) configured even if you don't use it day-to-day. If your local node falls behind, switch the daemon's chain target with one command and let the public endpoint carry the load while you investigate.

## Wallet password handling

Signing is done by `keosd` against a wallet you've imported the oracle key into. The daemon optionally runs `cleos wallet unlock` before each push, which means the password needs to be readable from the daemon process. See [PERMISSIONS.md](PERMISSIONS.md) §5 for the three options (chmod-600 file, env var, externally-managed unlock).

## Verifying the end-to-end path

Before you go live, run one harmless action through the daemon's full path to confirm cleos + keosd + local nodeos + propagation all work:

```bash
# self-transfer 0.0001 XPR — replace mybp@active if you want to test under
# the oracle permission specifically (which only works after the linkauth)
cleos --url http://127.0.0.1:8888 transfer mybp mybp '0.0001 XPR' 'oracle setup test' -p mybp@active
```

Then look up the txid on https://explorer.xprnetwork.org. If it shows up there, your local node successfully relayed and the network accepted it. If not, the explorer's "transaction not found" tells you propagation failed — usually a TaPoS / lagging-node issue.

## Switching to a different endpoint

Edit `endpoint` in `config.json` and restart the daemon. Useful for fail-over to a public endpoint while your local node is upgrading.
