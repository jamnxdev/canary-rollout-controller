import { describe, expect, it } from "vitest";
import { NaiveThresholdController } from "../src/naiveController.js";
import type { VersionStats } from "../src/metricsCollector.js";

function stats(count: number, errorRate: number): VersionStats {
  return { count, errors: Math.round(count * errorRate), errorRate, latenciesMs: [] };
}

describe("NaiveThresholdController", () => {
  const controller = new NaiveThresholdController({ errorRateThreshold: 0.05, minSamples: 30 });

  it("holds when there aren't enough samples yet, regardless of error rate", () => {
    expect(controller.decide(stats(5, 0.9))).toBe("hold");
  });

  it("proceeds once enough samples exist and error rate is under threshold", () => {
    expect(controller.decide(stats(100, 0.02))).toBe("proceed");
  });

  it("rolls back once enough samples exist and error rate exceeds threshold", () => {
    expect(controller.decide(stats(100, 0.2))).toBe("rollback");
  });

  it("proceeds at exactly the threshold (strictly-greater-than semantics)", () => {
    expect(controller.decide(stats(100, 0.05))).toBe("proceed");
  });
});
