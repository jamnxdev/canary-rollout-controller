# @canary/target-service

A single, configurable HTTP service instance representing **one version**
("baseline" or "canary") of the service under rollout. It's the thing real
traffic is actually routed to.

Part of the [canary-rollout-controller](../../README.md) monorepo — see the
root README for the full project. Design rationale for this package lives in
[`docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md#target-service-packagestarget-servicesrcserverts).

## What it does

A Fastify app with two routes:

- `GET /health` → `{ status: "ok", version }`
- `GET /work` → the simulated unit of work: sleeps for a configurable
  latency (with jitter), then fails with an HTTP 500 with a configurable
  probability.

There is deliberately no other behavior. Configuration is the entire
surface — the same server code, run twice with different config, *is* both
"baseline" and "canary," and *is* both the "healthy" and "regressed" A/A/A-B
validation scenarios. There's no separate fault-injection code path.

## Configuration

`TargetServiceConfig`:

| Field | Type | Meaning |
|---|---|---|
| `versionLabel` | `string` | Reported in `/health` and `/work` responses. Not constrained to `"baseline"`/`"canary"` — any label works. |
| `latencyMs` | `number` | Base simulated handling latency, in ms. |
| `latencyJitterMs` | `number` | Latency is uniformly jittered by `± latencyJitterMs` around `latencyMs`. |
| `errorRate` | `number` | Fraction of `/work` calls that return a 500, in `[0, 1]`. |

## Running it standalone

```bash
npm run build --workspace=@canary/target-service
VERSION_LABEL=canary PORT=4100 ERROR_RATE=0.1 LATENCY_MS=15 node packages/target-service/dist/start.js
```

Environment variables read by `start.ts`:

| Variable | Required | Default | Maps to |
|---|---|---|---|
| `VERSION_LABEL` | **yes** | — | `versionLabel` |
| `PORT` | no | `0` (random free port) | listen port |
| `LATENCY_MS` | no | `10` | `latencyMs` |
| `LATENCY_JITTER_MS` | no | `5` | `latencyJitterMs` |
| `ERROR_RATE` | no | `0` | `errorRate` |

`VERSION_LABEL` is required and fails fast if missing — a mislabeled
instance would be a silent correctness bug in every metric computed
downstream, so this is intentionally not defaulted.

## Using it as a library

```ts
import { buildServer, type TargetServiceConfig } from "@canary/target-service";

const config: TargetServiceConfig = {
  versionLabel: "canary",
  latencyMs: 10,
  latencyJitterMs: 5,
  errorRate: 0.02,
};

const app = buildServer(config);
await app.listen({ port: 0, host: "127.0.0.1" });
```

This is exactly how `@canary/controller`'s demo and `@canary/validation`'s
trial harness both use it.

## Testing

```bash
npm test --workspace=@canary/target-service
```

Notably includes an empirical statistical-envelope test: 500 real trials at
`errorRate: 0.2`, asserting the observed error rate lands within a wide band
(derived from the binomial standard deviation at that sample size, not an
arbitrary tolerance) around 0.2 — the pattern this whole project relies on
for testing probabilistic behavior honestly.
