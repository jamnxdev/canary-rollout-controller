import { buildServer, type TargetServiceConfig } from "@canary/target-service";
import { buildDashboardApp, type DashboardSnapshot } from "./dashboard.js";
import { MetricsCollector } from "./metricsCollector.js";
import { NaiveThresholdController } from "./naiveController.js";
import { runLoad } from "./loadgen.js";
import { buildProxy } from "./proxy.js";
import { TrafficSplitter } from "./splitter.js";
import { RolloutStateMachine, type DecisionEngine } from "./stateMachine.js";
import { SequentialProbabilityRatioController } from "./statisticalController.js";

/**
 * Standalone, single-process demo of the full Day 1-6 stack, driven purely
 * by environment variables so the "trigger a bad deploy and watch it
 * auto-rollback" demo scenario and the "repeat with a healthy canary" one
 * are the same script with different config, not two different code paths.
 *
 * Binds to 127.0.0.1 only — this is a local/manual-demo entry point, not
 * the VPS-hosted public deployment (deferred, see the implementation log).
 */

function requireControllerKind(): "naive" | "statistical" {
  const kind = process.env.CONTROLLER ?? "statistical";
  if (kind !== "naive" && kind !== "statistical") {
    throw new Error(`CONTROLLER must be "naive" or "statistical", got "${kind}"`);
  }
  return kind;
}

async function startTarget(config: TargetServiceConfig, port: number) {
  const app = buildServer(config);
  await app.listen({ port, host: "127.0.0.1" });
  return app;
}

async function main() {
  const canaryErrorRate = Number(process.env.CANARY_ERROR_RATE ?? "0");
  const canaryLatencyMs = Number(process.env.CANARY_LATENCY_MS ?? "10");
  const controllerKind = requireControllerKind();
  const proxyPort = Number(process.env.PROXY_PORT ?? "4000");
  const dashboardPort = Number(process.env.DASHBOARD_PORT ?? "4001");

  const baselineApp = await startTarget(
    { versionLabel: "baseline", latencyMs: 10, latencyJitterMs: 5, errorRate: 0.02 },
    0,
  );
  const canaryApp = await startTarget(
    { versionLabel: "canary", latencyMs: canaryLatencyMs, latencyJitterMs: 5, errorRate: canaryErrorRate },
    0,
  );

  const baselineAddress = baselineApp.server.address();
  const canaryAddress = canaryApp.server.address();
  if (typeof baselineAddress !== "object" || baselineAddress === null) throw new Error("baseline failed to bind");
  if (typeof canaryAddress !== "object" || canaryAddress === null) throw new Error("canary failed to bind");

  const splitter = new TrafficSplitter(0);
  const metrics = new MetricsCollector();
  const proxy = buildProxy(
    splitter,
    { baseline: `http://127.0.0.1:${baselineAddress.port}`, canary: `http://127.0.0.1:${canaryAddress.port}` },
    (outcome) => metrics.record(outcome),
  );
  await proxy.listen({ port: proxyPort, host: "127.0.0.1" });

  const naive = new NaiveThresholdController({ errorRateThreshold: 0.1, minSamples: 30 });
  const statistical = new SequentialProbabilityRatioController({
    alpha: 0.05,
    beta: 0.1,
    minimumDetectableEffect: 0.05,
    minBaselineSamples: 200,
  });
  const decide: DecisionEngine =
    controllerKind === "naive"
      ? (_baseline, canary) => naive.decide(canary)
      : (baseline, canary) => statistical.evaluate(baseline, canary).decision;

  const stateMachine = new RolloutStateMachine({
    stages: [5, 25, 50, 100],
    splitter,
    metrics,
    decide,
    // At the 100% stage the splitter sends nothing to baseline, so a fresh
    // p0 estimate can never form there — keep the last stage's frozen p0/p1
    // instead of resetting into a permanent "hold". See the Day 6 log.
    onStageAdvance: (newCanaryPercent) => {
      if (newCanaryPercent < 100) statistical.reset();
    },
  });

  const dashboard = buildDashboardApp(
    (): DashboardSnapshot => ({
      status: stateMachine.getStatus(),
      stageIndex: Math.max(stateMachine.getStageIndex(), 0),
      stages: [5, 25, 50, 100],
      canaryPercent: splitter.getCanaryPercent(),
      baseline: metrics.stats("baseline"),
      canary: metrics.stats("canary"),
      history: stateMachine.getHistory(),
      rollbackMttrMs: stateMachine.getRollbackMttrMs(),
    }),
  );
  await dashboard.listen({ port: dashboardPort, host: "127.0.0.1" });

  console.log(`[demo] controller=${controllerKind} canaryErrorRate=${canaryErrorRate} canaryLatencyMs=${canaryLatencyMs}`);
  console.log(`[demo] proxy:     http://127.0.0.1:${proxyPort}`);
  console.log(`[demo] dashboard: http://127.0.0.1:${dashboardPort}`);

  stateMachine.start();
  const tickInterval = setInterval(() => {
    if (stateMachine.getStatus() !== "running") {
      clearInterval(tickInterval);
      console.log(`[demo] rollout finished: ${stateMachine.getStatus()}`);
      return;
    }
    stateMachine.tick();
  }, 20);

  await runLoad(`http://127.0.0.1:${proxyPort}`, {
    durationMs: Number(process.env.DEMO_DURATION_MS ?? "60000"),
    concurrency: Number(process.env.DEMO_CONCURRENCY ?? "20"),
    shouldStop: () => stateMachine.getStatus() !== "running",
  });

  clearInterval(tickInterval);
  console.log(`[demo] load generator stopped, final status: ${stateMachine.getStatus()}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
