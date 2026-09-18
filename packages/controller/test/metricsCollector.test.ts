import { describe, expect, it } from "vitest";
import { MetricsCollector } from "../src/metricsCollector.js";

describe("MetricsCollector", () => {
  it("starts empty for both versions", () => {
    const collector = new MetricsCollector();
    expect(collector.stats("baseline")).toEqual({
      count: 0,
      errors: 0,
      errorRate: 0,
      latenciesMs: [],
    });
    expect(collector.stats("canary")).toEqual({
      count: 0,
      errors: 0,
      errorRate: 0,
      latenciesMs: [],
    });
  });

  it("tracks count, errors, error rate, and latencies per version independently", () => {
    const collector = new MetricsCollector();
    collector.record({ version: "baseline", latencyMs: 10, success: true });
    collector.record({ version: "baseline", latencyMs: 12, success: false });
    collector.record({ version: "canary", latencyMs: 20, success: true });

    const baseline = collector.stats("baseline");
    expect(baseline.count).toBe(2);
    expect(baseline.errors).toBe(1);
    expect(baseline.errorRate).toBe(0.5);
    expect(baseline.latenciesMs).toEqual([10, 12]);

    const canary = collector.stats("canary");
    expect(canary.count).toBe(1);
    expect(canary.errors).toBe(0);
    expect(canary.errorRate).toBe(0);
  });

  it("clears all recorded samples on reset", () => {
    const collector = new MetricsCollector();
    collector.record({ version: "canary", latencyMs: 5, success: false });
    collector.reset();
    expect(collector.stats("canary").count).toBe(0);
  });
});
