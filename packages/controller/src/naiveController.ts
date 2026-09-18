import type { VersionStats } from "./metricsCollector.js";

export type Decision = "proceed" | "hold" | "rollback";

export interface NaiveControllerConfig {
  /** Absolute canary error-rate threshold, e.g. 0.05 for 5%. */
  errorRateThreshold: number;
  /** Minimum canary samples required before making any decision other than "hold". */
  minSamples: number;
}

/**
 * The anti-pattern the spec explicitly calls out: "if canary error rate >
 * X%, rollback." No comparison to the baseline's own error rate (so a noisy
 * baseline can't be distinguished from a genuinely regressed canary), and
 * no accounting for sample size beyond a blunt minimum (so it has no real
 * concept of statistical power). Built deliberately, as the thing Day 5's
 * validation has to demonstrate the statistical controller improves on —
 * not a strawman, but a reasonably-written version of what teams actually
 * ship when they reach for "just add a threshold."
 */
export class NaiveThresholdController {
  constructor(private readonly config: NaiveControllerConfig) {}

  decide(canary: VersionStats): Decision {
    if (canary.count < this.config.minSamples) return "hold";
    if (canary.errorRate > this.config.errorRateThreshold) return "rollback";
    return "proceed";
  }
}
