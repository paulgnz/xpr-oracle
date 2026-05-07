/**
 * CEX feed adapters. Each adapter is `(symbol) => Promise<number>`.
 * Add a new exchange by adding a key to `adapters`; the rest of the daemon
 * is exchange-agnostic.
 */

import type { FeedAdapter } from "./types.js";

const TIMEOUT_MS = 5_000;

async function fetchJson<T = unknown>(url: string): Promise<T> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctl.signal });
    if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(t);
  }
}

function num(x: unknown, ctx: string): number {
  const n = typeof x === "number" ? x : parseFloat(String(x));
  if (!isFinite(n) || n <= 0) throw new Error(`${ctx}: bad price ${JSON.stringify(x)}`);
  return n;
}

/**
 * Direct CEX adapters. Each samples its own order book independently — these
 * are the strongest contributions to the median.
 */

const adapters: Record<string, FeedAdapter> = {
  binance: async (symbol) => {
    const j = await fetchJson<{ price: string }>(
      `https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`,
    );
    return num(j.price, `binance:${symbol}`);
  },

  kucoin: async (symbol) => {
    const j = await fetchJson<{ data?: { price: string } }>(
      `https://api.kucoin.com/api/v1/market/orderbook/level1?symbol=${symbol}`,
    );
    return num(j?.data?.price, `kucoin:${symbol}`);
  },

  bitget: async (symbol) => {
    const j = await fetchJson<{ data?: Array<{ lastPr: string }> }>(
      `https://api.bitget.com/api/v2/spot/market/tickers?symbol=${symbol}`,
    );
    return num(j?.data?.[0]?.lastPr, `bitget:${symbol}`);
  },

  coinbase: async (symbol) => {
    const j = await fetchJson<{ price: string }>(
      `https://api.exchange.coinbase.com/products/${symbol}/ticker`,
    );
    return num(j?.price, `coinbase:${symbol}`);
  },

  kraken: async (symbol) => {
    const j = await fetchJson<{ result?: Record<string, { c?: string[] }> }>(
      `https://api.kraken.com/0/public/Ticker?pair=${symbol}`,
    );
    const key = j.result ? Object.keys(j.result)[0] : undefined;
    return num(key ? j.result?.[key]?.c?.[0] : undefined, `kraken:${symbol}`);
  },

  // Bitstamp — symbol is lowercase concatenated (e.g. "btcusd", "usdcusd").
  // Particularly useful for USDC/USD and USDT/USD where Coinbase doesn't list
  // a direct market (USDC is a settlement asset on Coinbase, not spot-traded).
  bitstamp: async (symbol) => {
    const j = await fetchJson<{ last: string }>(
      `https://www.bitstamp.net/api/v2/ticker/${symbol.toLowerCase()}/`,
    );
    return num(j?.last, `bitstamp:${symbol}`);
  },

  // Bitfinex — symbol prefixed with "t", e.g. "tBTCUSD". Response is a flat
  // array; index 6 is LAST_PRICE per the v2 ticker spec.
  bitfinex: async (symbol) => {
    const j = await fetchJson<unknown[]>(
      `https://api-pub.bitfinex.com/v2/ticker/${symbol}`,
    );
    return num(j?.[6], `bitfinex:${symbol}`);
  },

  // OKX — symbol uses dash separator, e.g. "BTC-USDT".
  okx: async (symbol) => {
    const j = await fetchJson<{ code: string; data?: Array<{ last: string }> }>(
      `https://www.okx.com/api/v5/market/ticker?instId=${symbol}`,
    );
    if (j.code !== "0") throw new Error(`okx:${symbol}: code=${j.code}`);
    return num(j?.data?.[0]?.last, `okx:${symbol}`);
  },

  // Bybit — spot category, symbol e.g. "BTCUSDT".
  bybit: async (symbol) => {
    const j = await fetchJson<{
      retCode: number;
      result?: { list?: Array<{ lastPrice: string }> };
    }>(`https://api.bybit.com/v5/market/tickers?category=spot&symbol=${symbol}`);
    if (j.retCode !== 0) throw new Error(`bybit:${symbol}: retCode=${j.retCode}`);
    return num(j?.result?.list?.[0]?.lastPrice, `bybit:${symbol}`);
  },

  // MEXC — symbol e.g. "BTCUSDT". Same shape as Binance.
  mexc: async (symbol) => {
    const j = await fetchJson<{ price: string }>(
      `https://api.mexc.com/api/v3/ticker/price?symbol=${symbol}`,
    );
    return num(j?.price, `mexc:${symbol}`);
  },

  // Gate.io — symbol uses underscore, e.g. "BTC_USDT".
  gate: async (symbol) => {
    const j = await fetchJson<Array<{ last: string }>>(
      `https://api.gateio.ws/api/v4/spot/tickers?currency_pair=${symbol}`,
    );
    return num(j?.[0]?.last, `gate:${symbol}`);
  },

  /**
   * CoinMarketCap — aggregator. Symbol is the CMC ticker (e.g. "XPR", "BTC").
   * Requires a CMC API key in `CMC_API_KEY` env var (free Basic plan is fine
   * at 5-min cadence with a single pair: ~288 req/day vs ~333/day quota).
   * Adapter throws if the key isn't set so misconfiguration fails fast.
   * Same correlation caveat as CoinGecko applies.
   */
  coinmarketcap: async (symbol) => {
    const key = process.env.CMC_API_KEY;
    if (!key) throw new Error(`coinmarketcap:${symbol}: CMC_API_KEY env var not set`);
    const url = `https://pro-api.coinmarketcap.com/v2/cryptocurrency/quotes/latest?symbol=${symbol}&convert=USD`;
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        signal: ctl.signal,
        headers: { "X-CMC_PRO_API_KEY": key, "Accept": "application/json" },
      });
      if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
      const j = (await res.json()) as {
        data?: Record<string, Array<{ quote?: { USD?: { price?: number } } }>>;
      };
      const arr = j?.data?.[symbol];
      const price = arr?.[0]?.quote?.USD?.price;
      return num(price, `coinmarketcap:${symbol}`);
    } finally {
      clearTimeout(t);
    }
  },

  /**
   * CoinGecko — aggregator. Symbol is the CoinGecko `id` slug
   * (e.g. "proton", "bitcoin", "ethereum"), priced against USD.
   *
   * NOTE on correlation: CoinGecko's price is itself a volume-weighted median
   * of many of the CEXes you're already polling directly (KuCoin, Bitget, etc.
   * for XPR). Including it next to those direct sources partly double-counts
   * them and weakens the outlier-rejection guarantee. Use it as a fallback
   * sanity-check, not as a peer in the median. Free tier is rate-limited to
   * ~30 req/min — fine for a 60s tick, tight for a 30s tick.
   */
  coingecko: async (id) => {
    const j = await fetchJson<Record<string, { usd: number }>>(
      `https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd`,
    );
    return num(j?.[id]?.usd, `coingecko:${id}`);
  },
};

export function knownExchanges(): string[] {
  return Object.keys(adapters);
}

export async function fetchFeed(feedId: string): Promise<number> {
  const idx = feedId.indexOf(":");
  if (idx === -1) throw new Error(`feedId must be "<exchange>:<symbol>", got ${feedId}`);
  const exchange = feedId.slice(0, idx);
  const symbol = feedId.slice(idx + 1);
  const adapter = adapters[exchange];
  if (!adapter) {
    throw new Error(
      `unknown exchange "${exchange}". Known: ${knownExchanges().join(", ")}`,
    );
  }
  if (!symbol) throw new Error(`missing symbol in feedId: ${feedId}`);
  return adapter(symbol);
}
