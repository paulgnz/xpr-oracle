/**
 * Per-feed circuit breaker.
 *
 * Without this, a permanently-broken upstream (e.g. a delisted symbol returning
 * HTTP 400 every tick) emits a WARN every 5 min indefinitely — ~600/day per
 * dead feed across journalctl. After `FAILURE_THRESHOLD` consecutive failures
 * the breaker opens, suppresses fetch attempts for `RECHECK_AFTER_MS`, then
 * allows one probe call. Probe success → closed. Probe failure → re-opens.
 *
 * Pure state-machine logic — no I/O, no globals, fully testable.
 */

const FAILURE_THRESHOLD = 10;
const RECHECK_AFTER_MS = 60 * 60 * 1000; // 1 hour

export interface BreakerState {
  failures: number;
  /** unix-ms when the breaker was last tripped open. undefined = closed. */
  openSince?: number;
}

export class CircuitOpenError extends Error {
  constructor(
    public readonly feedId: string,
    public readonly failures: number,
  ) {
    super(`circuit open for ${feedId} (${failures} consecutive failures)`);
    this.name = "CircuitOpenError";
  }
}

export function newState(): BreakerState {
  return { failures: 0 };
}

/** True if the breaker is currently rejecting calls. */
export function isOpen(s: BreakerState, now = Date.now()): boolean {
  return s.openSince !== undefined && now - s.openSince < RECHECK_AFTER_MS;
}

export function recordSuccess(_prev: BreakerState): BreakerState {
  return { failures: 0 };
}

export function recordFailure(
  prev: BreakerState,
  now = Date.now(),
): { state: BreakerState; justOpened: boolean } {
  const failures = prev.failures + 1;
  if (failures >= FAILURE_THRESHOLD) {
    // Trip (or re-trip after a recheck-window expiry → another failure).
    const justOpened = prev.openSince === undefined;
    return { state: { failures, openSince: now }, justOpened };
  }
  return { state: { failures }, justOpened: false };
}

/**
 * Is this error a transient blip (rate-limit, network hiccup, gateway error)
 * rather than a structural failure (wrong symbol, removed endpoint, auth)?
 *
 * The circuit breaker should NOT count transient errors — the upstream is
 * fine, just temporarily unavailable. Counting them risks tripping a feed
 * during a CoinGecko 429 storm or a brief DNS issue.
 *
 * Permanent (count toward breaker): HTTP 400, 401, 403, 404, malformed JSON.
 * Transient (don't count): HTTP 408, 429, 5xx, ECONNRESET, ETIMEDOUT, abort.
 */
export function isTransientError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    /HTTP 4(08|29)\b/.test(msg) ||
    /HTTP 5\d\d\b/.test(msg) ||
    /ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|EHOSTUNREACH/.test(msg) ||
    /aborted|timed? ?out|fetch failed/i.test(msg)
  );
}
