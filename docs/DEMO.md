# Running the interactive demo

`packages/controller/src/demo.ts` wires up the entire stack — two real
target-service instances, a real proxy and metrics collector, either
controller, the real rollout state machine, and the live dashboard — in one
local process, then drives real concurrent HTTP traffic through it until the
rollout finishes or the demo's duration elapses.

It binds every server to `127.0.0.1` only. This is a local, manual demo
entry point — see the README's
[limitations section](../README.md#project-status-and-honest-limitations)
for why there's no public deployment.

## Build once, run as many times as you like

```bash
npm install
npm run build --workspace=@canary/controller
```

Then, from the repo root:

```bash
CONTROLLER=statistical CANARY_ERROR_RATE=0.3 node packages/controller/dist/demo.js
```

## Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `CONTROLLER` | `statistical` | `"naive"` or `"statistical"` — which decision engine drives the rollout. |
| `CANARY_ERROR_RATE` | `0` | Fraction of the canary's `/work` requests that fail (500). The baseline is fixed at 2% for the whole demo. |
| `CANARY_LATENCY_MS` | `10` | Base simulated handling latency for the canary version, in ms. |
| `PROXY_PORT` | `4000` | Port the traffic-splitting proxy listens on. |
| `DASHBOARD_PORT` | `4001` | Port the live dashboard listens on. |
| `DEMO_DURATION_MS` | `60000` | Maximum wall-clock time the load generator will run before stopping (it also stops early the moment the rollout reaches a terminal status). |
| `DEMO_CONCURRENCY` | `20` | Number of parallel load-generator workers hitting the proxy. |

The rollout itself always uses stages `[5, 25, 50, 100]` and a 20ms tick
interval in the demo script — edit `demo.ts` directly if you want to try
different stage lists.

## Scenario 1 — a bad deploy that should auto-rollback

```bash
CONTROLLER=statistical CANARY_ERROR_RATE=0.3 node packages/controller/dist/demo.js
```

The canary is configured with a 30% error rate — a large, obvious regression
against the fixed 2% baseline. Watch the dashboard
(`http://127.0.0.1:4001`): the rollback should trigger quickly once enough
canary samples accumulate at whatever the current stage is, and the canary
percentage should snap back to 0%.

## Scenario 2 — a healthy canary that should roll all the way out

```bash
CONTROLLER=statistical CANARY_ERROR_RATE=0.02 node packages/controller/dist/demo.js
```

The canary matches the baseline's 2% error rate — no real regression. Watch
the dashboard progress through 5% → 25% → 50% → 100% and land on
`"completed"`. This exercises the 100%-stage edge case documented in
[`STATISTICS.md`](STATISTICS.md#bug-2-the-sprt-can-never-re-freeze-at-a-100-stage) —
if you see the rollout stall on `"hold"` forever at the final stage on a
version of this code before that fix, that bug is what you're looking at.

## Try the naive controller for comparison

Re-run either scenario with `CONTROLLER=naive` and compare behavior — in
particular, notice how much faster (and less reliably, per the
[validation results](VALIDATION.md#latest-results)) it resolves each stage,
since it doesn't need to wait for a large frozen baseline sample before it
starts judging.

## What the dashboard shows

Open `http://127.0.0.1:4001` in a browser while the demo runs. It polls
`GET /api/status` every 500ms and renders:

- Current rollout status (`not_started` / `running` / `rolled_back` / `completed`)
- Current stage index (out of the configured stage list) and live canary
  traffic percentage
- Per-version (baseline/canary) request count, error count, and error rate
- Rollback MTTR, once a rollback has occurred
- A scrolling timeline of every decision made, with timestamp, stage, canary
  percent, decision, and resulting status

`GET /api/status` itself returns the same data as raw JSON — useful for
scripting your own checks against a running demo instead of watching the
page.
