import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NaiveControllerConfig, SprtConfig } from "@canary/controller";
import { runTrial, type ControllerType, type Scenario, type TrialResult } from "./trial.js";
import { summarize } from "./summarize.js";
import { toCsv, toMarkdownSummary } from "./report.js";

const TRIALS_PER_CELL = Number(process.env.TRIALS_PER_CELL ?? "30");
const BASELINE_ERROR_RATE = 0.05;
/** +10 percentage points — comfortably past the SPRT's 5pp minimum detectable effect. */
const INJECTED_REGRESSION_ERROR_RATE = 0.15;
const STAGE_PERCENT = 50;
const MAX_TRIAL_MS = 8000;
const TICK_INTERVAL_MS = 15;
const LOAD_CONCURRENCY = 8;

const NAIVE_CONFIG: NaiveControllerConfig = { errorRateThreshold: 0.1, minSamples: 30 };
const SPRT_CONFIG: SprtConfig = { alpha: 0.05, beta: 0.1, minimumDetectableEffect: 0.05, minBaselineSamples: 200 };

function scenarioConfigs(scenario: Scenario) {
  const common = { latencyMs: 0, latencyJitterMs: 0 };
  return {
    baselineConfig: { ...common, errorRate: BASELINE_ERROR_RATE },
    canaryConfig: {
      ...common,
      errorRate: scenario === "aa" ? BASELINE_ERROR_RATE : INJECTED_REGRESSION_ERROR_RATE,
    },
  };
}

async function runCell(controllerType: ControllerType, scenario: Scenario): Promise<TrialResult[]> {
  const results: TrialResult[] = [];
  for (let i = 0; i < TRIALS_PER_CELL; i++) {
    const { baselineConfig, canaryConfig } = scenarioConfigs(scenario);
    const result = await runTrial({
      controllerType,
      scenario,
      baselineConfig,
      canaryConfig,
      stagePercent: STAGE_PERCENT,
      naiveConfig: NAIVE_CONFIG,
      sprtConfig: SPRT_CONFIG,
      loadConcurrency: LOAD_CONCURRENCY,
      maxTrialMs: MAX_TRIAL_MS,
      tickIntervalMs: TICK_INTERVAL_MS,
    });
    results.push(result);
    const timeLabel = result.detectionMs === undefined ? "n/a" : `${result.detectionMs.toFixed(0)}ms`;
    console.log(
      `[${scenario}/${controllerType}] trial ${i + 1}/${TRIALS_PER_CELL}: ${result.outcome} (${timeLabel})`,
    );
  }
  return results;
}

async function main(): Promise<void> {
  const controllers: ControllerType[] = ["naive", "statistical"];
  const scenarios: Scenario[] = ["aa", "ab"];

  const allResults: TrialResult[] = [];
  for (const scenario of scenarios) {
    for (const controllerType of controllers) {
      const cellResults = await runCell(controllerType, scenario);
      allResults.push(...cellResults);
    }
  }

  const summaries = summarize(allResults);

  const resultsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "results");
  await mkdir(resultsDir, { recursive: true });
  await writeFile(path.join(resultsDir, "raw-trials.csv"), toCsv(allResults), "utf8");
  await writeFile(
    path.join(resultsDir, "summary.md"),
    toMarkdownSummary(summaries, new Date().toISOString()),
    "utf8",
  );

  console.log("\n" + toMarkdownSummary(summaries, new Date().toISOString()));
  console.log(`Wrote ${allResults.length} trial rows to ${resultsDir}/raw-trials.csv`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
