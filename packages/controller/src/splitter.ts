export type Version = "baseline" | "canary";

function clampPercent(pct: number): number {
  if (pct < 0) return 0;
  if (pct > 100) return 100;
  return pct;
}

/**
 * Decides, per request, whether traffic goes to the canary or the baseline.
 * Mutable canary percentage so the rollout state machine can advance/rollback
 * without recreating the splitter (and therefore without dropping in-flight
 * routing state).
 */
export class TrafficSplitter {
  private canaryPercent: number;

  constructor(initialCanaryPercent = 0) {
    this.canaryPercent = clampPercent(initialCanaryPercent);
  }

  setCanaryPercent(pct: number): void {
    this.canaryPercent = clampPercent(pct);
  }

  getCanaryPercent(): number {
    return this.canaryPercent;
  }

  route(): Version {
    return Math.random() * 100 < this.canaryPercent ? "canary" : "baseline";
  }
}
