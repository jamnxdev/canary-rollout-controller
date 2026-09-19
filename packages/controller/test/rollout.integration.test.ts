import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "@canary/target-service";
import { buildProxy } from "../src/proxy.js";
import { TrafficSplitter } from "../src/splitter.js";
import { MetricsCollector } from "../src/metricsCollector.js";
import { NaiveThresholdController } from "../src/naiveController.js";
import { RolloutStateMachine } from "../src/stateMachine.js";
import { runLoad } from "../src/loadgen.js";

/**
 * End-to-end wiring test: real target-service instances, a real proxy
 * routing real HTTP traffic, a real metrics collector fed from the proxy's
 * outcome callback, and a real naive controller driving a real state
 * machine — the whole Day 1-4 stack together, not mocked at any layer.
 */
describe("rollout state machine, wired end-to-end", () => {
  const instances: FastifyInstance[] = [];

  afterEach(async () => {
    await Promise.all(instances.map((app) => app.close()));
    instances.length = 0;
  });

  async function pollUntilTerminal(
    machine: RolloutStateMachine,
    timeoutMs: number,
  ): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const status = machine.tick();
      if (status !== "running") return status;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return machine.getStatus();
  }

  it("rolls back once a genuinely broken canary accumulates enough failing samples", async () => {
    const baseline = buildServer({
      versionLabel: "baseline",
      latencyMs: 0,
      latencyJitterMs: 0,
      errorRate: 0,
    });
    const canary = buildServer({
      versionLabel: "canary",
      latencyMs: 0,
      latencyJitterMs: 0,
      errorRate: 0.5,
    });
    instances.push(baseline, canary);
    const baselineUrl = await baseline.listen({ port: 0, host: "127.0.0.1" });
    const canaryUrl = await canary.listen({ port: 0, host: "127.0.0.1" });

    const splitter = new TrafficSplitter();
    const metrics = new MetricsCollector();
    const proxy = buildProxy(splitter, { baseline: baselineUrl, canary: canaryUrl }, (o) =>
      metrics.record(o),
    );
    instances.push(proxy);
    const proxyUrl = await proxy.listen({ port: 0, host: "127.0.0.1" });

    const naive = new NaiveThresholdController({ errorRateThreshold: 0.1, minSamples: 20 });
    const machine = new RolloutStateMachine({
      stages: [10, 50, 100],
      splitter,
      metrics,
      decide: (_baseline, canaryStats) => naive.decide(canaryStats),
    });
    machine.start();
    expect(splitter.getCanaryPercent()).toBe(10);

    const loadDone = runLoad(proxyUrl, { durationMs: 1500, concurrency: 8 });
    const finalStatus = await pollUntilTerminal(machine, 1500);
    await loadDone;

    expect(finalStatus).toBe("rolled_back");
    expect(splitter.getCanaryPercent()).toBe(0);
    expect(machine.getRollbackMttrMs()).toBeGreaterThanOrEqual(0);
  });

  it("completes all stages when both versions are healthy", async () => {
    const baseline = buildServer({
      versionLabel: "baseline",
      latencyMs: 0,
      latencyJitterMs: 0,
      errorRate: 0,
    });
    const canary = buildServer({
      versionLabel: "canary",
      latencyMs: 0,
      latencyJitterMs: 0,
      errorRate: 0,
    });
    instances.push(baseline, canary);
    const baselineUrl = await baseline.listen({ port: 0, host: "127.0.0.1" });
    const canaryUrl = await canary.listen({ port: 0, host: "127.0.0.1" });

    const splitter = new TrafficSplitter();
    const metrics = new MetricsCollector();
    const proxy = buildProxy(splitter, { baseline: baselineUrl, canary: canaryUrl }, (o) =>
      metrics.record(o),
    );
    instances.push(proxy);
    const proxyUrl = await proxy.listen({ port: 0, host: "127.0.0.1" });

    const naive = new NaiveThresholdController({ errorRateThreshold: 0.1, minSamples: 15 });
    const machine = new RolloutStateMachine({
      stages: [50, 100],
      splitter,
      metrics,
      decide: (_baseline, canaryStats) => naive.decide(canaryStats),
    });
    machine.start();

    const loadDone = runLoad(proxyUrl, { durationMs: 1500, concurrency: 8 });
    const finalStatus = await pollUntilTerminal(machine, 1500);
    await loadDone;

    expect(finalStatus).toBe("completed");
    expect(splitter.getCanaryPercent()).toBe(100);
  });
});
