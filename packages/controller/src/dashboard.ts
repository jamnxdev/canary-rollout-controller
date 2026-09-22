import Fastify, { type FastifyInstance } from "fastify";
import type { VersionStats } from "./metricsCollector.js";
import type { RolloutEvent, RolloutStatus } from "./stateMachine.js";

export interface DashboardSnapshot {
  status: RolloutStatus;
  stageIndex: number;
  stages: number[];
  canaryPercent: number;
  baseline: VersionStats;
  canary: VersionStats;
  history: readonly RolloutEvent[];
  rollbackMttrMs?: number;
}

export type SnapshotProvider = () => DashboardSnapshot;

/**
 * The dashboard doubles as this project's observability layer (per the
 * spec) rather than a separate metrics stack — it only ever reads a single
 * caller-supplied snapshot, so it has no coupling to which controller,
 * target-service instances, or process topology produced that snapshot.
 * Whoever wires up a live rollout (see demo.ts) owns building the snapshot;
 * this module only renders it.
 */
export function buildDashboardApp(getSnapshot: SnapshotProvider): FastifyInstance {
  const app = Fastify({ logger: false });

  app.get("/api/status", async () => getSnapshot());

  app.get("/", async (_request, reply) => {
    reply.type("text/html").send(DASHBOARD_HTML);
  });

  return app;
}

const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Canary Rollout Controller</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, sans-serif; max-width: 900px; margin: 2rem auto; padding: 0 1rem; }
  h1 { font-size: 1.25rem; }
  .status { display: inline-block; padding: 0.15rem 0.6rem; border-radius: 0.4rem; font-weight: 600; }
  .status-running { background: #fef3c7; color: #92400e; }
  .status-completed { background: #d1fae5; color: #065f46; }
  .status-rolled_back { background: #fee2e2; color: #991b1b; }
  .status-not_started { background: #e5e7eb; color: #374151; }
  .bar { height: 1.5rem; background: #e5e7eb; border-radius: 0.4rem; overflow: hidden; margin: 0.5rem 0 1rem; }
  .bar-fill { height: 100%; background: #3b82f6; transition: width 0.3s ease; }
  table { border-collapse: collapse; width: 100%; margin-bottom: 1.5rem; }
  th, td { text-align: left; padding: 0.3rem 0.6rem; border-bottom: 1px solid #e5e7eb; }
  ul#history { max-height: 220px; overflow-y: auto; font-family: ui-monospace, monospace; font-size: 0.85rem; padding-left: 1rem; }
</style>
</head>
<body>
  <h1>Canary Rollout Controller — Live Status</h1>
  <p>Status: <span id="status" class="status">loading…</span> &nbsp; Stage: <span id="stage">-</span> &nbsp; Canary traffic: <span id="pct">-</span>%</p>
  <div class="bar"><div class="bar-fill" id="bar-fill" style="width:0%"></div></div>

  <table>
    <thead><tr><th></th><th>Count</th><th>Errors</th><th>Error rate</th></tr></thead>
    <tbody>
      <tr><td>Baseline</td><td id="b-count">-</td><td id="b-errors">-</td><td id="b-rate">-</td></tr>
      <tr><td>Canary</td><td id="c-count">-</td><td id="c-errors">-</td><td id="c-rate">-</td></tr>
    </tbody>
  </table>

  <p id="mttr"></p>

  <h2>Rollout timeline</h2>
  <ul id="history"></ul>

<script>
async function refresh() {
  try {
    const res = await fetch("/api/status");
    const s = await res.json();

    const statusEl = document.getElementById("status");
    statusEl.textContent = s.status;
    statusEl.className = "status status-" + s.status;

    document.getElementById("stage").textContent = (s.stageIndex + 1) + " / " + s.stages.length;
    document.getElementById("pct").textContent = s.canaryPercent;
    document.getElementById("bar-fill").style.width = s.canaryPercent + "%";

    document.getElementById("b-count").textContent = s.baseline.count;
    document.getElementById("b-errors").textContent = s.baseline.errors;
    document.getElementById("b-rate").textContent = (s.baseline.errorRate * 100).toFixed(1) + "%";

    document.getElementById("c-count").textContent = s.canary.count;
    document.getElementById("c-errors").textContent = s.canary.errors;
    document.getElementById("c-rate").textContent = (s.canary.errorRate * 100).toFixed(1) + "%";

    document.getElementById("mttr").textContent = s.rollbackMttrMs !== undefined
      ? "Rollback MTTR: " + s.rollbackMttrMs.toFixed(2) + "ms"
      : "";

    const historyEl = document.getElementById("history");
    historyEl.innerHTML = "";
    for (const event of s.history.slice().reverse()) {
      const li = document.createElement("li");
      const time = new Date(event.timestamp).toLocaleTimeString();
      li.textContent = time + " — stage " + (event.stageIndex + 1) + ", " + event.canaryPercent + "% canary, decision=" + event.decision + ", status=" + event.status;
      historyEl.appendChild(li);
    }
  } catch (err) {
    document.getElementById("status").textContent = "unreachable";
  }
}
refresh();
setInterval(refresh, 500);
</script>
</body>
</html>
`;
