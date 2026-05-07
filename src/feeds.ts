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
