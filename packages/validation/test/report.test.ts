import { describe, expect, it } from "vitest";
import { toCsv, toMarkdownSummary } from "../src/report.js";
import { summarize } from "../src/summarize.js";
import type { TrialResult } from "../src/trial.js";

describe("toCsv", () => {
  it("writes a header row plus one row per trial, with an empty detection_ms for timeouts", () => {
    const results: TrialResult[] = [
      {
        controllerType: "naive",
        scenario: "aa",
        outcome: "completed",
        detectionMs: 12.345,
        baselineSamplesAtDecision: 31,
        canarySamplesAtDecision: 29,
      },
      {
        controllerType: "statistical",
        scenario: "ab",
        outcome: "timeout",
        detectionMs: undefined,
        baselineSamplesAtDecision: 40,
        canarySamplesAtDecision: 38,
      },
    ];

    const csv = toCsv(results);
    const lines = csv.trim().split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe(
      "controller_type,scenario,outcome,detection_ms,baseline_samples_at_decision,canary_samples_at_decision",
    );
    expect(lines[1]).toBe("naive,aa,completed,12.35,31,29");
    expect(lines[2]).toBe("statistical,ab,timeout,,40,38");
  });
});

describe("toMarkdownSummary", () => {
  it("renders one table row per controller/scenario cell", () => {
    const results: TrialResult[] = [
      {
        controllerType: "naive",
        scenario: "aa",
        outcome: "rolled_back",
        detectionMs: 100,
        baselineSamplesAtDecision: 30,
        canarySamplesAtDecision: 30,
      },
    ];
    const markdown = toMarkdownSummary(summarize(results), "2026-01-01T00:00:00.000Z");
    expect(markdown).toContain("| naive | A/A (no regression) |");
    expect(markdown).toContain("false-positive rollback rate");
  });
});
