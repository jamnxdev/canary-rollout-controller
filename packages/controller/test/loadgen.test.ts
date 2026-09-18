import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "@canary/target-service";
import { buildProxy } from "../src/proxy.js";
import { TrafficSplitter } from "../src/splitter.js";
import { runLoad } from "../src/loadgen.js";

describe("runLoad", () => {
  const instances: FastifyInstance[] = [];

  afterEach(async () => {
    await Promise.all(instances.map((app) => app.close()));
    instances.length = 0;
  });

  it("sends concurrent requests through the proxy for roughly the requested duration", async () => {
    const baseline = buildServer({
      versionLabel: "baseline",
      latencyMs: 1,
      latencyJitterMs: 0,
      errorRate: 0,
    });
    const canary = buildServer({
      versionLabel: "canary",
      latencyMs: 1,
      latencyJitterMs: 0,
      errorRate: 0,
    });
    instances.push(baseline, canary);
    const baselineUrl = await baseline.listen({ port: 0, host: "127.0.0.1" });
    const canaryUrl = await canary.listen({ port: 0, host: "127.0.0.1" });

    const splitter = new TrafficSplitter(0);
    const proxy = buildProxy(splitter, { baseline: baselineUrl, canary: canaryUrl }, () => {});
    instances.push(proxy);
    const proxyUrl = await proxy.listen({ port: 0, host: "127.0.0.1" });

    const result = await runLoad(proxyUrl, { durationMs: 200, concurrency: 4 });

    expect(result.sent).toBeGreaterThan(0);
    expect(result.errors).toBe(0);
  });
});
