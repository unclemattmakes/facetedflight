#!/usr/bin/env bash
# tools/trailer/sheet.sh <clip> [step-seconds]: a contact sheet with game time
# burned in, to $TRAILER_WORK/stills/sheet-<clip>.jpg. Pick in-points from it.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)/${TRAILER_WORK:-docs/private/trailer}"
mkdir -p stills
c=$1; s=${2:-1}
# The font path is relative to the work dir, three levels under the repo root.
ffmpeg -v error -y -f concat -safe 0 -i "clips/$c/list.txt" -vf "fps=60,setpts=N/60/TB,fps=1/$s,scale=480:-1,drawtext=fontfile=../../../public/assets/fonts/crystal-regular.ttf:text='%{pts\:hms}':x=8:y=8:fontsize=28:fontcolor=yellow:box=1:boxcolor=black@0.6,tile=4x4" -frames:v 1 stills/sheet-$c.jpg
