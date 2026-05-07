#!/usr/bin/env node
/**
 * xpr-oracle: BP price-pusher daemon.
 *
 *   XPR_ORACLE_CONFIG=/etc/xpr-oracle/config.json node dist/index.js
 *
 * Pass --dry-run to fetch + aggregate but skip the on-chain push (useful before
 * you have whitelist approval).
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Config, FeedSample, PairConfig } from "./types.js";
import { fetchFeed } from "./feeds.js";
import { aggregate } from "./aggregate.js";
import { buildQuote, pushQuotes, type Quote } from "./push.js";
import { log } from "./log.js";

function loadConfig(): Config {
  const path = resolve(process.env.XPR_ORACLE_CONFIG ?? "config.json");
  const raw = readFileSync(path, "utf8");
  const cfg = JSON.parse(raw) as Config;

  if (!cfg.account || !cfg.permission || !cfg.contract) {
    throw new Error("config missing account/permission/contract");
  }
  if (!cfg.endpoint || !/^https?:\/\//.test(cfg.endpoint)) {
    throw new Error("config.endpoint must be a http(s) URL (e.g. http://127.0.0.1:8888)");
  }
  if (!Array.isArray(cfg.pairs) || cfg.pairs.length === 0) {
    throw new Error("config.pairs must be non-empty");
  }
  if (!cfg.intervalSeconds || cfg.intervalSeconds < 5) {
    throw new Error("config.intervalSeconds must be >= 5");
  }
  for (const p of cfg.pairs) {
    if (!p.name || !Array.isArray(p.feeds) || p.feeds.length === 0) {
      throw new Error(`pair ${p.name ?? "(unnamed)"}: invalid config`);
    }
    if (p.minSources < 1) throw new Error(`pair ${p.name}: minSources must be >= 1`);
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

async function tick(cfg: Config, dryRun: boolean): Promise<void> {
  const quotes: Quote[] = [];
  for (const pair of cfg.pairs) {
    const q = await gatherPair(pair);
    if (q) quotes.push(q);
  }
  if (quotes.length === 0) {
    log.warn("no quotes this cycle, skipping push");
    return;
  }
  if (dryRun) {
    log.info(`[dry-run] would push: ${JSON.stringify(quotes)}`);
    return;
  }
  try {
    const out = await pushQuotes(cfg, quotes);
    log.info(`push ok: ${out.split("\n")[0]}`);
  } catch (e) {
    log.error(`push failed: ${(e as Error).message}`);
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
  const stop = (s: string) => {
    log.info(`received ${s}, stopping after current tick`);
    stopping = true;
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
