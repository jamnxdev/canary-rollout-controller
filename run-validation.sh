#!/bin/bash
# Runs the full A/A (false-positive rate) and A/B (true-positive rate + detection
# time) validation batch for both the naive fixed-threshold controller and the
# SPRT-based statistical controller, against the real target service and proxy.
# Writes raw per-trial data and a summary table to packages/validation/results/.
#
# Override the number of trials per (controller x scenario) cell, default 30:
#   TRIALS_PER_CELL=50 ./run-validation.sh
set -euo pipefail
cd "$(dirname "$0")"
npm run build --workspaces --if-present
node packages/validation/dist/runValidation.js
