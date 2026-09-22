# The statistics: SPRT, the peeking problem, and two bugs it took to get right

This document is the mathematical companion to
[`ARCHITECTURE.md`](ARCHITECTURE.md). It explains *why* a Sequential
Probability Ratio Test, walks through the exact formulas this codebase
implements, states the one real approximation this implementation makes, and
narrates the two production-shaped bugs that the validation harness (not the
unit tests) caught.

## Table of contents

- [The problem: why a fixed threshold isn't enough](#the-problem-why-a-fixed-threshold-isnt-enough)
- [The peeking problem](#the-peeking-problem)
- [Why SPRT, and not a group-sequential z-test](#why-sprt-and-not-a-group-sequential-z-test)
- [The math, exactly as implemented](#the-math-exactly-as-implemented)
- [The honest approximation: estimated p0, not fixed p0](#the-honest-approximation-estimated-p0-not-fixed-p0)
- [Bug 1: re-estimating p0 on every tick](#bug-1-re-estimating-p0-on-every-tick)
- [Bug 2: the SPRT can never re-freeze at a 100% stage](#bug-2-the-sprt-can-never-re-freeze-at-a-100-stage)

## The problem: why a fixed threshold isn't enough

`packages/controller/src/naiveController.ts`'s entire decision rule is:

```
if canary.errorRate > threshold: rollback
else if canary.count >= minSamples: proceed
else: hold
```

This has no concept of the baseline's own error rate. A production
baseline is essentially never at exactly 0% errors — some background rate of
timeouts, transient failures, and edge-case inputs is normal. A rule that
only looks at the canary in isolation cannot distinguish "the canary
regressed" from "the baseline (and by extension the canary, which serves the
same kind of traffic) is just having a noisy few minutes." The statistical
controller's entire reason to exist is to make that comparison correctly:
test the canary's error rate **against the baseline's own concurrently
observed rate**, not against an arbitrary fixed number.

## The peeking problem

Suppose instead you fix the naive rule's flaw by wrapping a proper
two-proportion significance test (baseline rate vs. canary rate) around a
fixed, pre-planned sample size — check once, at n=1000, and make a
statistically sound decision. That test's false-positive rate is only valid
**at the one sample size it was planned for.** If you instead check it
early and repeatedly — the natural thing to do when you want a bad canary
caught in seconds, not after a fixed wait — you inflate the realized
false-positive rate well above the test's nominal significance level. This
is exactly the mechanism behind "optional stopping" / p-hacking in A/B
testing: keep checking, and eventually you'll see a good (or bad) -looking
result purely by chance, and stopping right there capitalizes on that chance
as if it were a real signal.

A real production canary controller *has* to check continuously — waiting
for a fixed sample size before ever looking at the data defeats the entire
point of fast automated rollback. So the test itself needs to be designed
for continuous monitoring from the ground up, not adapted after the fact.

## Why SPRT, and not a group-sequential z-test

Two real, valid approaches exist for continuous monitoring:

1. **Group-sequential z-test with alpha-spending.** Pre-commit to a small,
   fixed number of "looks" at planned points, and shrink the per-look
   significance threshold so the *total* error budget across all looks still
   equals the target alpha. Real, well-established, and used widely in
   clinical trials. Requires deciding the number and spacing of looks in
   advance.
2. **Sequential Probability Ratio Test (SPRT).** Has no concept of "a look"
   at all. Its stopping boundaries are derived directly from Wald's theorem
   so that continuous, sample-by-sample monitoring controls Type I (false
   positive) and Type II (false negative) error at exactly the target
   `alpha`/`beta`, **by construction**, with no need to pre-commit to a
   checking schedule.

This project's rollout state machine checks the decision engine on
**every** `tick()` (potentially tens of times per second, as fast as the
caller polls) — not at a handful of pre-planned checkpoints. Given that
architecture, SPRT is the more natural fit, not merely the
"more sophisticated-sounding" option: it was chosen because its guarantees
match how this system actually monitors, not despite the alternative being
simpler to reason about.

## The math, exactly as implemented

`SequentialProbabilityRatioController.evaluate(baseline, canary)`
(`packages/controller/src/statisticalController.ts`) computes:

**Hypotheses**, where `p0` is the baseline's own error rate and
`minimumDetectableEffect` (MDE) is the smallest regression this test is
tuned to catch:

```
H0: canary error rate == p0
H1: canary error rate == p1 = p0 + MDE
```

**Cumulative log-likelihood ratio**, over the canary's `n` samples with `k`
observed errors (a closed-form collapse of summing each Bernoulli outcome's
individual log-likelihood-ratio contribution — valid because only the
*count* of errors, not their order, matters for an i.i.d. Bernoulli stream):

```
LLR = k · log(p1 / p0)  +  (n − k) · log((1 − p1) / (1 − p0))
```

**Wald's boundaries** — the standard textbook derivation for target Type I
error `alpha` and Type II error `beta`:

```
reject H0  (→ "rollback"):  LLR ≥ log((1 − beta) / alpha)
accept H0  (→ "proceed"):   LLR ≤ log(beta / (1 − alpha))
otherwise:                  "hold"  — not enough evidence yet either way
```

Both boundary formulas are asserted directly in `statisticalController.test.ts`
against their textbook closed forms, not just checked indirectly through
emergent pass/fail behavior — so a future refactor of the arithmetic can't
silently drift the math without a test catching it.

`p` values are clamped away from exactly `0` or `1` (`EPSILON = 1e-6`) to
keep the log-likelihood terms finite — an exact `0` or `1` estimate would
otherwise make one term of the LLR blow up to `±∞` from a single lucky or
unlucky sample.

## The honest approximation: estimated p0, not fixed p0

Textbook SPRT tests a **known, fixed** null hypothesis `p0` against a fixed
alternative `p1` — the classic setup assumes you already know what "no
regression" looks like in absolute terms. This system has no such fixed
reference: "what would the error rate be without the canary" is only
observable via the baseline's own concurrent traffic in the same rollout
stage, so `p0` is **estimated** from `baseline.errorRate`, not hardcoded.

This is a real, load-bearing approximation, not a footnote: if the baseline
sample is small, `p0` itself is a noisy estimate, and the test's Type I/II
guarantees weaken accordingly. That's exactly why `minBaselineSamples`
exists as a hard floor before the test runs at all — mirroring the naive
controller's own `minSamples` gate, but applied to the *reference*
population instead of the canary.

If you ever have to defend this design (in an interview, a design review, or
a GitHub issue), the honest answer to "what's the catch?" is: **yes, there
is one, and it's exactly here.**

## Bug 1: re-estimating p0 on every tick

The first full A/A validation run (`minBaselineSamples: 30`, matching the
unit-test fixtures at the time) measured a **36.7% empirical false-positive
rate** against a 5% target `alpha` — worse than the naive controller it was
meant to improve on. This was debugged, not shrugged off:

1. **First hypothesis, checked with real numbers:** at a true 5% baseline
   error rate, `P(zero errors in 30 samples) = 0.95^30 ≈ 21.5%` — a large
   chance that the very first qualifying baseline sample shows *zero* errors
   by chance alone. When that happens, `p0` clamps to `EPSILON`, and a
   *single* canary error produces `log(p1 / p0) ≈ log(0.05 / 0.000001) ≈ 10.8`
   — an enormous LLR jump from one unlucky data point, crossing the upper
   boundary almost immediately.
2. **First fix tried:** raising `minBaselineSamples` to 200
   (`0.95^200 ≈ 3.5×10⁻⁵`, a negligible chance of a degenerate near-zero
   `p0`). Re-running dropped the false-positive rate to 13.3% — better, but
   still nearly 3× the 5% target. Raising the sample floor alone wasn't the
   whole story.
3. **The deeper bug:** `evaluate()` recomputed `p0` fresh from
   `baseline.errorRate` on **every single call**, not just the first. Because
   the rollout state machine calls `decide()` on every `tick()` (every ~15ms
   in the validation harness) while traffic keeps arriving, `p0` — and
   therefore `p1` and the whole LLR scale — was silently shifting between
   ticks. Each tick was technically testing a *different* null/alternative
   pair, which breaks the fixed-hypothesis assumption Wald's boundaries are
   derived for. This is a second, independent instance of the peeking
   problem — this time hiding in the *reference distribution*, not in *when
   you check the result* — and it went uncaught by unit tests because every
   `statisticalController.test.ts` case at the time happened to pass the
   *same, unchanging* baseline `VersionStats` object into every `evaluate()`
   call in a given test, so the bug had no sequence of *changing* inputs in
   which to manifest.
4. **The fix:** `SequentialProbabilityRatioController` now freezes `p0`/`p1`
   the first time `evaluate()` is called with a baseline that clears
   `minBaselineSamples`, and reuses that frozen pair for the rest of the
   test's lifetime — restoring the textbook fixed-hypothesis SPRT setup. A
   `reset()` method was added for reuse across stages.
5. **Re-run with the fix** (`minBaselineSamples: 200`, freeze in place):
   false-positive rate **6.7%** — within one empirical standard deviation of
   the 5% target at n=30 (`sqrt(0.05 · 0.95 / 30) ≈ 4.0%`) — genuinely
   controlled, not just closer.

This is, honestly, the most valuable thing the validation methodology has
done for this project: it caught a real, non-obvious correctness bug that
passing unit tests had missed — specifically *because* unit tests exercise
fixed inputs, and this bug only existed across a *sequence* of changing
inputs.

## Bug 2: the SPRT can never re-freeze at a 100% stage

After fixing Bug 1, running the interactive demo with a healthy canary
(matching the baseline's error rate) against the default
`[5, 25, 50, 100]` stage list **never reached `"completed"`** — it sat on
`"hold"` indefinitely at the final stage, even after tens of seconds of real
traffic.

Root cause, found by inspecting the dashboard's own `/api/status` output
rather than guessing: at a 100%-canary stage, `TrafficSplitter.route()`
sends **zero** traffic to baseline by construction. The stage-advance hook
at the time unconditionally called `statistical.reset()` on every stage
transition (the fix for Bug 1, above) — clearing the frozen `p0`/`p1`. But
clearing it at the transition *into* the 100% stage is fatal: `evaluate()`
cannot re-freeze `p0` without fresh baseline samples clearing
`minBaselineSamples`, and at 100% canary those samples can now **never**
arrive. The stage is stuck below the sample floor forever, `evaluate()`
short-circuits to `"hold"` on every call, and the rollout can never complete.

This is a second, independent instance of the same underlying bug class as
Bug 1 (the SPRT's frozen state silently becoming wrong or unrecoverable
across a transition it wasn't designed to survive), and it's also a direct,
literal instance of a classically hard problem in canary analysis: handling
a stage where the sample size available to the test is too small for it to
have any statistical power — except at 100% it isn't merely *low* power,
it's **exactly zero power, permanently**, for that stage. No unit or
integration test at the time caught this, because every existing test
either used the naive controller (no baseline-freeze concept at all) or used
stage lists that never actually reached 100% with the statistical
controller under real traffic.

**The fix:** `RolloutStateMachineConfig.onStageAdvance` now receives the
*new* stage's canary percent — `(newCanaryPercent: number) => void` — and
callers only reset the frozen SPRT state when `newCanaryPercent < 100`. At
the 100% transition, the previous stage's frozen `p0`/`p1` is deliberately
carried forward as the closest honest reference still available, and the
final stage's canary traffic is tested against *that* estimate instead of a
fresh one that could never form.

This is a real, documented tradeoff, not a free fix: the final stage's
statistical judgment rests on a baseline estimate that is, by then, one
stage old. An alternative was considered and rejected — skip running the
statistical test at all once a stage hits 100% canary, treating "fully cut
over" as definitionally done. That was rejected because it silently removes
monitoring exactly where a slow-building regression would be most
consequential (all production traffic already on the new version); carrying
the frozen estimate forward keeps *some* statistical check running
throughout the rollout, which is more consistent with the goal of
continuously monitored, automated rollback than skipping the check would be.

Both bugs, and the reasoning behind each fix, are also covered from the
system-design side in [`ARCHITECTURE.md`](ARCHITECTURE.md).
