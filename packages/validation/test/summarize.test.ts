import { describe, expect, it } from "vitest";
import { summarize } from "../src/summarize.js";
import type { TrialResult } from "../src/trial.js";

function trial(overrides: Partial<TrialResult>): TrialResult {
  return {
    controllerType: "naive",
    scenario: "aa",
    outcome: "completed",
    detectionMs: 100,
    baselineSamplesAtDecision: 30,
    canarySamplesAtDecision: 30,
    ...overrides,
  };
}

describe("summarize", () => {
  it("groups by controllerType + scenario and computes the rollback rate", () => {
    const results: TrialResult[] = [
      trial({ controllerType: "naive", scenario: "aa", outcome: "rolled_back", detectionMs: 50 }),
      trial({ controllerType: "naive", scenario: "aa", outcome: "completed" }),
      trial({ controllerType: "naive", scenario: "aa", outcome: "completed" }),
      trial({ controllerType: "naive", scenario: "aa", outcome: "completed" }),
      trial({ controllerType: "statistical", scenario: "ab", outcome: "rolled_back", detectionMs: 200 }),
      trial({ controllerType: "statistical", scenario: "ab", outcome: "rolled_back", detectionMs: 300 }),
    ];

    const summaries = summarize(results);
    expect(summaries).toHaveLength(2);

    const naiveAA = summaries.find((s) => s.controllerType === "naive" && s.scenario === "aa");
    expect(naiveAA).toMatchObject({ trials: 4, rolledBack: 1, completed: 3, timedOut: 0 });
    expect(naiveAA?.rollbackRate).toBe(0.25);
    expect(naiveAA?.detectionMsMeanOfRollbacks).toBe(50);

    const statAB = summaries.find((s) => s.controllerType === "statistical" && s.scenario === "ab");
    expect(statAB).toMatchObject({ trials: 2, rolledBack: 2, completed: 0, timedOut: 0 });
    expect(statAB?.rollbackRate).toBe(1);
    expect(statAB?.detectionMsMeanOfRollbacks).toBe(250);
  });

  it("counts timeouts separately and excludes them from detection-time stats", () => {
    const results: TrialResult[] = [
      trial({ outcome: "timeout", detectionMs: undefined }),
      trial({ outcome: "rolled_back", detectionMs: 10 }),
    ];
    const [summary] = summarize(results);
    expect(summary?.timedOut).toBe(1);
    expect(summary?.rolledBack).toBe(1);
    expect(summary?.detectionMsMeanOfRollbacks).toBe(10);
  });
});
