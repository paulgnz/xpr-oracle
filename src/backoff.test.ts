import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyError,
  nextBackoffMs,
  newBackoffState,
  recordFailure,
  recordSuccess,
  shouldSkipForBackoff,
} from "./backoff.js";

describe("classifyError", () => {
  test("missing authority is permanent", () => {
    assert.equal(
      classifyError(new Error("missing authority of protonnz/oracle")),
      "permanent",
    );
  });
  test("not a qualified oracle is permanent", () => {
    assert.equal(
      classifyError(new Error("assertion failure with message: not a qualified oracle")),
      "permanent",
    );
  });
  test("unknown key is permanent", () => {
    assert.equal(classifyError(new Error("unknown key (boost::tuples::tuple)")), "permanent");
  });
  test("connection refused is transient", () => {
    assert.equal(
      classifyError(new Error("connect ECONNREFUSED 127.0.0.1:8888")),
      "transient",
    );
  });
  test("timeout is transient", () => {
    assert.equal(
      classifyError(new Error("cleos timed out after 30000ms")),
      "transient",
    );
  });
  test("HTTP 502 is transient", () => {
    assert.equal(classifyError(new Error("HTTP 502 Bad Gateway")), "transient");
  });
});

describe("nextBackoffMs", () => {
  test("first failure is 60s", () => {
    assert.equal(nextBackoffMs(1), 60_000);
  });
  test("doubles each step", () => {
    assert.equal(nextBackoffMs(2), 120_000);
    assert.equal(nextBackoffMs(3), 240_000);
    assert.equal(nextBackoffMs(4), 480_000);
  });
  test("caps at 30 min", () => {
    assert.equal(nextBackoffMs(10), 30 * 60 * 1000);
    assert.equal(nextBackoffMs(20), 30 * 60 * 1000);
  });
  test("clamps to 1 for non-positive input", () => {
    assert.equal(nextBackoffMs(0), 60_000);
    assert.equal(nextBackoffMs(-5), 60_000);
  });
});

describe("backoff state", () => {
  test("permanent failure sets retryAfter into the future", () => {
    const s = newBackoffState();
    const before = Date.now();
    const r = recordFailure(s, new Error("missing authority"));
    assert.equal(r.kind, "permanent");
    assert.equal(s.consecutiveFailures, 1);
    assert.ok(s.retryAfter >= before + 60_000 - 100);
    assert.ok(shouldSkipForBackoff(s));
  });

  test("transient failure does not set retryAfter", () => {
    const s = newBackoffState();
    const r = recordFailure(s, new Error("connect timeout"));
    assert.equal(r.kind, "transient");
    assert.equal(s.consecutiveFailures, 1);
    assert.equal(s.retryAfter, 0);
    assert.equal(shouldSkipForBackoff(s), false);
  });

  test("recordSuccess resets state", () => {
    const s = newBackoffState();
    recordFailure(s, new Error("missing authority"));
    recordFailure(s, new Error("missing authority"));
    assert.equal(s.consecutiveFailures, 2);
    recordSuccess(s);
    assert.equal(s.consecutiveFailures, 0);
    assert.equal(s.lastKind, null);
    assert.equal(s.retryAfter, 0);
    assert.equal(shouldSkipForBackoff(s), false);
  });

  test("consecutive permanent failures grow the delay", () => {
    const s = newBackoffState();
    const a = recordFailure(s, new Error("missing authority"));
    const b = recordFailure(s, new Error("missing authority"));
    const c = recordFailure(s, new Error("missing authority"));
    assert.equal(a.delayMs, 60_000);
    assert.equal(b.delayMs, 120_000);
    assert.equal(c.delayMs, 240_000);
  });
});
