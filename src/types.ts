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
  /** XPR account that signs the write. */
  account: string;
  /** Permission to sign with. Recommended: a dedicated "oracle" permission, NOT active. */
  permission: string;
  /** Almost always "delphioracle". */
  contract: string;
  /**
   * URL passed to `cleos --url …` and ultimately reached by it.
   * Recommended: your local nodeos (e.g. "http://127.0.0.1:8888").
   */
  endpoint: string;
  /** Push cadence. Tune per your CPU/NET budget; 30–120s is typical. */
  intervalSeconds: number;
  /** Transaction expiration in seconds passed to cleos. Default 240. */
  expirationSeconds?: number;
  /** Optional keosd wallet name. Omit to use the default wallet. */
  walletName?: string;
  /**
   * Optional path to a chmod-600 file containing the keosd wallet password.
   * If set, the daemon runs `cleos wallet unlock` before each push.
   * Alternative: set the `XPR_ORACLE_WALLET_PW` env var.
   * Or: leave both unset and keep keosd unlocked some other way (long
   * --unlock-timeout, separate cron, etc.).
   */
  walletPasswordFile?: string;
  pairs: PairConfig[];
}

export interface FeedSample {
  feedId: string;
  price: number;
}
