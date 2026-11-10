#!/usr/bin/env bash
# Georges Méliès, "A Trip to the Moon" / "Le Voyage dans la Lune" (1902), black-and-white print.
# Segment: 9:18 -> 11:18 of the archive.org print: the Selenites in the mushroom grotto burst into puffs of smoke
# under the explorers' umbrellas, the explorers are dragged before the Selenite king, the professor throws him down
# (he explodes), the chase across the moon, the shell tipped off the cliff and the fall into the sea.
# (The launch and the rocket in the Moon's eye come earlier, at 5:40-6:20; set START=336 for that segment instead.)
#   ./trip-to-the-moon.sh            # trims straight from archive.org (ffmpeg byte-range seek)
#   ./trip-to-the-moon.sh download   # first saves the 218 MB print to $CACHE, then trims from it
set -euo pipefail
ITEM=ATripToTheMoonGeorgeMelies
FILE="A Trip to the Moon-George Méliès.mp4"
URL="https://archive.org/download/ATripToTheMoonGeorgeMelies/A%20Trip%20to%20the%20Moon-George%20M%C3%A9li%C3%A8s.mp4"
START="${START:-558}"
LENGTH=120
MID=51
CACHE="${CACHE:-${TMPDIR:-/tmp}/coconuts-films}"
SRC="$URL"
if [ "${1:-}" = download ]; then
  mkdir -p "$CACHE"; curl -L -C - -o "$CACHE/trip-to-the-moon-src.mp4" "$URL"; SRC="$CACHE/trip-to-the-moon-src.mp4"
elif [ -f "$CACHE/trip-to-the-moon-src.mp4" ]; then
  SRC="$CACHE/trip-to-the-moon-src.mp4"
fi
exec "$(dirname "$0")/_trim.sh" trip-to-the-moon "$SRC" "$START" "$LENGTH" "$MID"
