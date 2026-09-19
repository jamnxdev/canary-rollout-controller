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
 *
 * **p0/p1 are frozen the first time the baseline crosses minBaselineSamples,
 * not re-estimated on every call.** This was not the original design — see
 * the Day 5 implementation log for how the A/A validation run surfaced it:
 * re-estimating p0 fresh on every evaluate() call means every tick is
 * technically a *different* hypothesis test (a slightly different null each
 * time), which breaks the fixed-hypothesis assumption the Wald boundaries
 * rely on, and in practice inflated the empirical false-positive rate well
 * above the target alpha. Freezing p0/p1 once, from the first baseline
 * sample that clears the floor, restores a single well-defined null/
 * alternative pair for the whole test — the textbook SPRT setup. Call
 * reset() when starting a new stage (a fresh controller instance per stage
 * works too) so the next stage's p0 is estimated from *that* stage's own
 * baseline traffic, not carried over from the previous one.
 */
export class SequentialProbabilityRatioController {
  private frozenP0: number | undefined;
  private frozenP1: number | undefined;

  constructor(private readonly config: SprtConfig) {}

  evaluate(baseline: VersionStats, canary: VersionStats): SprtResult {
    if (this.frozenP0 === undefined) {
      if (baseline.count < this.config.minBaselineSamples) {
        return this.holdResult(NaN, NaN);
      }
      this.frozenP0 = clampProbability(baseline.errorRate);
      this.frozenP1 = clampProbability(this.frozenP0 + this.config.minimumDetectableEffect);
    }
    const p0 = this.frozenP0;
    const p1 = this.frozenP1 as number;

    if (canary.count === 0) {
      return this.holdResult(p0, p1);
    }

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

  /** Clears the frozen p0/p1 so the next evaluate() re-estimates from scratch — call at each new stage. */
  reset(): void {
    this.frozenP0 = undefined;
    this.frozenP1 = undefined;
  }

  private holdResult(p0: number, p1: number): SprtResult {
    return {
      decision: "hold",
      logLikelihoodRatio: 0,
      upperBoundary: this.upperBoundary(),
      lowerBoundary: this.lowerBoundary(),
      p0,
      p1,
    };
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
