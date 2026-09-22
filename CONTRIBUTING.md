# Contributing

Thanks for considering a contribution. This project is a learning-oriented,
statistically-honest implementation of a canary rollout controller — the bar
for a change isn't just "does it work," it's "does it hold up under the same
kind of scrutiny the existing validation harness applies." That said, small
fixes, doc improvements, and good-faith questions are all genuinely welcome,
not just large feature contributions.

## Table of contents

- [Before you start](#before-you-start)
- [Dev environment setup](#dev-environment-setup)
- [Project layout](#project-layout)
- [Coding conventions](#coding-conventions)
- [Testing expectations](#testing-expectations)
- [Making changes to the statistical controller](#making-changes-to-the-statistical-controller)
- [Commit and PR conventions](#commit-and-pr-conventions)
- [Reporting bugs](#reporting-bugs)
- [Asking questions](#asking-questions)

## Before you start

For anything beyond a small fix (typo, docs, an obviously-correct bug fix),
please open an issue first describing what you want to change and why.
This project makes deliberate, documented tradeoffs in several places (see
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) and
[`docs/STATISTICS.md`](docs/STATISTICS.md)) — an issue is the cheapest way
to find out whether a change fits before you invest time writing it.

## Dev environment setup

Requirements: **Node.js 20+**, npm.

```bash
git clone git@github.com:jamnxdev/canary-rollout-controller.git
cd canary-rollout-controller
npm install
npm run build --workspaces
npm test --workspaces
```

All test suites should pass before you start (target-service, controller,
validation packages). If they don't on a clean checkout, that's a bug worth
reporting on its own.

## Project layout

This is an npm-workspaces monorepo with three packages:

```
packages/
  target-service/   the configurable single-version HTTP backend
  controller/        splitter, proxy, metrics, both controllers,
                      state machine, dashboard, demo entry point
  validation/         the A/A and A/B trial harness + report generation
```

Each package extends the root `tsconfig.base.json`, with `src/` compiling to
`dist/` and tests living in a sibling `test/` directory (not inside `src/`)
so `tsc`'s build never compiles `.test.ts` files into `dist`. Keep new tests
in `test/`, matching this convention.

Full breakdown of every module's responsibility:
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Coding conventions

- **TypeScript `strict` mode, plus `noUncheckedIndexedAccess`, everywhere.**
  Don't silence type errors with `!` non-null assertions or `as` casts as a
  shortcut — if you hit a case where the compiler can't see something you
  know to be true (a closed union indexed dynamically is the recurring
  example in this codebase), prefer restructuring the code so the compiler
  *can* see it, the way `metricsCollector.ts` uses two explicit fields
  instead of a dynamically-indexed record. See that file's comments for the
  exact precedent.
- **Test against the real thing, not a mock**, wherever practical. Every
  package in this repo tests its HTTP-facing code by starting real Fastify
  instances on ephemeral ports and making real requests — see
  `packages/controller/test/proxy.test.ts` or
  `packages/validation/test/trial.test.ts` for the pattern. This project's
  own two documented statistical bugs (see below) were only catchable this
  way — a mocked baseline/canary pair can't reproduce a bug that only exists
  across a real sequence of ticks under real concurrent load.
- **Test probabilistic components against a statistical envelope, not an
  exact value**, with the tolerance derived from the actual sampling
  distribution. `packages/target-service/test/server.test.ts`'s error-rate
  test is the reference example: it runs 500 real trials and asserts the
  observed rate falls within a band derived from the binomial standard
  deviation at that sample size, not an arbitrarily chosen tolerance.
- No comments explaining *what* code does — name things so that's obvious.
  Comments in this codebase exist to record a *non-obvious why*: a hidden
  invariant, a tradeoff, or the reasoning behind a design choice a future
  reader would otherwise have to re-derive. Match that style.
- Don't add configuration knobs, abstractions, or generality beyond what the
  change actually needs. This project intentionally keeps things like
  `stats.ts`/`summarize.ts` dependency-free for three small functions used
  once each, rather than pulling in a stats library.

## Testing expectations

- `npm test --workspaces` must pass before you open a PR.
- If you add a new module or non-trivial function, add tests for it in the
  same package's `test/` directory.
- If you change `statisticalController.ts` or `stateMachine.ts` in any way
  that touches SPRT freezing/reset behavior, re-run the full validation
  batch (`./run-validation.sh`) and include the resulting rollback-rate
  numbers in your PR description — this is the concrete way to check you
  haven't reintroduced either of the two bugs documented in
  [`docs/STATISTICS.md`](docs/STATISTICS.md). A change that moves the
  A/A false-positive rate meaningfully away from the target `alpha` (5% by
  default) needs an explanation in the PR, not just a passing unit test
  suite — unit tests pass fixed inputs and structurally cannot catch a bug
  that only exists across a sequence of changing inputs, which is exactly
  how both prior bugs slipped past them.

## Making changes to the statistical controller

This is the most sensitive part of the codebase — read
[`docs/STATISTICS.md`](docs/STATISTICS.md) in full before touching
`statisticalController.ts`. In particular:

- `p0`/`p1` are **frozen** on the first `evaluate()` call whose baseline
  clears `minBaselineSamples`, not re-estimated on every call. If you're
  tempted to "simplify" this back to a fresh estimate per call, re-read
  [Bug 1](docs/STATISTICS.md#bug-1-re-estimating-p0-on-every-tick) first —
  that's exactly the regression that caused a 36.7% false-positive rate.
- `RolloutStateMachineConfig.onStageAdvance` receives the *new* stage's
  canary percent specifically so callers can skip resetting frozen SPRT
  state at a 100%-canary stage. If you're changing this hook's signature or
  behavior, re-read
  [Bug 2](docs/STATISTICS.md#bug-2-the-sprt-can-never-re-freeze-at-a-100-stage)
  first.

## Commit and PR conventions

- Keep commits focused — one logical change per commit, matching this
  repo's existing history (each commit corresponds to one coherent piece of
  functionality, e.g. "Sequential Probability Ratio Test as the real
  statistical decision engine").
- In the PR description, explain the **why**, not just the what — this
  project's own commit history and implementation docs consistently favor
  reasoning over restating a diff.
- Run `npm run build --workspaces && npm test --workspaces` locally before
  opening the PR.

## Reporting bugs

Open a GitHub issue with:

- What you ran (command, environment variables, package version)
- What you expected vs. what happened
- If it's a statistical/behavioral issue (e.g. an unexpectedly high
  false-positive rate), include a validation run
  (`TRIALS_PER_CELL=50 ./run-validation.sh` or similar) if you can — a
  single anecdotal run isn't enough to distinguish a real regression from
  ordinary sampling noise, which is exactly the discipline this project
  tries to hold itself to internally.

## Asking questions

Open a GitHub issue or discussion. If your question is really about *how
the statistics work* rather than a bug, check
[`docs/STATISTICS.md`](docs/STATISTICS.md) first — there's a good chance
it's already answered there in more depth than a quick reply could give.
