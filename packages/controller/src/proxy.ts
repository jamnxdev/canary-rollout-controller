import Fastify, { type FastifyInstance } from "fastify";
import { TrafficSplitter, type Version } from "./splitter.js";

export interface BackendTargets {
  baseline: string;
  canary: string;
}

export interface RequestOutcome {
  version: Version;
  latencyMs: number;
  success: boolean;
}

export type OutcomeListener = (outcome: RequestOutcome) => void;

/**
 * The traffic-splitter's HTTP entry point: every /work call is routed to
 * exactly one backend by the splitter, timed, and reported to onOutcome
 * before the response is relayed back to the caller. This is the single
 * place request-level outcomes are observed, so the metrics collector
 * (Day 2) and the dashboard both consume the same event stream.
 */
export function buildProxy(
  splitter: TrafficSplitter,
  targets: BackendTargets,
  onOutcome: OutcomeListener,
): FastifyInstance {
  const app = Fastify({ logger: false });

  app.get("/work", async (_request, reply) => {
    const version = splitter.route();
    const backendUrl = `${targets[version]}/work`;
    const start = performance.now();

    try {
      const response = await fetch(backendUrl);
      const latencyMs = performance.now() - start;
      const success = response.ok;
      onOutcome({ version, latencyMs, success });
      reply.code(response.status);
      return await response.json();
    } catch {
      const latencyMs = performance.now() - start;
      onOutcome({ version, latencyMs, success: false });
      reply.code(502);
      return { error: "backend unreachable", version };
    }
  });

  app.get("/status", async () => {
    return { canaryPercent: splitter.getCanaryPercent() };
  });

  return app;
}
