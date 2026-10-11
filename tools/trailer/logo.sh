#!/usr/bin/env bash
# tools/trailer/logo.sh: render the emblem to $TRAILER_WORK/logo.png (transparent).
# tools/trailer/README.md is the manual.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
# The copy is named for this run and removed on exit, and the GPU lease is
# used where it exists, as in capture.sh.
spec="_trailer-logo-$$"
trap 'rm -f "tests/e2e/$spec.spec.ts"' EXIT
cp tools/trailer/logo.spec.ts "tests/e2e/$spec.spec.ts"
export E2E_PORT="${E2E_PORT:-5397}"
export TRAILER_WORK="${TRAILER_WORK:-docs/private/trailer}"
run=(npx playwright test "$spec" --workers=1 --reporter=line)
if [ -f tools/agent/gpu.sh ]; then
  bash tools/agent/gpu.sh run "trailer-logo-$$" 10 -- "${run[@]}"
else
  "${run[@]}"
fi
