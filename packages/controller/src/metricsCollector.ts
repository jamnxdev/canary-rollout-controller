import type { RequestOutcome } from "./proxy.js";
import type { Version } from "./splitter.js";

export interface VersionStats {
  count: number;
  errors: number;
  errorRate: number;
  latenciesMs: number[];
}

/**
 * Accumulates request outcomes per version. A "window" is the set of samples
 * recorded since the last reset() — the decision engine (naive and
 * statistical alike) resets this at the start of each rollout stage, so
 * every stage's decision is made from that stage's own traffic, not
 * traffic carried over from an earlier canary percentage.
 */
export class MetricsCollector {
  private baselineSamples: RequestOutcome[] = [];
  private canarySamples: RequestOutcome[] = [];

  record(outcome: RequestOutcome): void {
    this.samplesFor(outcome.version).push(outcome);
  }

  reset(): void {
    this.baselineSamples = [];
    this.canarySamples = [];
  }

  stats(version: Version): VersionStats {
    const outcomes = this.samplesFor(version);
    const errors = outcomes.filter((o) => !o.success).length;
    return {
      count: outcomes.length,
      errors,
      errorRate: outcomes.length === 0 ? 0 : errors / outcomes.length,
      latenciesMs: outcomes.map((o) => o.latencyMs),
    };
  }

  private samplesFor(version: Version): RequestOutcome[] {
    return version === "baseline" ? this.baselineSamples : this.canarySamples;
  }
}
