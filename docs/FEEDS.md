# Feed sources

The daemon supports two **categories** of price source. They are not interchangeable — mixing them carelessly weakens the median + outlier-rejection guarantees the daemon depends on.

## 1. Direct CEX adapters

Each samples its own order book independently. These are what the daemon was designed around: the more direct CEX feeds you have, the stronger the median and the harder it is for any single source (or an attacker manipulating one exchange) to push a bad value through.

| `feedId` prefix | Symbol example | Notes |
|---|---|---|
| `binance` | `BTCUSDT` | Canonical USDT pairs. XPR was historically delisted — verify the symbol exists before using. |
| `kucoin` | `XPR-USDT` | Dash-separated. |
| `bitget` | `XPRUSDT` | Concatenated. |
| `coinbase` | `BTC-USD` | Spot USD pairs. Few small-cap listings. |
| `kraken` | `XBTUSD`, `ETHUSD` | Note Kraken's quirky asset codes (`XBT` for BTC). |
| `bitfinex` | `tBTCUSD` | `t`-prefix is part of the API symbol. |
| `okx` | `BTC-USDT` | Dash-separated. |
| `bybit` | `BTCUSDT` | Spot category only. |
| `mexc` | `XPRUSDT` | Same shape as Binance. |
| `gate` | `XPR_USDT` | Underscore-separated. |

Verify the exact symbol on each exchange before configuring. A 404 from one feed isn't fatal (the daemon logs and skips it) but it's noise you don't need.

## 2. Aggregators

Aggregators (CoinGecko, CoinMarketCap, CryptoCompare) publish a volume-weighted price that is *itself* derived from many of the same CEXes you're polling directly. Including one alongside several direct CEX feeds partly double-counts those exchanges and weakens outlier rejection — exactly the opposite of what you want.

| `feedId` prefix | Symbol example | Notes |
|---|---|---|
| `coingecko` | `proton`, `bitcoin`, `ethereum` | Symbol is the CoinGecko `id` slug. Quoted against USD. Free tier: ~30 req/min — fine for ≥60s ticks. |

**Recommended use:** include one aggregator as a *fallback* for resilience when CEX APIs are flaky, with `minSources` set such that the daemon prefers a median of direct-CEX samples when available. Don't make aggregators a majority of your feed set.

**Not built in:**
- **CoinMarketCap.** Free tier requires an API key and caps at 333 calls/day, which is too tight for a 60s tick (1440 calls/day). Add it if you have a paid plan and value the redundancy.
- **CryptoCompare.** Significant overlap with CoinGecko on free tier; not enough additional independence to justify the second adapter.

## 3. Pegged-token and derivative pairs

XPR has several pegged tokens (XMD ≈ USD, XUSDC ≈ USDC, XBTC ≈ BTC, XETH ≈ ETH, XDOGE ≈ DOGE, etc.). The on-chain pair `xbtcusd` is asking for **the price of BTC**, not the price of XBTC-the-XPR-token: Atomic Drops and Atomic Assets consumers use it to convert "drop priced at $25" into "X XBTC needed today." Use the underlying CEX symbol:

| XPR pair | Use feeds for | Example feed list |
|---|---|---|
| `xprusd` | XPR | `kucoin:XPR-USDT`, `bitget:XPRUSDT`, `mexc:XPRUSDT`, `gate:XPR_USDT`, `coingecko:proton` |
| `xbtcusd` | BTC | `kucoin:BTC-USDT`, `coinbase:BTC-USD`, `kraken:XBTUSD`, `bitget:BTCUSDT`, `coingecko:bitcoin` |
| `xethusd` | ETH | `kucoin:ETH-USDT`, `coinbase:ETH-USD`, `kraken:ETHUSD`, `bitget:ETHUSDT`, `coingecko:ethereum` |
| `xusdcusd` | USDC | `coinbase:USDC-USD`, `kraken:USDCUSD`, `coingecko:usd-coin` (≈1 — you're pricing the peg, not the wrapper) |
| `xmdusd` | USD reference | `coinbase:USDC-USD`, `kraken:USDTUSD`, `coingecko:tether` (effectively reports ~1.0 unless USDT/USDC depeg) |

The pair name encodes "the underlying asset's USD price," not "the wrapped token's price relative to USD." Don't try to source `xbtcusd` from a thinly-traded XPR-side AMM — it's circular and gameable.

The same compatibility map is hardcoded into `install.sh` so the interactive picker shows you only feeds that actually trade the right asset for each pair you select.

## Adding a new exchange

`src/feeds.ts` — one entry in the `adapters` map. The contract is `(symbol: string) => Promise<number>`:

```ts
mynewexchange: async (symbol) => {
  const j = await fetchJson<{ price: string }>(
    `https://api.example.com/ticker?symbol=${symbol}`,
  );
  return num(j?.price, `mynewexchange:${symbol}`);
},
```

Throw on bad data — the daemon catches per-feed errors and proceeds with what's available. Don't add retry/backoff here; the next tick is a natural retry. Don't include API keys in the adapter; if a new feed needs auth, plumb it through config.

## Picking a healthy feed mix

Three principles:

1. **Geographic / regulatory diversity.** A KYC sweep that takes one exchange offline shouldn't dominate your feed set. Mix US (Coinbase, Kraken), Asia (KuCoin, Bitget, MEXC, OKX, Bybit, Gate.io), and EU (Bitfinex) sources.
2. **Liquidity diversity.** Don't fill the set with low-volume pairs — they're easier to manipulate. The aggregate is only as healthy as the underlying order books.
3. **Aggregator as garnish, not main course.** At most one aggregator per pair, with `minSources` ≥ 2 so a single-source fallback never silently pushes.

For `xprusd`, a defensible default is: KuCoin + Bitget + MEXC + Gate.io + CoinGecko = 4 direct + 1 aggregator, `minSources: 2`, `maxDeviationPct: 2.5`. That's what `config.example.json` ships with.
