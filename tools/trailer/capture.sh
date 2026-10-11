#!/usr/bin/env bash
# tools/trailer/capture.sh: capture trailer footage.
#
#   bash tools/trailer/capture.sh <shot>[,<shot>...] [lease-name]
#
# Copies capture.spec.ts into Playwright's testDir as a gitignored `_` spec
# (its fixture imports resolve there), named for this run and removed on exit
# (a copy left behind is a spec the repo's guards sweep, and they go red for
# it), then runs the named shots from
# tools/trailer/shots.json. Where the GPU lease exists (tools/agent/gpu.sh, a
# private-repository tool) the run books the card under it; elsewhere it runs
# Playwright directly. The lease name defaults to one unique to this run: two
# runs booked under ONE name both held the card at once and shared a dev
# server, and the second one failed mid-shot with "Failed to fetch".
# tools/trailer/README.md is the manual.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
if [ $# -lt 1 ]; then
  echo "usage: $0 <shot>[,<shot>...] [lease-name]" >&2
  exit 2
fi
spec="_trailer-capture-$$"
trap 'rm -f "tests/e2e/$spec.spec.ts"' EXIT
cp tools/trailer/capture.spec.ts "tests/e2e/$spec.spec.ts"
export E2E_PORT="${E2E_PORT:-5397}"
export TRAILER_ONLY="$1"
export TRAILER_SHOTS="${TRAILER_SHOTS:-tools/trailer/shots.json}"
export TRAILER_WORK="${TRAILER_WORK:-docs/private/trailer}"
mkdir -p "$TRAILER_WORK/clips"
name="${2:-trailer-$$}"
run=(npx playwright test "$spec" --workers=1 --reporter=line)
if [ -f tools/agent/gpu.sh ]; then
  bash tools/agent/gpu.sh run "$name" 45 -- "${run[@]}"
else
  "${run[@]}"
fi
