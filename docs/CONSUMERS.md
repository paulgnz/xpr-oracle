# Consuming `delphioracle` prices

This repo is the **producer** side — it pushes prices on-chain. This doc covers the **consumer** side: how dApps, contracts, and scripts read those prices.

## On-chain layout (the only thing you really need to know)

The contract at account **`delphioracle`** holds a `datapoints` table. The table is **scoped per pair** — each registered pair (`xprusd`, `btcusd`, `ethusd`, `usdcusd`, `xprbtc`) has its own scope of recent quotes.

A typical row:

```json
{
  "id": 20,
  "owner": "alvosec",
  "value": 2712,
  "median": 2710,
  "timestamp": "2026-05-07T23:05:06.000"
}
```

| Field | What it is |
|---|---|
| `id` | Auto-incrementing per-scope counter. |
| `owner` | The BP that pushed *this* quote. |
| `value` | This BP's individual quote, integer-scaled by `quoted_precision`. |
| `median` | **Rolling median across recent quotes from all oracles.** This is the value most consumers read. |
| `timestamp` | When the row was written (UTC). |

The `median` field is what makes the contract trust-minimized — even if one BP pushes a wildly wrong `value`, the median across all active oracles smooths it out.

## To convert `value` / `median` to a floating-point price

Divide by `10^quoted_precision`. Each pair has its own precision — see [pairs in the README](../README.md#pairs-currently-registered-on-delphioracle):

| Pair | `quoted_precision` | Example: median = 2710 → |
|---|---|---|
| `xprusd` | 6 | $0.002710 / XPR |
| `btcusd` | 4 | $0.2710 (would be ~80,000 in practice) |
| `ethusd` | 4 | $0.2710 (would be ~2,300 in practice) |
| `usdcusd` | 6 | $0.002710 (would be ~1.0 in practice) |
| `xprbtc` | 8 | 0.00000271 BTC / XPR |

So `median: 2843` for `xprusd` (precision 6) → `2843 / 1_000_000 = $0.002843 per XPR`.

## Reading off-chain

### curl + jq

The simplest possible query — the latest row in the `datapoints` table for a pair, sorted descending:

```bash
curl -s https://proton.eosusa.io/v1/chain/get_table_rows \
  -d '{
    "code":   "delphioracle",
    "scope":  "btcusd",
    "table":  "datapoints",
    "limit":  1,
    "reverse": true,
    "json":   true
  }' | jq '.rows[0] | {value, median, owner, timestamp}'
```

Or for a quick "what's the live USD/XPR median right now" one-liner:

```bash
curl -s https://proton.eosusa.io/v1/chain/get_table_rows \
  -d '{"code":"delphioracle","scope":"xprusd","table":"datapoints","limit":1,"reverse":true,"json":true}' \
  | jq '.rows[0].median / 1000000'
```

### TypeScript / JavaScript

```ts
import { JsonRpc } from "@proton/js";

const rpc = new JsonRpc("https://proton.eosusa.io");

interface Datapoint {
  id: number;
  owner: string;
  value: number;
  median: number;
  timestamp: string;
}

const PRECISION: Record<string, number> = {
  xprusd: 6, btcusd: 4, ethusd: 4, usdcusd: 6, xprbtc: 8,
};

async function getMedianPrice(pair: string): Promise<number> {
  const { rows } = await rpc.get_table_rows({
    code: "delphioracle",
    scope: pair,
    table: "datapoints",
    limit: 1,
    reverse: true,
    json: true,
  });
  if (!rows.length) throw new Error(`no datapoints for ${pair}`);
  const r = rows[0] as Datapoint;
  // Optional freshness check — reject quotes older than 30 min:
  const ageSec = (Date.now() - new Date(r.timestamp + "Z").getTime()) / 1000;
  if (ageSec > 30 * 60) throw new Error(`stale: ${pair} last update ${ageSec}s ago`);
  const precision = PRECISION[pair] ?? 6;
  return r.median / Math.pow(10, precision);
}

const btcUsd = await getMedianPrice("btcusd");
console.log(`BTC/USD = $${btcUsd.toLocaleString()}`);
```

## Reading on-chain (smart contract)

If your contract needs to convert "drop priced at $25" → "X BTC needed at current spot," you read the datapoints table directly from your contract's action. AssemblyScript / `proton-tsc`:

```ts
import { Contract, Name, TableStore, check, U128 } from "proton-tsc";
import { Asset, Symbol } from "proton-tsc/asset";

@table("datapoints", noabigen)
class Datapoint extends Table {
  constructor(
    public id: u64 = 0,
    public owner: Name = new Name(),
    public value: u64 = 0,
    public median: u64 = 0,
    public timestamp: u64 = 0,
  ) { super(); }

  @primary
  get primary(): u64 { return this.id; }
}

@contract
class MyDApp extends Contract {
  // Read latest median price for a pair (scope = pair name).
  private getOraclePrice(pair: Name): u64 {
    const dp = new TableStore<Datapoint>(
      Name.fromString("delphioracle"),
      pair,
    );
    // Iterate from newest (highest id) backwards
    const it = dp.last();
    check(it !== null, "no oracle data for pair");
    // Optional freshness check: reject if older than 30 min
    const ageSecs = currentTimeSec() - (it!.timestamp / 1000000);
    check(ageSecs < 30 * 60, "oracle data is stale");
    return it!.median;
  }

  @action("buynft")
  buyNft(buyer: Name, usdPriceCents: u64): void {
    // Convert "$25.00" (= 2500 cents) to BTC amount at current rate.
    // btcusd has precision 4, so median = $80,000 → 800,000,000.
    const btcUsdMedian = this.getOraclePrice(Name.fromString("btcusd"));
    // btc_amount_in_satoshis = (usd_cents * 10^8) / (btcusd_median * 100 / 10^4)
    // Be careful with overflow — use U128 for the math.
    // ... (your conversion logic)
  }
}
```

C++ (`eosio.cdt` / native):

```cpp
#include <eosio/eosio.hpp>
#include <eosio/asset.hpp>

struct [[eosio::table("datapoints"), eosio::contract("delphioracle")]] datapoint {
  uint64_t           id;
  eosio::name        owner;
  uint64_t           value;
  uint64_t           median;
  eosio::time_point  timestamp;
  uint64_t primary_key() const { return id; }
};

typedef eosio::multi_index<"datapoints"_n, datapoint> datapoints_t;

uint64_t get_median(eosio::name pair) {
  datapoints_t dp(eosio::name("delphioracle"), pair.value);
  auto rit = dp.rbegin();  // newest first
  eosio::check(rit != dp.rend(), "no oracle data");
  eosio::check(
    rit->timestamp.sec_since_epoch() > eosio::current_time_point().sec_since_epoch() - 1800,
    "oracle data is stale (>30 min old)"
  );
  return rit->median;
}
```

## Best practices for consumers

1. **Always read `median`, not `value`.** `value` is one BP's quote and can be wrong; `median` is the contract's aggregated view.
2. **Always check `timestamp` freshness.** If no oracle has pushed in N minutes (because every BP's daemon happens to be down), don't trust the last value. 30 minutes is a reasonable default rejection window for fast-moving assets; 60 min for stables.
3. **Match the precision exactly** when reconstructing the float. Wrong precision = price off by 100×–10000×.
4. **Don't query the chain on every read in a hot path.** Cache the price for ~30s (matches the rate at which new pushes land). If you're doing per-transaction lookups in a smart contract, that's already on-chain so caching is implicit.
5. **For large purchases (>$10k drops, etc.), require multiple oracles to agree.** Read the last N rows and verify the spread between min/max is below some threshold; the median field is robust but a freshness + spread check is belt-and-suspenders.
6. **For maximum trust, read both `delphioracle` AND Metallicus's `oracles` contract** ([explorer](https://explorer.xprnetwork.org/account/oracles)) and reject if they disagree by more than a few percent. They're independent oracle infrastructures — agreement = high confidence.

## Why two values per row (`value` and `median`)?

`value` is "what *this BP* pushed." `median` is "the contract's median across all recent BPs." The contract recomputes `median` on every `write` action by sliding a window over recent quotes from all oracles in the `users` table.

So reading `rows[0].median` from the latest row gives you the freshest contract-computed median. Reading `rows[0].value` would give you the freshest *individual BP's* quote — useful if you want to debug which BP is publishing what, but not what you want as your price input.

## Related

- [DelphiOracle upstream contract](https://github.com/eostitan/delphioracle) — same datapoint structure as this XPR Network deployment.
- [Metallicus `oracles` contract](https://explorer.xprnetwork.org/account/oracles) — sibling contract with 22 feeds; different on-chain layout but similar conceptual model.
- [docs/FEEDS.md](FEEDS.md) — what's *fed into* delphioracle by the producer side.
