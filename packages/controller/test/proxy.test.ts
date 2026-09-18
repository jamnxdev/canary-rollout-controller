import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "@canary/target-service";
import { buildProxy, type RequestOutcome } from "../src/proxy.js";
import { TrafficSplitter } from "../src/splitter.js";

async function listenEphemeral(app: FastifyInstance): Promise<string> {
  const address = await app.listen({ port: 0, host: "127.0.0.1" });
  return address;
}

describe("proxy", () => {
  const instances: FastifyInstance[] = [];

  afterEach(async () => {
    await Promise.all(instances.map((app) => app.close()));
    instances.length = 0;
  });

  it("forwards to the version chosen by the splitter and reports its outcome", async () => {
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
      errorRate: 1,
    });
    instances.push(baseline, canary);

    const baselineUrl = await listenEphemeral(baseline);
    const canaryUrl = await listenEphemeral(canary);

    const splitter = new TrafficSplitter(50);
    const outcomes: RequestOutcome[] = [];
    const proxy = buildProxy(splitter, { baseline: baselineUrl, canary: canaryUrl }, (o) =>
      outcomes.push(o),
    );
    instances.push(proxy);
    const proxyUrl = await listenEphemeral(proxy);

    const trials = 100;
    for (let i = 0; i < trials; i++) {
      await fetch(`${proxyUrl}/work`);
    }

    expect(outcomes).toHaveLength(trials);

    const baselineOutcomes = outcomes.filter((o) => o.version === "baseline");
    const canaryOutcomes = outcomes.filter((o) => o.version === "canary");

    // every baseline-routed request succeeded (errorRate 0), every canary-routed request failed (errorRate 1)
    expect(baselineOutcomes.every((o) => o.success)).toBe(true);
    expect(canaryOutcomes.every((o) => !o.success)).toBe(true);

    // roughly a 50/50 split over 100 trials
    expect(baselineOutcomes.length).toBeGreaterThan(25);
    expect(canaryOutcomes.length).toBeGreaterThan(25);
  });

  it("reports 502 and a failed outcome when a backend is unreachable", async () => {
    const canary = buildServer({
      versionLabel: "canary",
      latencyMs: 0,
      latencyJitterMs: 0,
      errorRate: 0,
    });
    instances.push(canary);
    const canaryUrl = await listenEphemeral(canary);

    // nothing listens on this port
    const deadBaselineUrl = "http://127.0.0.1:1";

    const splitter = new TrafficSplitter(0); // force baseline, which is unreachable
    const outcomes: RequestOutcome[] = [];
    const proxy = buildProxy(splitter, { baseline: deadBaselineUrl, canary: canaryUrl }, (o) =>
      outcomes.push(o),
    );
    instances.push(proxy);
    const proxyUrl = await listenEphemeral(proxy);

    const response = await fetch(`${proxyUrl}/work`);
    expect(response.status).toBe(502);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.success).toBe(false);
    expect(outcomes[0]?.version).toBe("baseline");
  });

  it("exposes the current canary percent on /status", async () => {
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
    const baselineUrl = await listenEphemeral(baseline);
    const canaryUrl = await listenEphemeral(canary);

    const splitter = new TrafficSplitter(37);
    const proxy = buildProxy(splitter, { baseline: baselineUrl, canary: canaryUrl }, () => {});
    instances.push(proxy);
    const proxyUrl = await listenEphemeral(proxy);

    const response = await fetch(`${proxyUrl}/status`);
    expect(await response.json()).toEqual({ canaryPercent: 37 });
  });
});
