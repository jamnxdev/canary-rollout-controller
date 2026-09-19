# Canary rollout controller — A/A and A/B validation results

Generated 2026-09-18T09:31:46.777Z. Raw per-trial data: `raw-trials.csv` in this directory.

| Controller | Scenario | Trials | Rollback rate | Completed | Timed out | Detection time (rollbacks): median / mean / p90 |
|---|---|---|---|---|---|---|
| naive | A/A (no regression) | 30 | 0.033 | 29 | 0 | 47ms / 47ms / 47ms |
| statistical | A/A (no regression) | 30 | 0.067 | 28 | 0 | 240ms / 240ms / 258ms |
| naive | A/B (injected regression) | 30 | 0.800 | 6 | 0 | 31ms / 33ms / 45ms |
| statistical | A/B (injected regression) | 30 | 1.000 | 0 | 0 | 136ms / 133ms / 152ms |

Under `aa`, `rollbackRate` is the empirical **false-positive rollback rate** (no regression exists). Under `ab`, `rollbackRate` is the empirical **true-positive detection rate** (a real regression exists).
