# @canary/controller

The control plane: traffic splitting, the HTTP proxy, per-version metrics,
both decision engines (naive and statistical), the staged rollout state
machine, the live dashboard, and the demo entry point that wires all of it
together.

Part of the [canary-rollout-controller](../../README.md) monorepo. Full
architecture and design rationale for every module here:
[`docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md). Full math behind the
statistical controller: [`docs/STATISTICS.md`](../../docs/STATISTICS.md).

## Exports

```ts
import {
  TrafficSplitter, type Version,
  buildProxy, type BackendTargets, type RequestOutcome, type OutcomeListener,
  runLoad, type LoadOptions, type LoadResult,
  MetricsCollector, type VersionStats,
  NaiveThresholdController, type Decision, type NaiveControllerConfig,
  SequentialProbabilityRatioController, type SprtConfig, type SprtResult,
  RolloutStateMachine, type DecisionEngine, type RolloutStatus, type RolloutEvent, type RolloutStateMachineConfig,
  buildDashboardApp, type DashboardSnapshot, type SnapshotProvider,
} from "@canary/controller";
```

## Modules at a glance

| Module | Exports | Responsibility |
|---|---|---|
| `splitter.ts` | `TrafficSplitter` | Holds a mutable `[0, 100]` canary percentage; `route()` decides baseline vs. canary per call. |
| `proxy.ts` | `buildProxy` | The real HTTP entry point: routes `/work` via the splitter, times it, reports the outcome, relays the response. |
| `loadgen.ts` | `runLoad` | Fires concurrent, continuous `/work` traffic at a proxy for a duration (or until told to stop). |
| `metricsCollector.ts` | `MetricsCollector` | Accumulates per-version request outcomes; `reset()` at each rollout stage boundary. |
| `naiveController.ts` | `NaiveThresholdController` | The fixed-error-rate-threshold baseline-to-beat. Canary-only, no baseline comparison. |
| `statisticalController.ts` | `SequentialProbabilityRatioController` | Wald's SPRT, comparing canary error rate against the baseline's own observed rate. |
| `stateMachine.ts` | `RolloutStateMachine` | Drives staged rollout progression and fail-safe rollback, generic over which controller it holds. |
| `dashboard.ts` | `buildDashboardApp` | A read-only Fastify app rendering any injected `DashboardSnapshot`. |
| `demo.ts` | (script, not a library export) | Standalone, env-var-driven demo wiring the entire stack together locally. |

See [`docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md) for exactly how
these compose and why each seam is drawn where it is.

## Quick example: driving a rollout programmatically

```ts
import { buildServer } from "@canary/target-service";
import {
  TrafficSplitter, buildProxy, MetricsCollector,
  SequentialProbabilityRatioController, RolloutStateMachine,
  type DecisionEngine,
} from "@canary/controller";

const baseline = buildServer({ versionLabel: "baseline", latencyMs: 10, latencyJitterMs: 5, errorRate: 0.02 });
const canary = buildServer({ versionLabel: "canary", latencyMs: 10, latencyJitterMs: 5, errorRate: 0.02 });
const baselineUrl = await baseline.listen({ port: 0, host: "127.0.0.1" });
const canaryUrl = await canary.listen({ port: 0, host: "127.0.0.1" });

const splitter = new TrafficSplitter();
const metrics = new MetricsCollector();
const proxy = buildProxy(splitter, { baseline: baselineUrl, canary: canaryUrl }, (o) => metrics.record(o));
await proxy.listen({ port: 0, host: "127.0.0.1" });

const sprt = new SequentialProbabilityRatioController({
  alpha: 0.05,
  beta: 0.1,
  minimumDetectableEffect: 0.05,
  minBaselineSamples: 200,
});
const decide: DecisionEngine = (baseline, canary) => sprt.evaluate(baseline, canary).decision;

const machine = new RolloutStateMachine({
  stages: [5, 25, 50, 100],
  splitter,
  metrics,
  decide,
  onStageAdvance: (newCanaryPercent) => {
    if (newCanaryPercent < 100) sprt.reset();
  },
});

machine.start();
// call machine.tick() on your own interval, e.g. every 20ms, while real
// traffic flows through the proxy above.
```

**Read the `onStageAdvance` guard above carefully before reusing this
pattern** — omitting the `newCanaryPercent < 100` check will cause the
rollout to stall forever at a 100%-canary stage. See
[`docs/STATISTICS.md`](../../docs/STATISTICS.md#bug-2-the-sprt-can-never-re-freeze-at-a-100-stage)
for exactly why.

## Running the demo

See [`docs/DEMO.md`](../../docs/DEMO.md) for the full walkthrough and every
environment variable. Quick version:

```bash
npm run build --workspace=@canary/controller
CONTROLLER=statistical CANARY_ERROR_RATE=0.3 node dist/demo.js   # from this package's directory
```

Then open `http://127.0.0.1:4001` for the live dashboard.

## Testing

```bash
npm test --workspace=@canary/controller
```

Includes both fast pure-logic unit tests (splitter, metrics, both
controllers, state machine control flow with a scripted decision engine) and
real end-to-end integration tests
(`test/rollout.integration.test.ts`) that start real target-service
instances, drive real concurrent traffic through a real proxy, and assert
the full rollout reaches the correct terminal state.
