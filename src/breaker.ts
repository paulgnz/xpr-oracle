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
