import { describe, expect, it } from "vitest";
import { SequentialProbabilityRatioController } from "../src/statisticalController.js";
import type { VersionStats } from "../src/metricsCollector.js";

function stats(count: number, errors: number): VersionStats {
  return { count, errors, errorRate: count === 0 ? 0 : errors / count, latenciesMs: [] };
}

const config = { alpha: 0.05, beta: 0.1, minimumDetectableEffect: 0.05, minBaselineSamples: 30 };

// Each test gets its own controller instance: the class freezes p0/p1 on
// the first evaluate() call whose baseline clears minBaselineSamples (see
// the class docstring), so sharing one instance across tests would leak
// state between them.
describe("SequentialProbabilityRatioController", () => {
  it("holds when the baseline sample is too small to trust p0, and doesn't freeze yet", () => {
    const controller = new SequentialProbabilityRatioController(config);
    const result = controller.evaluate(stats(5, 0), stats(100, 5));
    expect(result.decision).toBe("hold");
    expect(result.p0).toBeNaN();
  });

  it("holds when the canary has no samples yet", () => {
    const controller = new SequentialProbabilityRatioController(config);
    const result = controller.evaluate(stats(100, 5), stats(0, 0));
    expect(result.decision).toBe("hold");
  });

  it("sets p1 = p0 + minimumDetectableEffect from the first qualifying baseline sample", () => {
    const controller = new SequentialProbabilityRatioController(config);
    const result = controller.evaluate(stats(1000, 50), stats(100, 5));
    expect(result.p0).toBeCloseTo(0.05, 5);
    expect(result.p1).toBeCloseTo(0.1, 5);
  });

  it("freezes p0/p1 after the first qualifying evaluation — later baseline changes don't move them", () => {
    const controller = new SequentialProbabilityRatioController(config);
    const first = controller.evaluate(stats(1000, 50), stats(10, 0)); // p0 = 0.05
    expect(first.p0).toBeCloseTo(0.05, 5);

    // Baseline's own error rate later drifts a lot (as if more, noisier traffic arrived) —
    // the already-frozen p0 must not follow it.
    const second = controller.evaluate(stats(2000, 400), stats(20, 0)); // would-be p0 = 0.2
    expect(second.p0).toBeCloseTo(0.05, 5);
  });

  it("reset() clears the frozen p0/p1 so the next evaluation re-estimates from scratch", () => {
    const controller = new SequentialProbabilityRatioController(config);
    controller.evaluate(stats(1000, 50), stats(10, 0)); // freezes p0 = 0.05
    controller.reset();
    const result = controller.evaluate(stats(1000, 200), stats(10, 0)); // fresh p0 = 0.2
    expect(result.p0).toBeCloseTo(0.2, 5);
  });

  it("computes the boundaries from alpha and beta via the standard Wald formulas", () => {
    const controller = new SequentialProbabilityRatioController(config);
    const result = controller.evaluate(stats(1000, 50), stats(100, 5));
    expect(result.upperBoundary).toBeCloseTo(Math.log((1 - config.beta) / config.alpha), 10);
    expect(result.lowerBoundary).toBeCloseTo(Math.log(config.beta / (1 - config.alpha)), 10);
  });

  it("drifts toward 'proceed' when the canary's true error rate matches the (frozen) baseline", () => {
    // Baseline: 1000 samples at 5% error, frozen on the first call. Canary: exactly matches,
    // at growing sample size, until the LLR crosses the lower boundary. Since
    // E[LLR increment | p0 true] = -KL(p0||p1) < 0, this must eventually happen for a long
    // enough matching run.
    const controller = new SequentialProbabilityRatioController(config);
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
    const controller = new SequentialProbabilityRatioController(config);
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
      const controller = new SequentialProbabilityRatioController(config);
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
