import Fastify, { type FastifyInstance } from "fastify";

export interface TargetServiceConfig {
  /** Label reported in responses and health checks — "baseline" or "canary" in the demo, but not constrained to those two values. */
  versionLabel: string;
  /** Base simulated handling latency, in milliseconds. */
  latencyMs: number;
  /** Latency is uniformly jittered by +/- this many milliseconds around latencyMs. */
  latencyJitterMs: number;
  /** Fraction of /work requests that return a 500, in [0, 1]. */
  errorRate: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function buildServer(config: TargetServiceConfig): FastifyInstance {
  const app = Fastify({ logger: false });

  app.get("/health", async () => {
    return { status: "ok", version: config.versionLabel };
  });

  app.get("/work", async (_request, reply) => {
    const jitter = (Math.random() * 2 - 1) * config.latencyJitterMs;
    const latency = Math.max(0, config.latencyMs + jitter);
    await sleep(latency);

    if (Math.random() < config.errorRate) {
      reply.code(500);
      return { version: config.versionLabel, ok: false };
    }

    return { version: config.versionLabel, ok: true };
  });

  return app;
}
