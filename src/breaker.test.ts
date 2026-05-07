import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  newState,
  isOpen,
  recordSuccess,
  recordFailure,
  isTransientError,
} from "./breaker.js";

describe("breaker", () => {
  test("new state is closed", () => {
    assert.equal(isOpen(newState(), 1000), false);
  });

  test("9 consecutive failures: still closed, never opened", () => {
    let s = newState();
    let openedCount = 0;
    for (let i = 0; i < 9; i++) {
      const r = recordFailure(s, i);
      s = r.state;
      if (r.justOpened) openedCount++;
    }
    assert.equal(s.failures, 9);
    assert.equal(openedCount, 0);
    assert.equal(isOpen(s, 100), false);
  });

  test("10 failures: opens, justOpened fires exactly once", () => {
    let s = newState();
    let openedCount = 0;
    for (let i = 0; i < 10; i++) {
      const r = recordFailure(s, i);
      s = r.state;
      if (r.justOpened) openedCount++;
    }
    assert.equal(openedCount, 1);
    assert.equal(isOpen(s, 100), true);
  });

  test("subsequent failures don't re-trigger justOpened during the open window", () => {
    let s = newState();
    let openedCount = 0;
    for (let i = 0; i < 15; i++) {
      const r = recordFailure(s, i);
      s = r.state;
      if (r.justOpened) openedCount++;
    }
    assert.equal(openedCount, 1);
  });

  test("isOpen: still open within retry window (30 min after trip)", () => {
    let s = newState();
    for (let i = 0; i < 10; i++) s = recordFailure(s, 0).state;
    assert.equal(isOpen(s, 30 * 60_000), true);
  });

  test("isOpen: closed after 1h retry window expires", () => {
    let s = newState();
    for (let i = 0; i < 10; i++) s = recordFailure(s, 0).state;
    assert.equal(isOpen(s, 3_600_001), false);
  });

  test("recordSuccess clears failures and openSince", () => {
    let s = newState();
    for (let i = 0; i < 5; i++) s = recordFailure(s, i).state;
    s = recordSuccess(s);
    assert.equal(s.failures, 0);
    assert.equal(s.openSince, undefined);
  });

  test("recordSuccess after a tripped breaker fully resets it", () => {
    let s = newState();
    for (let i = 0; i < 12; i++) s = recordFailure(s, i).state;
    assert.equal(isOpen(s, 100), true);
    s = recordSuccess(s);
    assert.equal(s.failures, 0);
    assert.equal(s.openSince, undefined);
    assert.equal(isOpen(s, 100), false);
  });

  test("re-failure after retry window updates openSince but doesn't justOpen again", () => {
    let s = newState();
    for (let i = 0; i < 10; i++) s = recordFailure(s, 0).state;
    // 1h+1ms later, retry window has expired
    assert.equal(isOpen(s, 3_600_001), false);
    // The probe call fails
    const r = recordFailure(s, 3_600_001);
    s = r.state;
    assert.equal(r.justOpened, false);
    assert.equal(isOpen(s, 3_600_001), true);
    assert.equal(s.openSince, 3_600_001);
  });
});

describe("isTransientError", () => {
  test("HTTP 429 (rate limit) is transient", () => {
    assert.equal(
      isTransientError(new Error("https://api.coingecko.com/... -> HTTP 429")),
      true,
    );
  });
  test("HTTP 408 (request timeout) is transient", () => {
    assert.equal(isTransientError(new Error("HTTP 408")), true);
  });
  test("HTTP 502/503/504 are transient", () => {
    assert.equal(isTransientError(new Error("HTTP 502 Bad Gateway")), true);
    assert.equal(isTransientError(new Error("HTTP 503 Service Unavailable")), true);
    assert.equal(isTransientError(new Error("HTTP 504")), true);
  });
  test("ECONNRESET / ETIMEDOUT are transient", () => {
    assert.equal(isTransientError(new Error("connect ECONNRESET")), true);
    assert.equal(isTransientError(new Error("ETIMEDOUT")), true);
  });
  test("abort signal / fetch failed are transient", () => {
    assert.equal(isTransientError(new Error("The operation was aborted")), true);
    assert.equal(isTransientError(new Error("fetch failed")), true);
  });
  test("HTTP 400 (bad request) is permanent — wrong symbol", () => {
    assert.equal(
      isTransientError(new Error("https://api.bitget.com/... -> HTTP 400")),
      false,
    );
  });
  test("HTTP 404 (not found) is permanent — endpoint gone", () => {
    assert.equal(
      isTransientError(new Error("https://api.exchange.coinbase.com/... -> HTTP 404")),
      false,
    );
  });
  test("HTTP 401 / 403 (auth) are permanent", () => {
    assert.equal(isTransientError(new Error("HTTP 401 Unauthorized")), false);
    assert.equal(isTransientError(new Error("HTTP 403 Forbidden")), false);
  });
  test("malformed price (parse failure) is permanent", () => {
    assert.equal(
      isTransientError(new Error("kucoin:XPR-USDT: bad price undefined")),
      false,
    );
  });
});
