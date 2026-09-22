# canary-rollout-controller

A staged canary rollout controller that decides **automatically** whether a
new service version is safe to keep receiving traffic — using a real
statistical decision engine (Wald's Sequential Probability Ratio Test)
instead of a fixed error-rate threshold, validated by running actual A/A and
A/B experiments against a real HTTP stack.

This is not a diagram or a simulation of the idea. Every piece described
below — the traffic splitter, the proxy, the two target-service backends,
the statistical test, the rollback path, the dashboard — is real, running
TypeScript code with tests that exercise it end to end over real HTTP.

```
naive fixed-threshold controller   →  80.0% detection rate on a real 10pp regression, 3.3% false-positive rate
SPRT statistical controller        → 100.0% detection rate on the same regression, 6.7% false-positive rate
```

Full numbers, methodology, and how to reproduce them: [`docs/VALIDATION.md`](docs/VALIDATION.md).

---

## Table of contents

- [Why this exists](#why-this-exists)
- [How it works, in one picture](#how-it-works-in-one-picture)
- [Quick start](#quick-start)
- [Run the interactive demo](#run-the-interactive-demo)
- [Reproduce the validation results](#reproduce-the-validation-results)
- [Naive vs. statistical: the actual comparison](#naive-vs-statistical-the-actual-comparison)
- [Two real bugs the validation caught](#two-real-bugs-the-validation-caught)
- [Packages](#packages)
- [Project status and honest limitations](#project-status-and-honest-limitations)
- [Documentation map](#documentation-map)
- [Contributing](#contributing)
- [License](#license)

## Why this exists

Most homegrown canary rollout logic looks like this:

> "If the canary's error rate goes above 5%, roll back."

That single sentence hides two real statistical problems:

1. **No baseline comparison.** A service's *baseline* version is rarely at
   exactly 0% errors either. A fixed threshold can't tell "the canary
   regressed" apart from "the baseline is just having a noisy few seconds" —
   it only ever looks at the canary in isolation.
2. **The peeking problem.** Checking a fixed-sample statistical test
   repeatedly, before it reaches its planned sample size, inflates its
   real-world false-positive rate above whatever "significance level" it was
   designed for. This is the same mechanism behind classic A/B-testing
   p-hacking — stop as soon as the numbers look good, and you'll eventually
   get a good-looking number by chance alone.

This project builds the naive version anyway — deliberately, as the
baseline to beat — and then builds a proper sequential test
([Wald's SPRT](https://en.wikipedia.org/wiki/Sequential_probability_ratio_test))
that compares the canary against the baseline's own concurrently observed
error rate, and whose false-positive/false-negative rates are controlled *by
construction* under continuous, sample-by-sample monitoring. Then it proves
the difference with actual A/A (no regression injected) and A/B (regression
injected) trials against a real running system, not a thought experiment.

See [`docs/STATISTICS.md`](docs/STATISTICS.md) for the full mathematical
rationale, including why SPRT was chosen over a group-sequential z-test with
alpha-spending.

## How it works, in one picture

```
                     ┌─────────────────────────┐
  HTTP traffic  ───▶ │   Proxy (splitter)       │
                     │  routes each request to  │
                     │  baseline OR canary       │
                     └────────────┬─────────────┘
                                  │  every request outcome
                                  ▼
                     ┌─────────────────────────┐
                     │   Metrics Collector       │
                     │ per-version count/error/  │
                     │ latency, reset per stage  │
                     └────────────┬─────────────┘
                                  │  VersionStats (baseline, canary)
                                  ▼
              ┌───────────────────────────────────────┐
              │        Decision Engine                 │
              │  naive threshold  OR  SPRT statistical  │
              │  → "proceed" | "hold" | "rollback"      │
              └────────────────────┬────────────────────┘
                                   │
                                   ▼
                     ┌─────────────────────────┐
                     │  Rollout State Machine    │
                     │ advances stages (5→25→50→ │
                     │ 100%), rolls back to 0%    │
                     │ on regression/ambiguity     │
                     └────────────┬─────────────┘
                                  │  drives
                                  ▼
                     ┌─────────────────────────┐
                     │   Traffic Splitter        │  ← same splitter the
                     │  (mutable canary %)        │    proxy reads from
                     └─────────────────────────┘

                     ┌─────────────────────────┐
                     │  Dashboard (read-only)    │  polls a snapshot,
                     │  /api/status + live HTML  │  renders it — has no
                     └─────────────────────────┘  knowledge of the above
```

Full component-by-component breakdown, including every module's exact
responsibility and the seams between them: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Quick start

Requirements: **Node.js 20+** and npm (npm workspaces are used for the
monorepo layout — no other package manager is supported).

```bash
git clone git@github.com:jamnxdev/canary-rollout-controller.git
cd canary-rollout-controller
npm install
npm run build --workspaces
npm test --workspaces
```

You should see all test suites pass (target-service, controller, and
validation packages, ~55 tests total as of this writing).

## Run the interactive demo

The demo wires up two real target-service instances (baseline + canary), a
real proxy, a real rollout state machine, and a live dashboard, all in one
local process — then fires real concurrent HTTP load through it and lets it
run to completion.

**Scenario 1 — a bad deploy that should auto-rollback:**

```bash
npm run build --workspace=@canary/controller
CONTROLLER=statistical CANARY_ERROR_RATE=0.3 node packages/controller/dist/demo.js
```

**Scenario 2 — a healthy canary that should roll all the way out:**

```bash
CONTROLLER=statistical CANARY_ERROR_RATE=0.02 node packages/controller/dist/demo.js
```

While it's running, open **http://127.0.0.1:4001** to watch the rollout
stage, live per-version error rates, and the decision timeline update in
real time (polling `/api/status` every 500ms). Full list of environment
variables and what each demo scenario demonstrates:
[`docs/DEMO.md`](docs/DEMO.md).

## Reproduce the validation results

```bash
./run-validation.sh
# or, with a different sample size per cell:
TRIALS_PER_CELL=50 ./run-validation.sh
```

This runs 30 trials (configurable) × 2 controllers (naive, statistical) × 2
scenarios (A/A, A/B) — 120 real trials by default, each spinning up real
target-service instances and driving real traffic through a real proxy and
rollout state machine — and writes:

- `packages/validation/results/raw-trials.csv` — every individual trial's outcome (reproducibility)
- `packages/validation/results/summary.md` — the aggregated comparison table

Methodology, what "A/A" and "A/B" mean here, and how to read the output:
[`docs/VALIDATION.md`](docs/VALIDATION.md).

## Naive vs. statistical: the actual comparison

Results from the checked-in validation run (30 trials/cell, baseline fixed
at 5% error rate, injected regression is +10 percentage points):

| Controller | Scenario | Trials | Rollback rate | Detection time (median) |
|---|---|---|---|---|
| naive (fixed threshold) | A/A — no regression | 30 | 3.3% | 47ms |
| **SPRT (statistical)** | **A/A — no regression** | 30 | **6.7%** | 240ms |
| naive (fixed threshold) | A/B — real regression | 30 | 80.0% | 31ms |
| **SPRT (statistical)** | **A/B — real regression** | 30 | **100.0%** | 136ms |

Read plainly, not just favorably:

- The SPRT controller's false-positive rate (6.7%) is *designed and
  verified* to sit near its target alpha (5%) — it's a calibrated,
  reproducible guarantee. The naive controller's 3.3% is **incidental**: it
  isn't targeting any specific false-positive rate, so that number could
  look arbitrarily better or worse with a different threshold or a
  different true baseline error rate, with no way to know in advance. That
  contrast — *designed* vs. *incidental* — is the actual headline result.
- The SPRT controller catches the injected regression **every single time**
  in this run (30/30), where the naive controller misses 1 in 5 real
  regressions (80%) at the same sample budget.
- That reliability isn't free: the SPRT controller is visibly slower to
  decide (~136–240ms vs. ~30–47ms here), because it requires a much larger
  baseline sample (`minBaselineSamples: 200` vs. the naive controller's 30)
  before it will even start judging, and needs enough cumulative evidence
  for its log-likelihood ratio to cross a decision boundary rather than
  reacting to the first noisy snapshot. This is the real
  rollout-speed-vs-statistical-power tradeoff, showing up directly in
  measured data.

## Two real bugs the validation caught

The whole point of building an actual A/A/A-B validation harness — rather
than trusting the SPRT math because the unit tests for it pass — is that it
can catch bugs unit tests structurally cannot. It did, twice.

**Bug 1 — re-estimating the null hypothesis on every tick inflated the
false-positive rate to 36.7%.** The very first full validation run (before
either fix below) measured a false-positive rate of 36.7% against a 5%
target — worse than the naive controller it was supposed to be improving on.
Root cause: the SPRT's reference error rate (`p0`) was being recomputed from
the baseline's *current* stats on every single evaluation, instead of being
fixed once. Because the rollout state machine calls the decision engine on
every tick (tens of times per second) while traffic keeps arriving, `p0` —
and therefore the whole log-likelihood-ratio scale — was silently shifting
between ticks. Each tick was technically testing a *different* hypothesis
pair, which breaks the fixed-hypothesis assumption Wald's boundaries are
derived from. It's a second, independent instance of the exact "peeking
problem" this project set out to solve — this time hiding in the *reference
distribution* rather than in *when you check the result*. No Day 1–4 unit
test could have caught it, because every one of them happened to pass the
same fixed baseline stats object into every call in a given test. **Fix:**
freeze `p0`/`p1` the first time the baseline clears its minimum sample
floor, and reuse that frozen pair for the rest of the test's lifetime.

**Bug 2 — the SPRT could never re-freeze at a 100%-canary stage, so a
healthy rollout got stuck on "hold" forever.** After fixing Bug 1, running
the demo with a fully healthy canary against the default `[5, 25, 50, 100]`
stage list never reached `"completed"` — it sat on `"hold"` indefinitely at
the final stage. At 100% canary traffic, the traffic splitter sends *zero*
requests to baseline by construction, so a fresh baseline sample can never
accumulate there — and the stage-advance hook was unconditionally clearing
the frozen `p0`/`p1` on every stage transition, including that one. **Fix:**
the stage-advance hook now receives the *new* stage's canary percentage, and
the demo only resets the frozen baseline estimate when the new stage isn't
100% canary — carrying the previous stage's frozen estimate forward as the
closest honest reference available, rather than either getting stuck forever
or silently skipping the statistical check exactly where a slow regression
would matter most (100% production traffic on the new version).

Both fixes are in the current code (`packages/controller/src/statisticalController.ts`
and `packages/controller/src/stateMachine.ts`), each with a regression test
that exercises the specific sequence of calls that exposed the bug.

## Packages

This is an npm-workspaces monorepo with three packages:

| Package | Purpose | README |
|---|---|---|
| [`@canary/target-service`](packages/target-service) | A single configurable HTTP service instance (used as both "baseline" and "canary") with tunable latency and error rate. | [packages/target-service/README.md](packages/target-service/README.md) |
| [`@canary/controller`](packages/controller) | The traffic splitter, proxy, metrics collector, both decision engines, the rollout state machine, the live dashboard, and the demo entry point. | [packages/controller/README.md](packages/controller/README.md) |
| [`@canary/validation`](packages/validation) | The A/A and A/B trial harness, statistics helpers, and report generation used to empirically measure both controllers. | [packages/validation/README.md](packages/validation/README.md) |

## Project status and honest limitations

This project is complete through what its own internal plan called "Day 6":
a fully working, tested, locally validated control plane and dashboard. What
is deliberately **not** included, stated plainly rather than glossed over:

- **No public deployment.** Everything above runs locally (`127.0.0.1`
  only). There is no systemd unit, reverse proxy, or open port configured.
- **No real cloud/service-mesh integration.** The traffic splitter and
  rollout controller are library modules composed into one Node.js process,
  not a network-addressable control plane commanding an external service
  mesh (e.g. Istio, Envoy, a cloud load balancer). This is a deliberate scope
  boundary, not an oversight — see [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md#the-single-process-decision-and-what-it-costs)
  for the reasoning and what it means for failure modes like "the controller
  process itself crashes mid-rollout."
- **Error-rate signal only.** The statistical controller judges canaries on
  error rate; a latency-based regression is out of scope for the validation
  harness (the target service supports configuring latency, but the
  validation trials hold it at zero specifically to isolate the error-rate
  signal).
- **Randomness is unseeded.** Target-service latency and error injection use
  `Math.random()` directly — fine for statistical-envelope tests and
  aggregate validation trials, but individual trial runs are not
  bit-for-bit reproducible.

## Documentation map

| Document | What's in it |
|---|---|
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Every module's responsibility, the data flow between them, and the design decisions/tradeoffs behind each one. |
| [`docs/STATISTICS.md`](docs/STATISTICS.md) | The math: why SPRT over a group-sequential z-test, the exact log-likelihood-ratio formula and boundaries, and the honest approximation (estimated vs. fixed `p0`). |
| [`docs/VALIDATION.md`](docs/VALIDATION.md) | The A/A/A-B methodology, how to run and interpret it, and the full results table. |
| [`docs/DEMO.md`](docs/DEMO.md) | Every environment variable the interactive demo accepts, and what each scenario is meant to show. |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | How to set up a dev environment, coding conventions, test expectations, and the PR process. |
| [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md) | Community standards for participation. |
| [`CHANGELOG.md`](CHANGELOG.md) | Notable changes by version. |

## Contributing

Contributions, issues, and questions are welcome — see
[`CONTRIBUTING.md`](CONTRIBUTING.md) for how to get a dev environment running,
this repo's conventions, and what a good pull request looks like.

## License

[MIT](LICENSE) © Jaimin Chovatia
