import { describe, expect, it } from "vitest";
import { TrafficSplitter } from "../src/splitter.js";

describe("TrafficSplitter", () => {
  it("routes everything to baseline at 0%", () => {
    const splitter = new TrafficSplitter(0);
    for (let i = 0; i < 200; i++) {
      expect(splitter.route()).toBe("baseline");
    }
  });

  it("routes everything to canary at 100%", () => {
    const splitter = new TrafficSplitter(100);
    for (let i = 0; i < 200; i++) {
      expect(splitter.route()).toBe("canary");
    }
  });

  it("produces an empirical canary share close to the configured percent", () => {
    const splitter = new TrafficSplitter(25);
    const trials = 2000;
    let canaryCount = 0;
    for (let i = 0; i < trials; i++) {
      if (splitter.route() === "canary") canaryCount++;
    }
    const share = canaryCount / trials;
    // 2000 Bernoulli(0.25) trials: std dev ~= sqrt(0.25*0.75/2000) ~= 0.0097 -> generous 6 std devs ~= 0.06
    expect(share).toBeGreaterThan(0.19);
    expect(share).toBeLessThan(0.31);
  });

  it("clamps out-of-range percentages", () => {
    const splitter = new TrafficSplitter();
    splitter.setCanaryPercent(150);
    expect(splitter.getCanaryPercent()).toBe(100);
    splitter.setCanaryPercent(-10);
    expect(splitter.getCanaryPercent()).toBe(0);
  });

  it("reflects setCanaryPercent immediately in subsequent routing", () => {
    const splitter = new TrafficSplitter(0);
    expect(splitter.route()).toBe("baseline");
    splitter.setCanaryPercent(100);
    expect(splitter.route()).toBe("canary");
  });
});
