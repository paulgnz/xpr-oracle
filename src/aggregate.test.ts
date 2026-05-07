import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { aggregate, median } from "./aggregate.js";

describe("median", () => {
  test("empty array yields NaN", () => {
    assert.ok(Number.isNaN(median([])));
  });
  test("single element", () => {
    assert.equal(median([5]), 5);
  });
  test("two elements averages", () => {
    assert.equal(median([1, 3]), 2);
  });
  test("odd count picks middle", () => {
    assert.equal(median([1, 2, 3]), 2);
  });
  test("even count averages middle two", () => {
    assert.equal(median([1, 2, 3, 4]), 2.5);
  });
  test("unsorted input", () => {
    assert.equal(median([3, 1, 4, 1, 5, 9, 2, 6]), 3.5);
  });
});

describe("aggregate", () => {
  const s = (id: string, price: number) => ({ feedId: id, price });

  test("rejects samples beyond maxDeviationPct", () => {
    const r = aggregate(
      [s("a", 100), s("b", 100), s("c", 100), s("d", 200)], // d is the outlier
      5,
      2,
    );
    assert.equal(r.kept.length, 3);
    assert.equal(r.rejected.length, 1);
    assert.equal(r.rejected[0].sample.feedId, "d");
    assert.equal(r.median, 100);
  });

  test("keeps everything when all within tolerance", () => {
    const r = aggregate(
      [s("a", 1.0), s("b", 1.005), s("c", 0.995), s("d", 1.001)],
      2,
      2,
    );
    assert.equal(r.kept.length, 4);
    assert.equal(r.rejected.length, 0);
  });

  test("throws when fewer than minSources survive", () => {
    // sorted [100,100,200] → m0 = middle = 100; c is 100% off → rejected.
    // kept = 2, minSources = 3 → throws.
    assert.throws(
      () => aggregate([s("a", 100), s("b", 100), s("c", 200)], 5, 3),
      /survived/,
    );
  });

  test("50/50 split rejects all when threshold below the spread", () => {
    // [1,1,2,2] median = 1.5, each is 33% off; 5% threshold rejects all.
    assert.throws(
      () => aggregate([s("a", 1), s("b", 1), s("c", 2), s("d", 2)], 5, 2),
      /survived/,
    );
  });

  test("all equal samples — limit 0 keeps everyone", () => {
    const r = aggregate(
      [s("a", 1.0), s("b", 1.0), s("c", 1.0)],
      5,
      2,
    );
    assert.equal(r.kept.length, 3);
    assert.equal(r.median, 1.0);
  });

  test("empty samples throws", () => {
    assert.throws(() => aggregate([], 5, 1), /no samples/);
  });

  test("rejected.reason cites maxDeviationPct and m0", () => {
    const r = aggregate([s("a", 100), s("b", 100), s("c", 200)], 50, 1);
    // m0 = 100; c is 100% off; with 50% threshold, c rejected.
    assert.equal(r.rejected.length, 1);
    assert.match(r.rejected[0].reason, /50%/);
  });
});
