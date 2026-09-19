import { describe, expect, it } from "vitest";
import { mean, median, percentile } from "../src/stats.js";

describe("stats helpers", () => {
  it("mean/median/percentile are undefined for empty input", () => {
    expect(mean([])).toBeUndefined();
    expect(median([])).toBeUndefined();
    expect(percentile([], 90)).toBeUndefined();
  });

  it("mean averages values", () => {
    expect(mean([1, 2, 3, 4])).toBe(2.5);
  });

  it("median handles odd and even-length arrays", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });

  it("percentile returns a value from the sorted array at roughly the requested rank", () => {
    const values = Array.from({ length: 100 }, (_, i) => i + 1); // 1..100
    expect(percentile(values, 0)).toBe(1);
    expect(percentile(values, 90)).toBe(91);
  });
});
