import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildDashboardApp, type DashboardSnapshot } from "../src/dashboard.js";

async function listenEphemeral(app: FastifyInstance): Promise<string> {
  return app.listen({ port: 0, host: "127.0.0.1" });
}

const sampleSnapshot: DashboardSnapshot = {
  status: "running",
  stageIndex: 1,
  stages: [5, 25, 50, 100],
  canaryPercent: 25,
  baseline: { count: 100, errors: 2, errorRate: 0.02, latenciesMs: [] },
  canary: { count: 40, errors: 1, errorRate: 0.025, latenciesMs: [] },
  history: [{ timestamp: 1700000000000, stageIndex: 1, canaryPercent: 25, decision: "hold", status: "running" }],
  rollbackMttrMs: undefined,
};

describe("dashboard", () => {
  const instances: FastifyInstance[] = [];

  afterEach(async () => {
    await Promise.all(instances.map((app) => app.close()));
    instances.length = 0;
  });

  it("serves the current snapshot as JSON on /api/status", async () => {
    const app = buildDashboardApp(() => sampleSnapshot);
    instances.push(app);
    const url = await listenEphemeral(app);

    const response = await fetch(`${url}/api/status`);
    expect(await response.json()).toEqual(sampleSnapshot);
  });

  it("re-invokes the snapshot provider on every request, not just once", async () => {
    let stageIndex = 0;
    const app = buildDashboardApp(() => ({ ...sampleSnapshot, stageIndex }));
    instances.push(app);
    const url = await listenEphemeral(app);

    expect((await (await fetch(`${url}/api/status`)).json()).stageIndex).toBe(0);
    stageIndex = 2;
    expect((await (await fetch(`${url}/api/status`)).json()).stageIndex).toBe(2);
  });

  it("serves an HTML dashboard page on /", async () => {
    const app = buildDashboardApp(() => sampleSnapshot);
    instances.push(app);
    const url = await listenEphemeral(app);

    const response = await fetch(`${url}/`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    const body = await response.text();
    expect(body).toContain("<html");
    expect(body).toContain("/api/status");
  });
});
