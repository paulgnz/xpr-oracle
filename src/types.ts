/** Strongly-typed config and feed primitives. */

export type FeedAdapter = (symbol: string) => Promise<number>;

export interface PairConfig {
  /** Pair name registered on delphioracle (e.g. "xprusd"). */
  name: string;
  /** "<exchange>:<symbol>" identifiers — e.g. "kucoin:XPR-USDT". */
  feeds: string[];
  /** Must match the on-chain pair's quoted_precision. */
  quotedPrecision: number;
  /** Reject any feed sample further than this % from the median. */
  maxDeviationPct: number;
  /** Skip the pair if fewer than this many feeds survive outlier rejection. */
  minSources: number;
}

export interface Config {
  /** XPR account that signs the write. Recommended: a dedicated permission's parent account. */
  account: string;
  /** Permission to sign with. Recommended: a dedicated "oracle" permission, NOT active. */
  permission: string;
  /** Almost always "delphioracle". */
  contract: string;
  /** Push cadence. Tune per your CPU/NET budget; 30–120s is typical. */
  intervalSeconds: number;
  /** Diagnostic-only — pusher uses the proton CLI's configured endpoint. */
  endpoints: string[];
  pairs: PairConfig[];
}

export interface FeedSample {
  feedId: string;
  price: number;
}
