import { describe, expect, it, vi } from "vitest";
import { RolloutStateMachine, type DecisionEngine } from "../src/stateMachine.js";
import { MetricsCollector } from "../src/metricsCollector.js";
import { TrafficSplitter } from "../src/splitter.js";
import type { Decision } from "../src/naiveController.js";

function scriptedDecider(script: Decision[]): DecisionEngine {
  const queue = [...script];
  return () => (queue.length > 1 ? (queue.shift() as Decision) : (queue[0] as Decision));
}

describe("RolloutStateMachine", () => {
  it("leaves the splitter at its constructed percent (0 by default) until start() is called", () => {
    const splitter = new TrafficSplitter();
    new RolloutStateMachine({
      stages: [5, 25, 50, 100],
      splitter,
      metrics: new MetricsCollector(),
      decide: scriptedDecider(["hold"]),
    });
    expect(splitter.getCanaryPercent()).toBe(0);
  });

  it("start() moves to the first stage and sets the splitter accordingly", () => {
    const splitter = new TrafficSplitter();
    const machine = new RolloutStateMachine({
      stages: [5, 25, 50, 100],
      splitter,
      metrics: new MetricsCollector(),
      decide: scriptedDecider(["hold"]),
    });
    machine.start();
    expect(machine.getStatus()).toBe("running");
    expect(machine.getStageIndex()).toBe(0);
    expect(splitter.getCanaryPercent()).toBe(5);
  });

  it("rejects starting a rollout that has already been started", () => {
    const machine = new RolloutStateMachine({
      stages: [5],
      splitter: new TrafficSplitter(),
      metrics: new MetricsCollector(),
      decide: scriptedDecider(["hold"]),
    });
    machine.start();
    expect(() => machine.start()).toThrow();
  });

  it("tick() is a no-op before start()", () => {
    const machine = new RolloutStateMachine({
      stages: [5],
      splitter: new TrafficSplitter(),
      metrics: new MetricsCollector(),
      decide: scriptedDecider(["proceed"]),
    });
    expect(machine.tick()).toBe("not_started");
  });

  it("advances through every stage on repeated 'proceed' verdicts, resetting metrics each time, then completes", () => {
    const splitter = new TrafficSplitter();
    const metrics = new MetricsCollector();
    const resetSpy = vi.spyOn(metrics, "reset");
    const stages = [5, 25, 50, 100];
    const machine = new RolloutStateMachine({
      stages,
      splitter,
      metrics,
      decide: scriptedDecider(["proceed"]),
    });

    machine.start(); // consumes the initial reset() call
    expect(resetSpy).toHaveBeenCalledTimes(1);

    machine.tick(); // proceed: stage 0 -> 1
    expect(machine.getStageIndex()).toBe(1);
    expect(splitter.getCanaryPercent()).toBe(25);
    expect(resetSpy).toHaveBeenCalledTimes(2);

    machine.tick(); // -> 2
    machine.tick(); // -> 3 (last stage index)
    expect(machine.getStageIndex()).toBe(3);
    expect(splitter.getCanaryPercent()).toBe(100);
    expect(machine.getStatus()).toBe("running");

    machine.tick(); // proceed at the last stage -> completed, no further reset
    expect(machine.getStatus()).toBe("completed");
    expect(resetSpy).toHaveBeenCalledTimes(4);

    expect(machine.tick()).toBe("completed"); // terminal, no-op
  });

  it("calls onStageAdvance right after resetting metrics on every stage advance", () => {
    const splitter = new TrafficSplitter();
    const metrics = new MetricsCollector();
    const calls: string[] = [];
    vi.spyOn(metrics, "reset").mockImplementation(() => calls.push("reset"));
    const onStageAdvance = vi.fn(() => calls.push("onStageAdvance"));
    const machine = new RolloutStateMachine({
      stages: [5, 25, 100],
      splitter,
      metrics,
      decide: scriptedDecider(["proceed"]),
      onStageAdvance,
    });

    machine.start(); // calls reset(), not onStageAdvance (stage 0 is the initial stage, not an advance)
    expect(calls).toEqual(["reset"]);

    machine.tick(); // proceed: stage 0 -> 1
    expect(onStageAdvance).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(["reset", "reset", "onStageAdvance"]);
  });

  it("holds in place without advancing or resetting metrics", () => {
    const splitter = new TrafficSplitter();
    const metrics = new MetricsCollector();
    const resetSpy = vi.spyOn(metrics, "reset");
    const machine = new RolloutStateMachine({
      stages: [5, 25],
      splitter,
      metrics,
      decide: scriptedDecider(["hold"]),
    });
    machine.start();
    resetSpy.mockClear();

    machine.tick();
    machine.tick();
    expect(machine.getStageIndex()).toBe(0);
    expect(splitter.getCanaryPercent()).toBe(5);
    expect(resetSpy).not.toHaveBeenCalled();
    expect(machine.getStatus()).toBe("running");
  });

  it("rolls back immediately on a 'rollback' verdict, sets the splitter to 0%, and halts further stages", () => {
    const splitter = new TrafficSplitter();
    const decideSpy = vi.fn(scriptedDecider(["hold", "hold", "rollback"]));
    const machine = new RolloutStateMachine({
      stages: [5, 25, 50, 100],
      splitter,
      metrics: new MetricsCollector(),
      decide: decideSpy,
    });
    machine.start();

    machine.tick(); // hold
    machine.tick(); // hold
    expect(machine.getStatus()).toBe("running");

    const status = machine.tick(); // rollback
    expect(status).toBe("rolled_back");
    expect(splitter.getCanaryPercent()).toBe(0);
    expect(machine.getRollbackMttrMs()).toBeGreaterThanOrEqual(0);

    const callsBeforeExtraTick = decideSpy.mock.calls.length;
    machine.tick(); // terminal, no-op
    expect(decideSpy.mock.calls.length).toBe(callsBeforeExtraTick); // decide is never consulted again
    expect(splitter.getCanaryPercent()).toBe(0);
  });

  it("reports no rollback MTTR when no rollback has happened", () => {
    const machine = new RolloutStateMachine({
      stages: [5],
      splitter: new TrafficSplitter(),
      metrics: new MetricsCollector(),
      decide: scriptedDecider(["hold"]),
    });
    machine.start();
    machine.tick();
    expect(machine.getRollbackMttrMs()).toBeUndefined();
  });

  it("records a history entry for every start()/tick() with the stage and canary percent at that moment", () => {
    const splitter = new TrafficSplitter();
    const machine = new RolloutStateMachine({
      stages: [5, 25],
      splitter,
      metrics: new MetricsCollector(),
      decide: scriptedDecider(["hold", "proceed"]),
    });
    machine.start();
    machine.tick(); // hold
    machine.tick(); // proceed -> stage 1

    const history = machine.getHistory();
    expect(history).toHaveLength(3);
    expect(history[0]).toMatchObject({ stageIndex: 0, canaryPercent: 5, decision: "hold" });
    expect(history[1]).toMatchObject({ stageIndex: 0, canaryPercent: 5, decision: "hold" });
    expect(history[2]).toMatchObject({ stageIndex: 1, canaryPercent: 25, decision: "proceed" });
  });
});
