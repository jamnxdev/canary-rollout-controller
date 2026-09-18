import { buildServer, type TargetServiceConfig } from "./server.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined) {
    throw new Error(`missing required env var ${name}`);
  }
  return value;
}

const config: TargetServiceConfig = {
  versionLabel: requireEnv("VERSION_LABEL"),
  latencyMs: Number(process.env.LATENCY_MS ?? "10"),
  latencyJitterMs: Number(process.env.LATENCY_JITTER_MS ?? "5"),
  errorRate: Number(process.env.ERROR_RATE ?? "0"),
};

const port = Number(process.env.PORT ?? "0");
const app = buildServer(config);

app.listen({ port, host: "127.0.0.1" }, (err, address) => {
  if (err) {
    console.error(err);
    process.exit(1);
  }
  console.log(`[${config.versionLabel}] listening on ${address}`);
});
