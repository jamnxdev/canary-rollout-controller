import type { MetricsCollector, VersionStats } from "./metricsCollector.js";
import type { Decision } from "./naiveController.js";
import type { TrafficSplitter } from "./splitter.js";

/**
 * Abstracts over both controllers (naive and statistical) behind one shape,
 * so the state machine — and Day 5's naive-vs-statistical comparison
 * harness — can drive either without knowing which one it's holding.
 */
export type DecisionEngine = (baseline: VersionStats, canary: VersionStats) => Decision;

export type RolloutStatus = "not_started" | "running" | "rolled_back" | "completed";

export interface RolloutEvent {
  timestamp: number;
  stageIndex: number;
  canaryPercent: number;
  decision: Decision;
  status: RolloutStatus;
}

export interface RolloutStateMachineConfig {
  /** Canary traffic percentages in ascending order, e.g. [5, 25, 50, 100]. */
  stages: number[];
  splitter: TrafficSplitter;
  metrics: MetricsCollector;
  decide: DecisionEngine;
}

/**
 * Drives a staged canary rollout: at each stage, accumulates traffic against
 * the decision engine until it returns "proceed" (advance, resetting metrics
 * so the next stage's decision is made from its own traffic) or "rollback"
 * (fail-safe default action: traffic to 0% canary, immediately, no further
 * stages attempted). "hold" is a no-op tick — there isn't yet enough
 * evidence either way.
 *
 * Rollback is the default *safe* action on an ambiguous or regressed
 * signal (fail-safe, not fail-open) — ambiguity never advances the rollout,
 * only an explicit "proceed" verdict does.
 */
export class RolloutStateMachine {
  private stageIndex = -1;
  private status: RolloutStatus = "not_started";
  private readonly history: RolloutEvent[] = [];
  private rollbackDecidedAt: number | undefined;
  private rollbackCompletedAt: number | undefined;

  constructor(private readonly config: RolloutStateMachineConfig) {
    if (config.stages.length === 0) {
      throw new Error("RolloutStateMachine requires at least one stage");
    }
  }

  /**
   * Begins the rollout at the first configured stage. Before this is
   * called, the splitter is left at whatever percent it was constructed
   * with — by convention 0% (see TrafficSplitter's default) — which is the
   * fail-safe state: nothing routes to the canary until a rollout is
   * explicitly started.
   */
  start(): void {
    if (this.status !== "not_started") {
      throw new Error(`cannot start a rollout already in status "${this.status}"`);
    }
    this.stageIndex = 0;
    this.status = "running";
    this.config.metrics.reset();
    this.config.splitter.setCanaryPercent(this.config.stages[0] as number);
    this.recordEvent("hold");
  }

  /**
   * Evaluates the current stage's accumulated metrics against the decision
   * engine and acts on the verdict. A no-op (returns the current status
   * immediately) once the rollout has reached a terminal status
   * ("rolled_back" or "completed").
   */
  tick(): RolloutStatus {
    if (this.status !== "running") {
      return this.status;
    }

    const baseline = this.config.metrics.stats("baseline");
    const canary = this.config.metrics.stats("canary");
    const decision = this.config.decide(baseline, canary);

    if (decision === "rollback") {
      this.rollbackDecidedAt = performance.now();
      this.config.splitter.setCanaryPercent(0);
      this.rollbackCompletedAt = performance.now();
      this.status = "rolled_back";
    } else if (decision === "proceed") {
      if (this.stageIndex === this.config.stages.length - 1) {
        this.status = "completed";
      } else {
        this.stageIndex += 1;
        this.config.metrics.reset();
        this.config.splitter.setCanaryPercent(this.config.stages[this.stageIndex] as number);
      }
    }
    // "hold": stay at the current stage, keep accumulating.

    this.recordEvent(decision);
    return this.status;
  }

  getStatus(): RolloutStatus {
    return this.status;
  }

  getStageIndex(): number {
    return this.stageIndex;
  }

  getHistory(): readonly RolloutEvent[] {
    return this.history;
  }

  /**
   * Time from the rollback decision to the splitter reporting 0% canary.
   * In this single-process, in-memory design this is a synchronous
   * function call — sub-millisecond by construction — which is an honest
   * result, not a placeholder: it reflects that there is no network hop or
   * external system to propagate the change through, unlike a real service
   * mesh's traffic-splitting config reload.
   */
  getRollbackMttrMs(): number | undefined {
    if (this.rollbackDecidedAt === undefined || this.rollbackCompletedAt === undefined) {
      return undefined;
    }
    return this.rollbackCompletedAt - this.rollbackDecidedAt;
  }

  private recordEvent(decision: Decision): void {
    this.history.push({
      timestamp: Date.now(),
      stageIndex: this.stageIndex,
      canaryPercent: this.config.splitter.getCanaryPercent(),
      decision,
      status: this.status,
    });
  }
}
