import type { ControllerType, Scenario, TrialOutcome, TrialResult } from "./trial.js";
import { mean, median, percentile } from "./stats.js";

export interface CellSummary {
  controllerType: ControllerType;
  scenario: Scenario;
  trials: number;
  rolledBack: number;
  completed: number;
  timedOut: number;
  /** rollback count / trials — the false-positive rate under "aa", the true-positive rate under "ab". */
  rollbackRate: number;
  detectionMsMeanOfRollbacks: number | undefined;
  detectionMsMedianOfRollbacks: number | undefined;
  detectionMsP90OfRollbacks: number | undefined;
}

export function summarize(results: TrialResult[]): CellSummary[] {
  const cells = new Map<string, TrialResult[]>();
  for (const result of results) {
    const key = `${result.controllerType}:${result.scenario}`;
    const bucket = cells.get(key) ?? [];
    bucket.push(result);
    cells.set(key, bucket);
  }

  return [...cells.entries()].map(([, trials]) => {
    const controllerType = trials[0]?.controllerType as ControllerType;
    const scenario = trials[0]?.scenario as Scenario;
    const countOf = (outcome: TrialOutcome) => trials.filter((t) => t.outcome === outcome).length;
    const rollbackDetectionTimes = trials
      .filter((t) => t.outcome === "rolled_back")
      .map((t) => t.detectionMs as number);

    const rolledBack = countOf("rolled_back");
    return {
      controllerType,
      scenario,
      trials: trials.length,
      rolledBack,
      completed: countOf("completed"),
      timedOut: countOf("timeout"),
      rollbackRate: rolledBack / trials.length,
      detectionMsMeanOfRollbacks: mean(rollbackDetectionTimes),
      detectionMsMedianOfRollbacks: median(rollbackDetectionTimes),
      detectionMsP90OfRollbacks: percentile(rollbackDetectionTimes, 90),
    };
  });
}
