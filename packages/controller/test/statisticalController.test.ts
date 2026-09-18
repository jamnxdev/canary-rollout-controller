import { describe, expect, it } from "vitest";
import { SequentialProbabilityRatioController } from "../src/statisticalController.js";
import type { VersionStats } from "../src/metricsCollector.js";

function stats(count: number, errors: number): VersionStats {
  return { count, errors, errorRate: count === 0 ? 0 : errors / count, latenciesMs: [] };
}

const config = { alpha: 0.05, beta: 0.1, minimumDetectableEffect: 0.05, minBaselineSamples: 30 };

describe("SequentialProbabilityRatioController", () => {
  const controller = new SequentialProbabilityRatioController(config);

  it("holds when the baseline sample is too small to trust p0", () => {
    const result = controller.evaluate(stats(5, 0), stats(100, 5));
    expect(result.decision).toBe("hold");
  });

  it("holds when the canary has no samples yet", () => {
    const result = controller.evaluate(stats(100, 5), stats(0, 0));
    expect(result.decision).toBe("hold");
  });

  it("sets p1 = p0 + minimumDetectableEffect", () => {
    const result = controller.evaluate(stats(1000, 50), stats(100, 5));
    expect(result.p0).toBeCloseTo(0.05, 5);
    expect(result.p1).toBeCloseTo(0.1, 5);
  });

  it("computes the boundaries from alpha and beta via the standard Wald formulas", () => {
    const result = controller.evaluate(stats(1000, 50), stats(100, 5));
    expect(result.upperBoundary).toBeCloseTo(Math.log((1 - config.beta) / config.alpha), 10);
    expect(result.lowerBoundary).toBeCloseTo(Math.log(config.beta / (1 - config.alpha)), 10);
  });

  it("drifts toward 'proceed' when the canary's true error rate matches the baseline", () => {
    // Baseline: 1000 samples at 5% error. Canary: exactly matches, at growing sample size,
    // until the LLR crosses the lower boundary. Since E[LLR increment | p0 true] = -KL(p0||p1)
    // < 0, this must eventually happen for a long enough matching run.
    const baseline = stats(1000, 50);
    let decision: string = "hold";
    for (let n = 100; n <= 20000 && decision === "hold"; n += 100) {
      const canary = stats(n, Math.round(n * 0.05));
      decision = controller.evaluate(baseline, canary).decision;
    }
    expect(decision).toBe("proceed");
  });

  it("drifts toward 'rollback' when the canary regresses by at least the MDE", () => {
    // Baseline at 5% error, canary regressed to 12% (above p0 + MDE = 10%).
    const baseline = stats(1000, 50);
    let decision: string = "hold";
    for (let n = 50; n <= 5000 && decision === "hold"; n += 50) {
      const canary = stats(n, Math.round(n * 0.12));
      decision = controller.evaluate(baseline, canary).decision;
    }
    expect(decision).toBe("rollback");
  });

  it("reaches 'rollback' faster for a larger regression than for a borderline one", () => {
    const baseline = stats(1000, 50);
    const detect = (canaryErrorRate: number): number => {
      for (let n = 50; n <= 20000; n += 50) {
        const canary = stats(n, Math.round(n * canaryErrorRate));
        if (controller.evaluate(baseline, canary).decision === "rollback") return n;
      }
      return Infinity;
    };

    const nForBorderlineRegression = detect(0.11); // just above p0 + MDE = 0.10
    const nForLargeRegression = detect(0.3);
    expect(nForLargeRegression).toBeLessThan(nForBorderlineRegression);
  });
});
