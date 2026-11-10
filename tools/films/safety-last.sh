#!/usr/bin/env bash
# Harold Lloyd, "Safety Last!" (1923): the clock on the side of the building.
# Segment: 1:04:01 -> 1:06:01 of the archive.org print: Harold grabs the clock, the face swings open and he hangs from
# the hands; his pal drops him a rope; the policeman chases the pal round the office; the tug-of-war on the rope
# while Harold dangles under the cornice; pal and cop go down in a heap.
# The archive.org item is the 1080p restoration with Carl Davis's 1989 score; the clip keeps no audio track (picture only).
#   ./safety-last.sh            # trims straight from archive.org (ffmpeg byte-range seek; the file is 2 GB, only ~60 MB is read)
set -euo pipefail
ITEM=safety-last-1923
FILE="safety last 1923.mp4"
URL="https://archive.org/download/safety-last-1923/safety%20last%201923.mp4"
START="${START:-3841}"
LENGTH=120
MID=14.5
SRC="${SRC:-$URL}"
exec "$(dirname "$0")/_trim.sh" safety-last "$SRC" "$START" "$LENGTH" "$MID"
