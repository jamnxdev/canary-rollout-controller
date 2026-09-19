import type { TrialResult } from "./trial.js";
import type { CellSummary } from "./summarize.js";

export function toCsv(results: TrialResult[]): string {
  const header = [
    "controller_type",
    "scenario",
    "outcome",
    "detection_ms",
    "baseline_samples_at_decision",
    "canary_samples_at_decision",
  ];
  const rows = results.map((r) =>
    [
      r.controllerType,
      r.scenario,
      r.outcome,
      r.detectionMs === undefined ? "" : r.detectionMs.toFixed(2),
      r.baselineSamplesAtDecision,
      r.canarySamplesAtDecision,
    ].join(","),
  );
  return [header.join(","), ...rows].join("\n") + "\n";
}

function fmt(n: number | undefined, digits = 3): string {
  return n === undefined ? "n/a" : n.toFixed(digits);
}

function fmtMs(n: number | undefined): string {
  return n === undefined ? "n/a" : `${n.toFixed(0)}ms`;
}

export function toMarkdownSummary(summaries: CellSummary[], generatedAt: string): string {
  const lines: string[] = [];
  lines.push("# Canary rollout controller — A/A and A/B validation results");
  lines.push("");
  lines.push(`Generated ${generatedAt}. Raw per-trial data: \`raw-trials.csv\` in this directory.`);
  lines.push("");
  lines.push(
    "| Controller | Scenario | Trials | Rollback rate | Completed | Timed out | Detection time (rollbacks): median / mean / p90 |",
  );
  lines.push("|---|---|---|---|---|---|---|");
  for (const s of summaries) {
    const scenarioLabel = s.scenario === "aa" ? "A/A (no regression)" : "A/B (injected regression)";
    lines.push(
      `| ${s.controllerType} | ${scenarioLabel} | ${s.trials} | ${fmt(s.rollbackRate)} | ${s.completed} | ${s.timedOut} | ${fmtMs(s.detectionMsMedianOfRollbacks)} / ${fmtMs(s.detectionMsMeanOfRollbacks)} / ${fmtMs(s.detectionMsP90OfRollbacks)} |`,
    );
  }
  lines.push("");
  lines.push(
    "Under `aa`, `rollbackRate` is the empirical **false-positive rollback rate** (no regression exists). " +
      "Under `ab`, `rollbackRate` is the empirical **true-positive detection rate** (a real regression exists).",
  );
  return lines.join("\n") + "\n";
}
