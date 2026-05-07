# Pointing the daemon at your local nodeos

If you run a BP or API node on XPR Network, you almost certainly already have a `nodeos` instance serving HTTP RPC — you should push through it instead of the public foundation endpoint.

## Why

| | Public endpoint (`proton.eosusa.io`) | Your local nodeos |
|---|---|---|
| Latency | 50–300ms | <5ms |
| Rate limits | Yes (shared) | No |
| Failure mode | Someone else's outage breaks your pushes | You already monitor this node |
| TaPoS freshness | Whatever they're at | What you're at |
| Trust | You're trusting their infra to relay your signed tx | You're trusting your own |

This is also the integration point with the canonical [`xpr.start`](https://github.com/XPRNetwork/xpr.start) BP/API node stack — if you're running that, you have everything you need.

## One-time setup

The proton CLI's "chain" abstraction is just a `(name → chainId + endpoint)` map. Add an entry pointing at your local node:

```bash
proton chain:add proton-local \
  384da888112027f0321850a169f737c33e53b388aad48b5adace4bab97f437e0 \
  http://127.0.0.1:8888

proton chain:set proton-local
proton chain:get   # confirm it's selected
```

Replace `127.0.0.1:8888` with whatever your node serves on. From this point every `proton action …` call (which is what the daemon shells out to) hits your nodeos.

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

## Keystore password (or rather, the lack of one)

The proton CLI keystore can be created without a password. For a daemon that signs every minute, this is the standard pattern — the encryption layer was designed for interactive workflows where a human types a password to unlock. For non-interactive signing, you instead:

- **Skip the password** at `proton key:add` (press enter when prompted).
- **Lean on filesystem permissions**: `chmod 700 ~/.proton`, run the daemon under a dedicated unprivileged user, use full-disk encryption on the host.

That's how the rest of the EOSIO/Antelope ecosystem handles validator and oracle daemon keys. The threat model is "an attacker who already has read access to the daemon user's home directory has compromised everything regardless" — the keystore password wouldn't have saved you.

If you need a stronger guarantee than filesystem permissions, the right answer is hardware: an HSM or a remote signer process, not a password on a file. That's a future feature, not the current default.

## Verifying the end-to-end path

Before you go live, run one harmless action through the daemon's full path to confirm signing + local nodeos + propagation all work:

```bash
# self-transfer 0.0001 XPR — replace mybp@oracle if you've set up a different perm
proton transfer mybp mybp '0.0001 XPR' 'oracle setup test' -p mybp@active
```

Then look up the txid on https://explorer.xprnetwork.org. If it shows up there, your local node successfully relayed and the network accepted it. If not, the explorer's "transaction not found" tells you propagation failed — usually a TaPoS / lagging-node issue.

## Switching back to the public endpoint

```bash
proton chain:set proton          # the default public-endpoint entry
```

Useful for ad-hoc queries when your local node is being upgraded.
