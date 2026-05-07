/**
 * Exponential backoff for permanent on-chain push failures.
 *
 * "Permanent" here means errors that won't fix themselves on the next tick:
 * not whitelisted as an oracle, missing authority on the linked permission,
 * pair doesn't exist on-chain, etc. Without backoff the daemon hammers the
 * network with failing transactions every interval — burning the BP's CPU/NET
 * stake, polluting Hyperion, and making the eventual fix harder to spot in the
 * logs. Transient errors (connection refused, http 5xx, expired tx) keep the
 * normal cadence.
 */

export type ErrorKind = "transient" | "permanent";

const BASE_DELAY_SEC = 60;
const MAX_DELAY_SEC = 30 * 60;

const PERMANENT_PATTERNS = [
  /missing authority/i,
  /transaction declares authority/i,
  /not a qualified oracle/i,
  /only registered oracles/i,
  /oracle.*not.*registered/i,
  /pair.*not.*found/i,
  /pair.*does not exist/i,
  /unknown key/i,
  /account does not exist/i,
  /permission.*not.*found/i,
  /permission.*does not exist/i,
  /irrelevant signature/i,
  /unsatisfied_authorization/i,
];

export function classifyError(err: unknown): ErrorKind {
  const msg = err instanceof Error ? err.message : String(err);
  for (const p of PERMANENT_PATTERNS) {
    if (p.test(msg)) return "permanent";
  }
  return "transient";
}

/** 60s, 120s, 240s, 480s, … capped at 30 min. n is the consecutive-failure count (1-indexed). */
export function nextBackoffMs(consecutiveFailures: number): number {
  const n = Math.max(1, consecutiveFailures);
  const expSec = BASE_DELAY_SEC * Math.pow(2, n - 1);
  return Math.min(expSec, MAX_DELAY_SEC) * 1000;
}

export interface BackoffState {
  consecutiveFailures: number;
  lastKind: ErrorKind | null;
  /** unix-ms; if Date.now() < this, skip the next push attempt. */
  retryAfter: number;
}

export function newBackoffState(): BackoffState {
  return { consecutiveFailures: 0, lastKind: null, retryAfter: 0 };
}

export function recordSuccess(state: BackoffState): void {
  state.consecutiveFailures = 0;
  state.lastKind = null;
  state.retryAfter = 0;
}

export function recordFailure(state: BackoffState, err: unknown): {
  kind: ErrorKind;
  delayMs: number;
} {
  const kind = classifyError(err);
  state.consecutiveFailures += 1;
  state.lastKind = kind;
  if (kind === "permanent") {
    const delayMs = nextBackoffMs(state.consecutiveFailures);
    state.retryAfter = Date.now() + delayMs;
    return { kind, delayMs };
  }
  // Transient: don't extend the next retry; let the normal cadence handle it.
  state.retryAfter = 0;
  return { kind, delayMs: 0 };
}

export function shouldSkipForBackoff(state: BackoffState): boolean {
  return state.lastKind === "permanent" && Date.now() < state.retryAfter;
}
