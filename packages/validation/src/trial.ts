import { buildServer, type TargetServiceConfig } from "@canary/target-service";
import {
  buildProxy,
  MetricsCollector,
  NaiveThresholdController,
  RolloutStateMachine,
  SequentialProbabilityRatioController,
  TrafficSplitter,
  runLoad,
  type DecisionEngine,
  type NaiveControllerConfig,
  type SprtConfig,
} from "@canary/controller";

export type ControllerType = "naive" | "statistical";
export type Scenario = "aa" | "ab";
export type TrialOutcome = "rolled_back" | "completed" | "timeout";

export interface TrialConfig {
  controllerType: ControllerType;
  scenario: Scenario;
  baselineConfig: Omit<TargetServiceConfig, "versionLabel">;
  canaryConfig: Omit<TargetServiceConfig, "versionLabel">;
  stagePercent: number;
  naiveConfig: NaiveControllerConfig;
  sprtConfig: SprtConfig;
  loadConcurrency: number;
  maxTrialMs: number;
  tickIntervalMs: number;
}

export interface TrialResult {
  controllerType: ControllerType;
  scenario: Scenario;
  outcome: TrialOutcome;
  detectionMs: number | undefined;
  baselineSamplesAtDecision: number;
  canarySamplesAtDecision: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Runs one full trial: two real target-service instances, a real proxy and
 * metrics collector, a real controller (naive or statistical) driving a
 * real single-stage RolloutStateMachine, under real concurrent HTTP load,
 * until it reaches a terminal decision or maxTrialMs elapses (a "timeout"
 * outcome — treated as a missed decision, not silently dropped from the
 * results, so a controller that's simply too slow to resolve shows up as
 * one in the raw data rather than vanishing).
 *
 * A single stage (not the full 4-stage rollout) is deliberate: this
 * measures the decision engine itself — how it resolves a fixed canary
 * percentage's worth of traffic — which is what the false-positive/
 * true-positive rate and detection-time metrics are actually about, per
 * the spec's own methodology. The multi-stage state machine (Day 4) is
 * exercised end-to-end separately; reusing it here at stages: [percent]
 * rather than writing a parallel one-off runner keeps this trial on the
 * same, already-tested code path as the real rollout.
 */
export async function runTrial(config: TrialConfig): Promise<TrialResult> {
  const baseline = buildServer({ versionLabel: "baseline", ...config.baselineConfig });
  const canary = buildServer({ versionLabel: "canary", ...config.canaryConfig });
  const baselineUrl = await baseline.listen({ port: 0, host: "127.0.0.1" });
  const canaryUrl = await canary.listen({ port: 0, host: "127.0.0.1" });

  const splitter = new TrafficSplitter();
  const metrics = new MetricsCollector();
  const proxy = buildProxy(splitter, { baseline: baselineUrl, canary: canaryUrl }, (o) =>
    metrics.record(o),
  );
  const proxyUrl = await proxy.listen({ port: 0, host: "127.0.0.1" });

  const naive = new NaiveThresholdController(config.naiveConfig);
  const statistical = new SequentialProbabilityRatioController(config.sprtConfig);
  const decide: DecisionEngine =
    config.controllerType === "naive"
      ? (_baseline, canaryStats) => naive.decide(canaryStats)
      : (baselineStats, canaryStats) => statistical.evaluate(baselineStats, canaryStats).decision;

  const machine = new RolloutStateMachine({
    stages: [config.stagePercent],
    splitter,
    metrics,
    decide,
  });

  const startedAt = performance.now();
  machine.start();

  let stopped = false;
  const loadDone = runLoad(proxyUrl, {
    durationMs: config.maxTrialMs,
    concurrency: config.loadConcurrency,
    shouldStop: () => stopped,
  });

  const deadline = Date.now() + config.maxTrialMs;
  let status = machine.getStatus();
  while (Date.now() < deadline) {
    status = machine.tick();
    if (status !== "running") break;
    await sleep(config.tickIntervalMs);
  }
  const detectionMs = performance.now() - startedAt;

  stopped = true;
  await loadDone;

  const baselineStatsAtEnd = metrics.stats("baseline");
  const canaryStatsAtEnd = metrics.stats("canary");

  await Promise.all([baseline.close(), canary.close(), proxy.close()]);

  const outcome: TrialOutcome = status === "running" ? "timeout" : status === "completed" ? "completed" : "rolled_back";

  return {
    controllerType: config.controllerType,
    scenario: config.scenario,
    outcome,
    detectionMs: outcome === "timeout" ? undefined : detectionMs,
    baselineSamplesAtDecision: baselineStatsAtEnd.count,
    canarySamplesAtDecision: canaryStatsAtEnd.count,
  };
}
