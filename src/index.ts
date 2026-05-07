#!/usr/bin/env node
/**
 * xpr-oracle: BP price-pusher daemon.
 *
 *   XPR_ORACLE_CONFIG=/etc/xpr-oracle/config.json node dist/index.js
 *
 * Pass --dry-run to fetch + aggregate but skip the on-chain push (useful
 * before whitelist approval).
 */

import { readFileSync, utimesSync, openSync, closeSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import type { Config, FeedSample, PairConfig } from "./types.js";
import { fetchFeed } from "./feeds.js";
import { aggregate } from "./aggregate.js";
import { buildQuote, pushQuotes, killActiveChild, type Quote } from "./push.js";
import { preflight } from "./health.js";
import {
  newBackoffState,
  recordFailure,
  recordSuccess,
  shouldSkipForBackoff,
} from "./backoff.js";
import { log } from "./log.js";

function loadConfig(): Config {
  const path = resolve(process.env.XPR_ORACLE_CONFIG ?? "config.json");
  const raw = readFileSync(path, "utf8");
  const cfg = JSON.parse(raw) as Config;

  if (!cfg.account || !cfg.permission || !cfg.contract) {
    throw new Error("config missing account/permission/contract");
  }
  // Validate endpoint URL with the URL parser, not just a regex prefix check.
  let parsed: URL;
  try {
    parsed = new URL(cfg.endpoint);
  } catch {
    throw new Error(`config.endpoint is not a valid URL: ${cfg.endpoint}`);
  }
  if (!/^https?:$/.test(parsed.protocol)) {
    throw new Error(`config.endpoint must be http(s); got ${parsed.protocol}`);
  }
  if (!parsed.host) {
    throw new Error(`config.endpoint has no host: ${cfg.endpoint}`);
  }

  if (typeof cfg.intervalSeconds !== "number" || cfg.intervalSeconds < 5) {
    throw new Error("config.intervalSeconds must be a number >= 5");
  }
  if (cfg.expirationSeconds !== undefined) {
    if (typeof cfg.expirationSeconds !== "number" || cfg.expirationSeconds < 30) {
      throw new Error("config.expirationSeconds must be >= 30 if set");
    }
  }
  if (!Array.isArray(cfg.pairs) || cfg.pairs.length === 0) {
    throw new Error("config.pairs must be non-empty");
  }
  for (const p of cfg.pairs) {
    if (!p.name || typeof p.name !== "string") {
      throw new Error(`pair has no valid 'name'`);
    }
    // EOSIO `name` type accepts only [a-z1-5.] up to 12 chars.
    if (!/^[a-z1-5.]{1,12}$/.test(p.name)) {
      throw new Error(`pair name "${p.name}" is not a valid EOSIO name (a-z1-5., max 12 chars)`);
    }
    if (!Array.isArray(p.feeds) || p.feeds.length === 0) {
      throw new Error(`pair ${p.name}: feeds must be non-empty`);
    }
    if (typeof p.quotedPrecision !== "number" || !Number.isInteger(p.quotedPrecision) ||
      p.quotedPrecision < 0 || p.quotedPrecision > 15) {
      throw new Error(`pair ${p.name}: quotedPrecision must be an integer 0..15`);
    }
    if (typeof p.maxDeviationPct !== "number" || !Number.isFinite(p.maxDeviationPct) ||
      p.maxDeviationPct <= 0 || p.maxDeviationPct >= 100) {
      throw new Error(`pair ${p.name}: maxDeviationPct must be a number in (0, 100)`);
    }
    if (typeof p.minSources !== "number" || !Number.isInteger(p.minSources) || p.minSources < 1) {
      throw new Error(`pair ${p.name}: minSources must be a positive integer`);
    }
    if (p.minSources > p.feeds.length) {
      throw new Error(
        `pair ${p.name}: minSources (${p.minSources}) > feeds.length (${p.feeds.length})`,
      );
    }
  }
  return cfg;
}

async function gatherPair(pair: PairConfig): Promise<Quote | null> {
  const settled = await Promise.allSettled(
    pair.feeds.map(
      async (id): Promise<FeedSample> => ({ feedId: id, price: await fetchFeed(id) }),
    ),
  );

  const samples: FeedSample[] = [];
  for (let i = 0; i < settled.length; i++) {
    const r = settled[i];
    if (r.status === "fulfilled") samples.push(r.value);
    else log.warn(`${pair.feeds[i]} failed: ${(r.reason as Error)?.message ?? r.reason}`);
  }
  if (samples.length === 0) {
    log.warn(`pair ${pair.name}: no feeds returned`);
    return null;
  }

  try {
    const { median, kept, rejected } = aggregate(
      samples,
      pair.maxDeviationPct,
      pair.minSources,
    );
    for (const r of rejected) {
      log.warn(`rejected ${r.sample.feedId}@${r.sample.price}: ${r.reason}`);
    }
    log.info(
      `${pair.name}: median=${median} from ${kept.length}/${samples.length} ` +
        `[${kept.map((k) => `${k.feedId}=${k.price}`).join(", ")}]`,
    );
    return buildQuote(pair, median);
  } catch (e) {
    log.error(`pair ${pair.name} aggregate failed: ${(e as Error).message}`);
    return null;
  }
}

const backoff = newBackoffState();

/** Update mtime of the heartbeat file (creating it if necessary). monitor.sh reads this. */
function touchHeartbeat(path: string): void {
  try {
    if (!existsSync(path)) closeSync(openSync(path, "a"));
    utimesSync(path, new Date(), new Date());
  } catch (e) {
    // Heartbeat is best-effort; log but don't crash the tick.
    log.warn(`heartbeat write failed: ${(e as Error).message}`);
  }
}

async function tick(cfg: Config, dryRun: boolean): Promise<void> {
  // Skip the entire tick if we're inside a permanent-error backoff window.
  if (shouldSkipForBackoff(backoff)) {
    const waitSec = Math.round((backoff.retryAfter - Date.now()) / 1000);
    log.warn(`backoff active (${backoff.consecutiveFailures} permanent failures), retry in ${waitSec}s`);
    return;
  }

  // Gather all pairs in parallel — they're independent.
  const results = await Promise.all(cfg.pairs.map(gatherPair));
  const quotes = results.filter((q): q is Quote => q !== null);
  if (quotes.length === 0) {
    log.warn("no quotes this cycle, skipping push");
    return;
  }

  if (dryRun) {
    log.info(`[dry-run] would push: ${JSON.stringify(quotes)}`);
    return;
  }

  // Stale-nodeos preflight: don't push if the local node is lagging.
  if (!(await preflight(cfg.endpoint))) return;

  try {
    const out = await pushQuotes(cfg, quotes);
    log.info(`push ok: ${out}`);
    recordSuccess(backoff);
    if (cfg.heartbeatFile) touchHeartbeat(cfg.heartbeatFile);
  } catch (e) {
    const { kind, delayMs } = recordFailure(backoff, e);
    if (kind === "permanent") {
      log.error(
        `permanent push error #${backoff.consecutiveFailures} (backing off ${Math.round(delayMs / 1000)}s): ${(e as Error).message}`,
      );
    } else {
      log.warn(`transient push error #${backoff.consecutiveFailures}: ${(e as Error).message}`);
    }
  }
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const cfg = loadConfig();
  log.info(
    `xpr-oracle starting: ${cfg.account}@${cfg.permission} -> ${cfg.contract} ` +
      `via ${cfg.endpoint} | pairs=[${cfg.pairs.map((p) => p.name).join(",")}] ` +
      `interval=${cfg.intervalSeconds}s${dryRun ? " (dry-run)" : ""}`,
  );

  let stopping = false;
  let stopSignals = 0;
  const stop = (s: string) => {
    stopSignals += 1;
    if (stopSignals === 1) {
      log.info(`received ${s}, stopping after current tick (Ctrl-C again to force-exit)`);
      stopping = true;
      // Kill an in-flight cleos child so we don't wait for the 30s push timeout.
      killActiveChild();
    } else {
      log.warn(`received ${s} again, force-exiting`);
      process.exit(130);
    }
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));

  await tick(cfg, dryRun);
  while (!stopping) {
    await new Promise((r) => setTimeout(r, cfg.intervalSeconds * 1000));
    if (stopping) break;
    try {
      await tick(cfg, dryRun);
    } catch (e) {
      log.error(`tick crashed: ${(e as Error).message}`);
    }
  }
  log.info("xpr-oracle stopped");
}

main().catch((e) => {
  log.error(`fatal: ${(e as Error).message ?? e}`);
  process.exit(1);
});
