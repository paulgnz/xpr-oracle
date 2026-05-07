/**
 * Cheap nodeos liveness/freshness probe via the public chain API.
 *
 * EOSIO/Antelope transactions reference a recent block (TaPoS). If the local
 * nodeos has fallen behind wall-clock time, our pushes are signed against a
 * stale block and the network rejects them as expired before they propagate.
 * Cheaper to bail out of the tick than to push a doomed transaction.
 */

import { log } from "./log.js";

export interface NodeStatus {
  ok: boolean;
  lagSec: number;
  headBlockNum: number;
  headBlockTime: string;
}

const TIMEOUT_MS = 5_000;

export async function checkNodeFreshness(
  endpoint: string,
  maxLagSeconds = 30,
): Promise<NodeStatus> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${endpoint.replace(/\/+$/, "")}/v1/chain/get_info`, {
      signal: ctl.signal,
    });
    if (!res.ok) throw new Error(`get_info HTTP ${res.status}`);
    const j = (await res.json()) as { head_block_time: string; head_block_num: number };
    if (typeof j.head_block_time !== "string" || typeof j.head_block_num !== "number") {
      throw new Error(`get_info malformed response: ${JSON.stringify(j).slice(0, 200)}`);
    }
    // EOSIO returns ISO without trailing Z (`2026-05-07T05:01:20.500`).
    const headMs = new Date(j.head_block_time + "Z").getTime();
    if (!Number.isFinite(headMs)) {
      throw new Error(`get_info unparseable head_block_time: ${j.head_block_time}`);
    }
    const lagSec = (Date.now() - headMs) / 1000;
    return {
      ok: lagSec <= maxLagSeconds,
      lagSec,
      headBlockNum: j.head_block_num,
      headBlockTime: j.head_block_time,
    };
  } finally {
    clearTimeout(t);
  }
}

/**
 * Wraps {@link checkNodeFreshness} with logging suited to the daemon's main loop.
 * Returns true if it's safe to push.
 */
export async function preflight(endpoint: string, maxLagSeconds = 30): Promise<boolean> {
  try {
    const s = await checkNodeFreshness(endpoint, maxLagSeconds);
    if (!s.ok) {
      log.warn(
        `nodeos at ${endpoint} is stale: head=${s.headBlockNum} (${s.headBlockTime}), ` +
          `lag=${s.lagSec.toFixed(1)}s > ${maxLagSeconds}s — skipping push`,
      );
      return false;
    }
    return true;
  } catch (e) {
    log.warn(`nodeos preflight failed for ${endpoint}: ${(e as Error).message}`);
    return false;
  }
}
