/** Median + outlier-rejection price aggregation. */

import type { FeedSample } from "./types.js";

export function median(xs: number[]): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

export interface AggregateResult {
  median: number;
  kept: FeedSample[];
  rejected: { sample: FeedSample; reason: string }[];
}

/**
 * Compute initial median, drop samples deviating more than `maxDeviationPct`,
 * recompute median over what remains. Throws if fewer than `minSources` survive.
 */
export function aggregate(
  samples: FeedSample[],
  maxDeviationPct: number,
  minSources: number,
): AggregateResult {
  if (samples.length === 0) throw new Error("no samples");

  const m0 = median(samples.map((s) => s.price));
  const limit = (m0 * maxDeviationPct) / 100;

  const kept: FeedSample[] = [];
  const rejected: AggregateResult["rejected"] = [];
  for (const s of samples) {
    if (Math.abs(s.price - m0) <= limit) kept.push(s);
    else
      rejected.push({
        sample: s,
        reason: `>${maxDeviationPct}% from initial median ${m0}`,
      });
  }

  if (kept.length < minSources) {
    throw new Error(
      `only ${kept.length} sources survived outlier check, need ${minSources}`,
    );
  }

  return { median: median(kept.map((s) => s.price)), kept, rejected };
}
