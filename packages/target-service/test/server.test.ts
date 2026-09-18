import { describe, expect, it, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";

describe("target service", () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("reports its version label on /health", async () => {
    app = buildServer({
      versionLabel: "canary",
      latencyMs: 0,
      latencyJitterMs: 0,
      errorRate: 0,
    });

    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok", version: "canary" });
  });

  it("never errors when errorRate is 0", async () => {
    app = buildServer({
      versionLabel: "baseline",
      latencyMs: 0,
      latencyJitterMs: 0,
      errorRate: 0,
    });

    for (let i = 0; i < 50; i++) {
      const response = await app.inject({ method: "GET", url: "/work" });
      expect(response.statusCode).toBe(200);
    }
  });

  it("always errors when errorRate is 1", async () => {
    app = buildServer({
      versionLabel: "baseline",
      latencyMs: 0,
      latencyJitterMs: 0,
      errorRate: 1,
    });

    for (let i = 0; i < 20; i++) {
      const response = await app.inject({ method: "GET", url: "/work" });
      expect(response.statusCode).toBe(500);
    }
  });

  it("produces an empirical error rate close to the configured rate over many trials", async () => {
    app = buildServer({
      versionLabel: "baseline",
      latencyMs: 0,
      latencyJitterMs: 0,
      errorRate: 0.2,
    });

    const trials = 500;
    let errors = 0;
    for (let i = 0; i < trials; i++) {
      const response = await app.inject({ method: "GET", url: "/work" });
      if (response.statusCode === 500) errors++;
    }

    const empiricalRate = errors / trials;
    // 500 Bernoulli(0.2) trials: std dev ~= sqrt(0.2*0.8/500) ~= 0.018 -> 5 std devs ~= 0.09
    expect(empiricalRate).toBeGreaterThan(0.11);
    expect(empiricalRate).toBeLessThan(0.29);
  });
});
