#!/usr/bin/env bash
# Buster Keaton, "One Week" (1920): the house stuck on the railway crossing and the train (the film's last two minutes).
# Segment: 22:25.4 -> 24:25.4 of the archive.org print (starts on Buster nailing the sofa to the house, ends on the
# "For Sale" sign, just before the "Directions" insert and "The End").
#   ./one-week.sh            # trims straight from archive.org (ffmpeg byte-range seek)
#   ./one-week.sh download   # first saves the 221 MB print to $CACHE, then trims from it
set -euo pipefail
ITEM=OneWeek1920
FILE=One-Week-v2.mp4
URL="https://archive.org/download/$ITEM/$FILE"
START=1345.4
LENGTH=120
MID=98.75
CACHE="${CACHE:-${TMPDIR:-/tmp}/coconuts-films}"
SRC="$URL"
if [ "${1:-}" = download ]; then
  mkdir -p "$CACHE"; curl -L -C - -o "$CACHE/one-week-src.mp4" "$URL"; SRC="$CACHE/one-week-src.mp4"
elif [ -f "$CACHE/one-week-src.mp4" ]; then
  SRC="$CACHE/one-week-src.mp4"
fi
exec "$(dirname "$0")/_trim.sh" one-week "$SRC" "$START" "$LENGTH" "$MID"
