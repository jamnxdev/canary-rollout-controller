# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
once it reaches a 1.0 release.

## [Unreleased]

## [0.1.0] — 2026-09-19

Initial working implementation of the full local stack.

### Added

- `@canary/target-service` — a single configurable HTTP service instance
  (baseline or canary) with tunable latency, jitter, and error rate.
- `@canary/controller`:
  - `TrafficSplitter` and `buildProxy` — traffic routing with per-request
    outcome reporting.
  - `runLoad` — a concurrent HTTP load generator.
  - `MetricsCollector` — per-version request outcome tracking, reset per
    rollout stage.
  - `NaiveThresholdController` — the fixed-error-rate-threshold baseline to
    beat.
  - `SequentialProbabilityRatioController` — Wald's SPRT as the real
    statistical decision engine, comparing canary error rate against the
    baseline's own concurrently observed rate.
  - `RolloutStateMachine` — staged rollout progression (5% → 25% → 50% →
    100% by default), fail-safe rollback to 0% on regression or ambiguity.
  - `buildDashboardApp` — a live, polling HTML dashboard over
    `/api/status`.
  - `demo.ts` — a standalone, environment-variable-driven demo entry point.
- `@canary/validation` — an A/A (false-positive rate) and A/B
  (true-positive rate + detection time) trial harness comparing both
  controllers against real running instances, plus CSV/Markdown report
  generation.
- `run-validation.sh` — builds the workspace and runs the full validation
  batch.

### Fixed

- **SPRT false-positive rate inflation from re-estimating the null
  hypothesis on every tick** — `p0`/`p1` are now frozen the first time the
  baseline sample clears `minBaselineSamples`, instead of being recomputed
  on every `evaluate()` call. See
  [`docs/STATISTICS.md`](docs/STATISTICS.md#bug-1-re-estimating-p0-on-every-tick)
  for the full root-cause writeup.
- **SPRT rollout stalling forever at a 100%-canary stage** —
  `RolloutStateMachineConfig.onStageAdvance` now passes the new stage's
  canary percent, so callers can skip resetting the frozen SPRT baseline
  estimate at a stage where a fresh one could never form. See
  [`docs/STATISTICS.md`](docs/STATISTICS.md#bug-2-the-sprt-can-never-re-freeze-at-a-100-stage).

[Unreleased]: https://github.com/jamnxdev/canary-rollout-controller/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/jamnxdev/canary-rollout-controller/releases/tag/v0.1.0
