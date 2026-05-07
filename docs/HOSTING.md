# Hosting the pusher

You asked the right question: *should I run this on my BP node, or on a Railway/cloud instance?* Short answer: **on your BP node, as a separate systemd unit and a separate Linux user.** Other options are fine for testing.

## Recommended: alongside your BP node

Pros:
- Same operational rigor as your BP infra (monitoring, backups, on-call).
- No extra cost.
- Tiny resource footprint (~50 MB RAM, negligible CPU between ticks).
- Network egress is to public CEX APIs — no inbound exposure.
- The proton CLI keystore lives next to the BP's existing tooling.

Operational rules:

1. **Separate Linux user** (`xpr-oracle`) — don't run as root or as your BP's user.
2. **Separate systemd unit** — see `systemd/xpr-oracle.service`.
3. **Don't share the BP's signing key.** Use a dedicated `oracle` permission (see [PERMISSIONS.md](PERMISSIONS.md)).
4. If your BP node runs validator software in a container, run the pusher in a sibling container (different user, different volume for `~/.proton`).

## Acceptable: small VPS

If your BP node doesn't have spare capacity or you want strict isolation, a $5/mo VPS (Hetzner, OVH, DigitalOcean, Vultr) is plenty. The pusher is so light that the CEX HTTP latency dominates everything else.

## Not recommended for production: Railway / Render / Fly / Heroku-style PaaS

These work for **testing** but have real downsides for an oracle:

- **Key handling.** You'll have to put the oracle private key in their environment variables. With the systemd setup the key sits in the proton CLI keystore, encrypted at rest. Env vars on a PaaS are decrypted in process memory and visible to platform staff/tooling.
- **Cold starts and sleeps.** Free/cheap tiers may sleep idle services. Oracle pushes need to be reliably on-cadence.
- **Egress IP rotation** can trigger CEX API rate limits.
- **No journald** — you lose the structured log pipeline you already have for BP ops.

If you must use Railway for a quick test, fork the daemon to read keys from env and sign with `@proton/js` directly (rather than shelling out to the CLI). That's a meaningful divergence from this repo's design — keep it on a branch, not main.

## Sizing

| Resource | Typical |
|---|---|
| RAM | 50–80 MB |
| CPU | <1% steady, brief spikes during HTTP fetch |
| Disk | <100 MB (code + node_modules) |
| Network | A few KB out per tick, <1 MB/day total |

A 1 vCPU / 512 MB box runs many pushers concurrently.

## Geographic placement

Put the pusher near the CEX APIs you read, not near the XPR API node — fetch latency dominates. AWS `us-east-1` and `ap-northeast-1` cover Binance/KuCoin/Bitget/Coinbase well. If your BP node is already in one of those regions, you're set.

## Health checks

A heartbeat is the easiest. Add a small post-tick HTTP `GET` to a service like Healthchecks.io or your existing alerting:

```ts
// in src/index.ts after a successful pushQuotes:
await fetch(process.env.HEARTBEAT_URL!).catch(() => {});
```

Page the on-call when the heartbeat misses 3 cycles.

## Key takeaway

The pusher's security and reliability story is dominated by **where the signing key lives** and **how reliably the daemon runs** — not by which hosting provider you use. systemd on your existing BP infra gives you both for free. Treat anything else as a downgrade unless you have a specific reason.
