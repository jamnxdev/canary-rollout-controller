import { describe, expect, it } from "vitest";
import { runTrial } from "../src/trial.js";

const naiveConfig = { errorRateThreshold: 0.1, minSamples: 20 };
const sprtConfig = { alpha: 0.05, beta: 0.1, minimumDetectableEffect: 0.05, minBaselineSamples: 20 };
const common = { latencyMs: 0, latencyJitterMs: 0 };

describe("runTrial", () => {
  it("resolves to 'rolled_back' for a statistical trial with an obvious injected regression", async () => {
    const result = await runTrial({
      controllerType: "statistical",
      scenario: "ab",
      baselineConfig: { ...common, errorRate: 0.05 },
      canaryConfig: { ...common, errorRate: 0.3 },
      stagePercent: 50,
      naiveConfig,
      sprtConfig,
      loadConcurrency: 8,
      maxTrialMs: 5000,
      tickIntervalMs: 10,
    });

    expect(result.outcome).toBe("rolled_back");
    expect(result.detectionMs).toBeGreaterThan(0);
    expect(result.canarySamplesAtDecision).toBeGreaterThan(0);
  }, 15000);

  it("resolves to 'completed' for a naive trial with two identical healthy versions", async () => {
    const result = await runTrial({
      controllerType: "naive",
      scenario: "aa",
      baselineConfig: { ...common, errorRate: 0 },
      canaryConfig: { ...common, errorRate: 0 },
      stagePercent: 50,
      naiveConfig,
      sprtConfig,
      loadConcurrency: 8,
      maxTrialMs: 5000,
      tickIntervalMs: 10,
    });

    expect(result.outcome).toBe("completed");
  }, 15000);
});
