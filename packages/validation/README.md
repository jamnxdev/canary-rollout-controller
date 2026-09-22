# @canary/validation

The A/A and A/B trial harness that empirically measures the naive and
statistical controllers' real false-positive rate, true-positive rate, and
detection time — against real running instances, not a simulation.

Part of the [canary-rollout-controller](../../README.md) monorepo. Full
methodology: [`docs/VALIDATION.md`](../../docs/VALIDATION.md). This package
is also the reason two real statistical bugs got caught before shipping —
see [`docs/STATISTICS.md`](../../docs/STATISTICS.md).

## Modules at a glance

| Module | Exports | Responsibility |
|---|---|---|
| `trial.ts` | `runTrial`, `ControllerType`, `Scenario`, `TrialResult` | Runs one full trial: real target-service instances, real proxy/metrics, a real controller driving a single-stage `RolloutStateMachine`, under real concurrent load, to a terminal outcome or timeout. |
| `runValidation.ts` | (script) | The batch driver: `TRIALS_PER_CELL × 2 controllers × 2 scenarios` trials, writing CSV + Markdown results. |
| `stats.ts` | mean / median / percentile helpers | Small, dependency-free — used by `summarize.ts`. |
| `summarize.ts` | `summarize` | Groups raw `TrialResult[]` by controller × scenario; computes rollback rate and detection-time distribution. |
| `report.ts` | `toCsv`, `toMarkdownSummary` | Pure formatting functions over trial/summary data — no I/O, fully unit-testable. |

## Running the full validation batch

From the repo root:

```bash
./run-validation.sh
# or, with a different sample size per cell (default 30):
TRIALS_PER_CELL=50 ./run-validation.sh
```

This writes `results/raw-trials.csv` (every trial's raw row) and
`results/summary.md` (the aggregated comparison table) into this package's
`results/` directory, and prints the summary table to the console.

See [`docs/VALIDATION.md`](../../docs/VALIDATION.md) for what "A/A" and
"A/B" mean here, exactly what one trial does, and how to read the results.

## Running just this package's tests

```bash
npm test --workspace=@canary/validation
```

`stats.test.ts`, `summarize.test.ts`, and `report.test.ts` are pure-function
tests over synthetic data (no real servers). `trial.test.ts` runs
`runTrial()` end-to-end against real target-service instances — an obvious
injected regression resolves to `"rolled_back"` for the statistical
controller; two healthy versions resolve to `"completed"`.

## Using `runTrial` directly

```ts
import { runTrial } from "@canary/validation";

const result = await runTrial({
  controllerType: "statistical",
  scenario: "ab",
  baselineConfig: { latencyMs: 0, latencyJitterMs: 0, errorRate: 0.05 },
  canaryConfig: { latencyMs: 0, latencyJitterMs: 0, errorRate: 0.15 },
  stagePercent: 50,
  naiveConfig: { errorRateThreshold: 0.1, minSamples: 30 },
  sprtConfig: { alpha: 0.05, beta: 0.1, minimumDetectableEffect: 0.05, minBaselineSamples: 200 },
  loadConcurrency: 8,
  maxTrialMs: 8000,
  tickIntervalMs: 15,
});

console.log(result.outcome, result.detectionMs);
```

Useful if you want to script a custom scenario (a different injected effect
size, a different stage percentage) without editing `runValidation.ts`
directly.
