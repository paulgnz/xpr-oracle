import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { newState, isOpen, recordSuccess, recordFailure } from "./breaker.js";

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
