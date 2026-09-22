# Validation methodology

This project's central claim — that the SPRT statistical controller is a
real improvement over a naive fixed-error-rate threshold — is backed by
actual A/A and A/B trials against a real running HTTP stack, not asserted
from the math alone. This document explains the methodology, how to run it,
and how to read the output.

## Table of contents

- [Why A/A and A/B, specifically](#why-aa-and-ab-specifically)
- [What one trial actually does](#what-one-trial-actually-does)
- [The full validation batch](#the-full-validation-batch)
- [Running it](#running-it)
- [Reading the output](#reading-the-output)
- [Latest results](#latest-results)
- [What this does *not* validate](#what-this-does-not-validate)

## Why A/A and A/B, specifically

- **A/A test** — baseline and canary are configured with the **same** error
  rate (no regression exists). Any `"rollback"` verdict here is, by
  definition, a **false positive**. Running many independent A/A trials and
  counting how often the controller rolls back anyway measures its
  real-world false-positive rate empirically — the only way to check
  whether a statistical test's stated `alpha` actually holds up under real
  traffic and real sequential decision-making, rather than trusting the
  formula on paper.
- **A/B test** — the canary is configured with a real, injected error-rate
  regression (comfortably past the SPRT controller's configured minimum
  detectable effect, so a miss is genuinely about the test's power, not
  about the injected effect being too subtle to matter). Any run that
  reaches `"completed"` instead of `"rolled_back"` here is a **missed
  regression** — this measures true-positive detection rate and, for the
  runs that do roll back, how quickly.

Both scenarios are run for **both** controllers (naive and SPRT), so every
number in the results table has a same-conditions counterpart to compare
against.

## What one trial actually does

`packages/validation/src/trial.ts`'s `runTrial()` reuses the exact same
production stack the rest of this project is built from — no parallel
mock or simulation:

1. Boots two real `@canary/target-service` instances (baseline, canary) on
   ephemeral ports, configured per the scenario (`aa`: identical error
   rates; `ab`: canary regressed by the injected amount).
2. Boots a real proxy + `MetricsCollector` in front of them.
3. Constructs a real `RolloutStateMachine` with a **single stage** (e.g.
   `stages: [50]`) — deliberately not the full multi-stage rollout. The
   false-positive/true-positive/detection-time metrics this validation
   measures are about the decision engine's behavior at a fixed canary
   percentage; the multi-stage progression itself is already covered by the
   controller package's own integration tests
   (`packages/controller/test/rollout.integration.test.ts`).
4. Drives real concurrent HTTP load through the whole stack via `runLoad()`,
   while polling `tick()` on an interval, until the state machine reaches a
   terminal status (`"rolled_back"` or `"completed"`) or `maxTrialMs`
   elapses.
5. A trial that never reaches a terminal status within `maxTrialMs` is
   recorded with outcome `"timeout"` — **not dropped from the data.** A
   controller that's simply too slow to resolve shows up as a real row in
   the output, rather than silently vanishing and inflating apparent
   accuracy.

## The full validation batch

`packages/validation/src/runValidation.ts` runs:

```
TRIALS_PER_CELL (default 30) × 2 controllers (naive, statistical) × 2 scenarios (aa, ab)
= 120 trials by default
```

Fixed parameters across the default batch:

| Parameter | Value | Why |
|---|---|---|
| Baseline error rate | 5% | Both scenarios share this; only the canary's rate differs. |
| A/B injected regression | +10 percentage points (→ 15%) | Comfortably past the SPRT's configured 5-point minimum detectable effect, so misses are about test power, not effect subtlety. |
| Stage canary percent | 50% | A single fixed stage, per the "what runTrial does" section above. |
| Naive controller config | `errorRateThreshold: 0.1, minSamples: 30` | |
| SPRT config | `alpha: 0.05, beta: 0.1, minimumDetectableEffect: 0.05, minBaselineSamples: 200` | |
| Latency / jitter | 0 | This validation is scoped to the **error-rate** signal only; a latency-based regression is a separate, out-of-scope extension. |
| Max trial duration | 8 seconds | Trials exceeding this are recorded as `"timeout"`. |

## Running it

```bash
./run-validation.sh
```

Or override the sample size per cell:

```bash
TRIALS_PER_CELL=50 ./run-validation.sh
```

This builds every workspace, then runs
`packages/validation/dist/runValidation.js`, which writes:

- **`packages/validation/results/raw-trials.csv`** — every individual
  trial's row: controller, scenario, outcome, detection time, and sample
  counts at the moment of decision. Kept for reproducibility — anyone can
  re-derive the summary numbers from this file independently.
- **`packages/validation/results/summary.md`** — the aggregated comparison
  table, generated by `packages/validation/src/report.ts`'s
  `toMarkdownSummary()`.

Console output streams each trial's result as it completes
(`[scenario/controller] trial i/N: outcome (Xms)`), so a long batch's
progress is visible while it runs.

## Reading the output

For a given (controller, scenario) cell:

- **Under `aa`**, `rollbackRate` is the empirical **false-positive rate** —
  lower is better, and for the SPRT controller it should track its
  configured `alpha` (5%) within sampling noise.
- **Under `ab`**, `rollbackRate` is the empirical **true-positive detection
  rate** — higher is better, ideally close to `1 − beta` (90%) or above for
  the SPRT controller, given the injected effect size safely exceeds its
  minimum detectable effect.
- **Detection time** (median/mean/p90) is computed only over trials that
  *did* reach a terminal decision (`rolled_back` or `completed`) — it's the
  wall-clock time from `RolloutStateMachine.start()` to that terminal
  status, not a network-mediated production timing.

## Latest results

30 trials per cell, 120 trials total, generated 2026-09-18 — checked in at
`packages/validation/results/`:

| Controller | Scenario | Trials | Rollback rate | Completed | Timed out | Detection time (rollbacks): median / mean / p90 |
|---|---|---|---|---|---|---|
| naive | A/A (no regression) | 30 | 0.033 | 29 | 0 | 47ms / 47ms / 47ms |
| statistical | A/A (no regression) | 30 | 0.067 | 28 | 0 | 240ms / 240ms / 258ms |
| naive | A/B (injected regression) | 30 | 0.800 | 6 | 0 | 31ms / 33ms / 45ms |
| statistical | A/B (injected regression) | 30 | 1.000 | 0 | 0 | 136ms / 133ms / 152ms |

Interpretation: see the README's
["Naive vs. statistical" section](../README.md#naive-vs-statistical-the-actual-comparison)
for the full read, and [`STATISTICS.md`](STATISTICS.md) for the two real
bugs this exact validation process caught before these numbers were clean.

## What this does *not* validate

- **Latency-based regressions.** Every trial above holds latency/jitter at
  zero specifically to isolate the error-rate signal; a latency-driven
  regression is untested by this harness.
- **Multi-stage progression.** Each trial uses a single fixed stage; the
  full staged rollout (5% → 25% → 50% → 100%, advancing and resetting
  metrics between stages) is covered separately by
  `packages/controller/test/rollout.integration.test.ts`, not by this
  validation batch.
- **Non-stationary traffic.** Error/latency rates are held constant for the
  duration of a trial; a regression that only appears intermittently or
  ramps up over time is not modeled here.
- **Bit-for-bit reproducibility of individual trials.** The target service's
  randomness is unseeded (see the README's
  [limitations section](../README.md#project-status-and-honest-limitations)),
  so aggregate rates are reproducible in distribution, but no single trial's
  exact outcome is guaranteed to repeat.
