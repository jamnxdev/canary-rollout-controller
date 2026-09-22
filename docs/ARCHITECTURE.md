# Architecture

This document walks through every module in the system, what it owns, and
why the seams between modules are drawn where they are. It assumes you've
read the [README](../README.md)'s one-picture overview first.

## Table of contents

- [Design principle: function-shaped seams](#design-principle-function-shaped-seams)
- [Component walkthrough](#component-walkthrough)
  - [Target service](#target-service-packagestarget-servicesrcserverts)
  - [Traffic splitter](#traffic-splitter-packagescontrollersrcsplitterts)
  - [Proxy](#proxy-packagescontrollersrcproxyts)
  - [Load generator](#load-generator-packagescontrollersrcloadgents)
  - [Metrics collector](#metrics-collector-packagescontrollersrcmetricscollectorts)
  - [Naive threshold controller](#naive-threshold-controller-packagescontrollersrcnaivecontrollerts)
  - [Statistical (SPRT) controller](#statistical-sprt-controller-packagescontrollersrcstatisticalcontrollerts)
  - [Rollout state machine](#rollout-state-machine-packagescontrollersrcstatemachinets)
  - [Dashboard](#dashboard-packagescontrollersrcdashboardts)
  - [Demo entry point](#demo-entry-point-packagescontrollersrcdemots)
- [The single-process decision, and what it costs](#the-single-process-decision-and-what-it-costs)
- [Why the state machine doesn't know which controller it's holding](#why-the-state-machine-doesnt-know-which-controller-its-holding)

## Design principle: function-shaped seams

Two of the most consequential design decisions in this codebase are about
what a component is allowed to *know* about its collaborators, and both are
solved the same way: a plain function type instead of an interface or a
concrete dependency.

- `DecisionEngine = (baseline: VersionStats, canary: VersionStats) => Decision`
  lets the rollout state machine drive either the naive controller or the
  SPRT controller without ever importing either one.
- `SnapshotProvider = () => DashboardSnapshot` lets the dashboard render a
  naive-controller run, a statistical-controller run, or a future real
  multi-service deployment identically, because it never holds a reference
  to a state machine, metrics collector, or splitter — only a closure that
  produces a plain snapshot object.

Both choices exist for the same reason: they make the naive-vs-statistical
comparison in `@canary/validation` an apples-to-apples swap (same state
machine, same stages, same traffic — only the `decide` function differs),
rather than requiring two parallel code paths that could quietly drift apart.

## Component walkthrough

### Target service (`packages/target-service/src/server.ts`)

A single Fastify instance representing **one version** (baseline or canary)
of "the service under rollout." Two routes:

- `GET /health` → `{ status: "ok", version }`
- `GET /work` → the simulated unit of work: sleeps for `latencyMs ± latencyJitterMs`
  (uniform jitter), then fails with a 500 with probability `errorRate`.

Configuration (`TargetServiceConfig`) is the entire surface: `versionLabel`,
`latencyMs`, `latencyJitterMs`, `errorRate`. This is deliberately the *only*
knob. A/A validation and A/B validation are the same server code running
with different config — not a "normal mode" plus a separately bolted-on
"inject a fault" code path — which is exactly the property the validation
methodology in [`STATISTICS.md`](STATISTICS.md) needs: the two scenarios
must be identical in every respect except the one variable under test.

`start.ts` reads this config from environment variables and **requires**
`VERSION_LABEL` — it fails fast rather than defaulting it, because silently
routing traffic to a mislabeled instance would be a correctness bug in every
downstream metric without any visible symptom at the point of failure.

### Traffic splitter (`packages/controller/src/splitter.ts`)

`TrafficSplitter` holds one number: a clamped `[0, 100]` canary percentage.
`route()` is a single `Math.random() * 100 < canaryPercent` check per call.

It's deliberately **mutable** (`setCanaryPercent`), not recreated per rollout
stage, because the rollout state machine needs to change the live percentage
of an already-running proxy without restarting it or dropping in-flight
routing state.

### Proxy (`packages/controller/src/proxy.ts`)

`buildProxy(splitter, targets, onOutcome)` is the actual HTTP entry point
real traffic hits. Per `/work` call: asks the splitter which version, proxies
to that backend over `fetch`, times the round trip, and reports
`{ version, latencyMs, success }` through `onOutcome` — **this is the single
place a request's outcome is observed**, so there is no path by which an
outcome can be recorded by the metrics collector without also having been
served, or vice versa. An unreachable or erroring backend is reported as a
failed outcome and surfaced to the caller as a `502`, never silently
swallowed. `GET /status` exposes the current canary percentage as a minimal
read endpoint.

### Load generator (`packages/controller/src/loadgen.ts`)

`runLoad(proxyUrl, { durationMs, concurrency, shouldStop? })` fires
`concurrency` parallel workers, each looping request-after-request against
the proxy until a deadline (or until `shouldStop()` returns `true`).
Deliberately **not** rate-limited to a fixed requests/second — the goal is
"generate enough sample volume for a stage's hold period to reach a
decision," not "model a specific real-world traffic shape."

### Metrics collector (`packages/controller/src/metricsCollector.ts`)

`MetricsCollector` accumulates `RequestOutcome`s per version and exposes
`stats(version) → VersionStats { count, errors, errorRate, latenciesMs }`.
`reset()` clears both versions' samples. A "window" is deliberately just
"everything since the last reset" — the rollout state machine calls
`reset()` at the start of every stage, so a stage's decision is always made
from *that stage's own traffic at its own canary percentage*, never traffic
carried over from a previous, lower percentage.

Internally this stores baseline and canary samples as two explicit array
fields rather than a `Record<Version, RequestOutcome[]>` indexed
dynamically — under this project's `noUncheckedIndexedAccess` TypeScript
setting, indexing a record by a variable key is treated as possibly
`undefined` even when the union is closed and exhaustive, and two explicit
fields with a small ternary helper are both fully sound under `strict` mode
and arguably clearer, since there are only ever two versions.

### Naive threshold controller (`packages/controller/src/naiveController.ts`)

`NaiveThresholdController.decide(canary)` is the explicit anti-pattern this
project sets out to improve on: *"if canary error rate > X%, rollback."*
It looks at **only** the canary's own stats — no baseline comparison — and
returns `"hold"` below `minSamples`, `"rollback"` above `errorRateThreshold`,
`"proceed"` otherwise (boundary is strictly-greater-than: exactly at the
threshold still proceeds).

Its defining weakness — never comparing against the baseline's own
concurrent error rate — is intentional, not an oversight: it's built and
tested as a fair baseline-to-beat, not a strawman, and its failure mode
(can't distinguish "canary regressed" from "baseline is having a noisy
minute") is exactly what the statistical controller is built to fix.

### Statistical (SPRT) controller (`packages/controller/src/statisticalController.ts`)

`SequentialProbabilityRatioController.evaluate(baseline, canary)` runs
Wald's Sequential Probability Ratio Test over the canary's Bernoulli error
stream, testing `H0: canary error rate == p0` against
`H1: canary error rate == p1 = p0 + minimumDetectableEffect`, where `p0` is
estimated from the baseline's own concurrently observed error rate (frozen
once a minimum sample floor is cleared — see [`STATISTICS.md`](STATISTICS.md)
for why freezing matters and the bug that made it necessary).

Full mathematical treatment, the exact boundary formulas, and the
"estimated vs. fixed p0" approximation this implementation makes: see
[`STATISTICS.md`](STATISTICS.md).

### Rollout state machine (`packages/controller/src/stateMachine.ts`)

`RolloutStateMachine` drives a staged rollout through explicit states —
`"not_started" | "running" | "rolled_back" | "completed"` — over a
caller-configured list of ascending canary percentages (e.g. `[5, 25, 50, 100]`).

- `start()` moves to stage 0, resets metrics, and sets the splitter to the
  first stage's percent. Before `start()` is ever called, the splitter is
  left at whatever it was constructed with — `0%` by `TrafficSplitter`'s own
  default — which **is** the fail-safe answer to "what happens before a
  rollout begins": no canary traffic until explicitly told otherwise.
- `tick()` reads the current stage's accumulated stats, asks the injected
  `decide: DecisionEngine` for a verdict, and acts:
  - **`"rollback"`** → `splitter.setCanaryPercent(0)` immediately; status
    becomes terminal. Rollback is the default *safe* action on regression
    **or ambiguity** — there is no "proceed by default if unsure" path; only
    an explicit `"proceed"` verdict ever advances the rollout.
  - **`"hold"`** → no-op; stays at the current stage, accumulating more
    samples.
  - **`"proceed"`** at any stage but the last → advances `stageIndex`, resets
    metrics (so the next stage's decision is made from its own traffic),
    calls the optional `onStageAdvance(newCanaryPercent)` hook, then updates
    the splitter.
  - **`"proceed"`** at the last stage → `"completed"`, no further reset.
  - Both terminal statuses make every subsequent `tick()` call a genuine
    no-op — the decision engine is never consulted again once rolled back or
    completed.
- `getRollbackMttrMs()` reports the time from the rollback decision to the
  splitter reporting `0%`. In this design that's sub-millisecond, honestly,
  because splitter mutation is a synchronous in-process call with no network
  hop — see [the single-process tradeoff](#the-single-process-decision-and-what-it-costs)
  below for what this number does and doesn't represent.
- `getHistory()` returns every `start()`/`tick()` call as a timestamped event
  (stage index, canary percent, decision, status) — this is what the
  dashboard's rollout timeline renders directly, with no separate event log.

`onStageAdvance` exists specifically so a *stateful* decision engine (like
the SPRT controller, which freezes its own `p0`/`p1`) can reset that state at
a stage boundary — and receives the *new* stage's canary percent so a caller
can skip that reset at a 100%-canary stage, where a fresh baseline estimate
can structurally never form again (see [`STATISTICS.md`](STATISTICS.md)'s
"Bug 2" for the full story).

### Dashboard (`packages/controller/src/dashboard.ts`)

`buildDashboardApp(getSnapshot: SnapshotProvider)` is a small Fastify app
that only ever calls one caller-supplied closure and serves what it returns.
Two routes:

- `GET /api/status` — the raw JSON `DashboardSnapshot` (status, stage index,
  configured stage percents, current canary percent, both versions'
  `VersionStats`, the full rollout history, rollback MTTR when applicable).
- `GET /` — a self-contained HTML + vanilla-JS page that polls
  `/api/status` every 500ms. No build step, no framework — the dashboard
  doubles as this project's entire observability layer rather than being a
  separate stack bolted alongside it.

Because it has zero knowledge of what produced its snapshot, the exact same
dashboard renders a naive-controller run, a statistical-controller run, or
(in principle) a real multi-service deployment, unmodified.

### Demo entry point (`packages/controller/src/demo.ts`)

A standalone script, entirely driven by environment variables
(`CONTROLLER`, `CANARY_ERROR_RATE`, `CANARY_LATENCY_MS`, ports, durations —
full list in [`DEMO.md`](DEMO.md)). It wires up two real target-service
instances, a real proxy/metrics collector, either real controller, the real
`RolloutStateMachine`, and the dashboard, all in one local process bound to
`127.0.0.1`. The "trigger a bad deploy and watch it auto-rollback" and
"repeat with a healthy canary" scenarios are the *same script* with
different environment variables, not two separate code paths — matching the
target service's own config philosophy.

## The single-process decision, and what it costs

The traffic splitter, proxy, metrics collector, decision engine, and rollout
state machine all live as library modules composed into **one Node.js
process** — not separate network-addressable services talking over a
control API, the way a production canary controller commanding a real
service mesh (Istio, Envoy, a cloud load balancer) would look. This is a
deliberate scope decision: a real network hop between "the controller" and
"the thing enforcing traffic splits" would add surface area without adding
anything to this project's actual claim, which is about the *statistical
decision engine*, not distributed-systems plumbing.

This has one honest, worth-stating-plainly consequence: **if the controller
process crashes mid-rollout, the whole process — splitter included — goes
down with it, so no traffic is served at all (neither version) until the
process restarts.** That is a different failure mode than "stuck serving a
partial canary percentage forever" (which a truly decoupled control
plane + independent splitter could avoid, at the cost of the splitter
continuing to serve some traffic split with no active oversight while the
control plane recovers). Recording this here deliberately, rather than
implying the rollback MTTR number above represents a real network-mediated
config propagation — it represents an in-process function call, and nothing
more.

## Why the state machine doesn't know which controller it's holding

`RolloutStateMachine` is constructed with a `decide: DecisionEngine` — a
plain function — not a `NaiveThresholdController` or a
`SequentialProbabilityRatioController` reference. Both real controllers are
adapted to that one shared shape at the call site:

```ts
const decide: DecisionEngine =
  controllerKind === "naive"
    ? (_baseline, canary) => naive.decide(canary)   // discards the unused baseline argument here, not in the controller's API
    : (baseline, canary) => statistical.evaluate(baseline, canary).decision;
```

The naive controller's own `decide(canary)` keeps its one-argument
signature — that asymmetry *is* its defining limitation, and it's more
honest to make the adapter discard the unused argument at the call site than
to change the naive controller's public API to silently accept and ignore a
parameter it was never designed to use. This is also what makes the
naive-vs-statistical comparison in `@canary/validation` a true
apples-to-apples swap: same state machine, same stages, same traffic,
`decide` is the only thing that changes between cells.
