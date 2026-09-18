import type { VersionStats } from "./metricsCollector.js";
import type { Decision } from "./naiveController.js";

export interface SprtConfig {
  /** Target Type I error rate (false-positive rollback rate), e.g. 0.05. */
  alpha: number;
  /** Target Type II error rate (false-negative / missed-regression rate), e.g. 0.1. */
  beta: number;
  /**
   * Absolute error-rate increase over baseline this test is tuned to detect,
   * e.g. 0.03 for "a 3 percentage point regression." This is the alternative
   * hypothesis's effect size — the SPRT has no power guarantee for a
   * regression smaller than this.
   */
  minimumDetectableEffect: number;
  /** Minimum baseline samples required before p0 is trusted enough to test against. */
  minBaselineSamples: number;
}

export interface SprtResult {
  decision: Decision;
  logLikelihoodRatio: number;
  upperBoundary: number;
  lowerBoundary: number;
  p0: number;
  p1: number;
}

const EPSILON = 1e-6;

function clampProbability(p: number): number {
  return Math.min(1 - EPSILON, Math.max(EPSILON, p));
}

/**
 * Wald's Sequential Probability Ratio Test, applied to the canary's error
 * indicator stream, testing H0: canary error rate == p0 (baseline's
 * currently observed rate) against H1: canary error rate == p1 = p0 + MDE.
 *
 * This is the direct answer to the "peeking problem": a fixed-sample
 * z-test's false-positive rate inflates the more often you re-check it
 * before it reaches its planned sample size (that's the whole mechanism of
 * p-hacking-by-peeking). SPRT is designed from first principles to be
 * checked after every single new observation — its Type I/II error rates
 * (alpha, beta) hold under continuous monitoring by construction, via the
 * fixed log-likelihood-ratio boundaries below, not by re-deriving a
 * corrected threshold per look the way group-sequential alpha-spending
 * would require.
 *
 * Documented approximation: a textbook SPRT assumes p0 is a known, fixed
 * null hypothesis. Here p0 is instead *estimated* from the baseline's own
 * concurrent traffic in the same stage, since there is no other honest
 * source for "what the error rate would be without the canary change" —
 * the alternative (a hardcoded p0) would silently break the moment the
 * service's real baseline error rate drifts from whatever was hardcoded.
 * The tradeoff is real and worth stating plainly: if the baseline sample is
 * small or unusually noisy, p0 itself is a noisy estimate, which is why
 * minBaselineSamples exists as a floor before the test runs at all.
 */
export class SequentialProbabilityRatioController {
  constructor(private readonly config: SprtConfig) {}

  evaluate(baseline: VersionStats, canary: VersionStats): SprtResult {
    if (baseline.count < this.config.minBaselineSamples || canary.count === 0) {
      return {
        decision: "hold",
        logLikelihoodRatio: 0,
        upperBoundary: this.upperBoundary(),
        lowerBoundary: this.lowerBoundary(),
        p0: NaN,
        p1: NaN,
      };
    }

    const p0 = clampProbability(baseline.errorRate);
    const p1 = clampProbability(p0 + this.config.minimumDetectableEffect);

    const n = canary.count;
    const k = canary.errors;
    const llr = k * Math.log(p1 / p0) + (n - k) * Math.log((1 - p1) / (1 - p0));

    const upperBoundary = this.upperBoundary();
    const lowerBoundary = this.lowerBoundary();

    let decision: Decision;
    if (llr >= upperBoundary) {
      decision = "rollback";
    } else if (llr <= lowerBoundary) {
      decision = "proceed";
    } else {
      decision = "hold";
    }

    return { decision, logLikelihoodRatio: llr, upperBoundary, lowerBoundary, p0, p1 };
  }

  /** Reject H0 (regression detected) once the LLR crosses log((1-beta)/alpha). */
  private upperBoundary(): number {
    return Math.log((1 - this.config.beta) / this.config.alpha);
  }

  /** Accept H0 (no regression) once the LLR crosses log(beta/(1-alpha)). */
  private lowerBoundary(): number {
    return Math.log(this.config.beta / (1 - this.config.alpha));
  }
}
