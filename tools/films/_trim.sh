#!/usr/bin/env bash
# _trim.sh <id> <source: archive.org URL or local file> <start seconds> <length seconds> [mid seconds]
# Cuts one segment to the clip spec: 1280x720 (4:3 prints pillarboxed to 16:9), H.264 main, CRF 25,
# 24 fps, no audio track, +faststart; a VP9 WebM of the same frames (<id>.webm, for browsers without reliable H.264,
# e.g. the desktop emulator's Chromium); then a first-frame poster <id>.jpg and a mid-frame <id>-mid.jpg.
# ffmpeg seeks with -ss before -i, so an https source is read by byte ranges (no full download needed).
set -euo pipefail
ID="$1"; SRC="$2"; START="$3"; LEN="$4"; MID="${5:-}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="$ROOT/public/films"
FFMPEG="${FFMPEG:-ffmpeg}"; FFPROBE="${FFPROBE:-ffprobe}"
CRF="${CRF:-25}"
mkdir -p "$OUT"
"$FFMPEG" -hide_banner -v error -y -ss "$START" -i "$SRC" -t "$LEN" -map 0:v:0 -an -sn -dn \
  -vf "scale=1280:720:force_original_aspect_ratio=decrease:flags=lanczos,pad=1280:720:(ow-iw)/2:(oh-ih)/2:black,setsar=1,fps=24,format=yuv420p" \
  -c:v libx264 -profile:v main -preset slow -crf "$CRF" -maxrate 1600k -bufsize 3200k -g 48 -keyint_min 24 \
  -map_metadata -1 -movflags +faststart "$OUT/$ID.mp4"
# The WebM is encoded from the MP4 so both files carry exactly the same frames and timing (cue times hold for both).
# Constrained quality: CRF 34 with a 1.5 Mbps average cap keeps the grainiest print (Méliès) under 25 MB.
"$FFMPEG" -hide_banner -v error -y -i "$OUT/$ID.mp4" -map 0:v:0 -an \
  -c:v libvpx-vp9 -crf "${VP9_CRF:-34}" -b:v "${VP9_CAP:-1500k}" -row-mt 1 -deadline good -cpu-used 4 -g 48 -pix_fmt yuv420p \
  -map_metadata -1 "$OUT/$ID.webm"
DUR="$("$FFPROBE" -v error -show_entries format=duration -of csv=p=0 "$OUT/$ID.mp4")"
[ -n "$MID" ] || MID="$(python3 -c "print(round($DUR/2, 2))")"
"$FFMPEG" -hide_banner -v error -y -i "$OUT/$ID.mp4" -frames:v 1 -q:v 3 "$OUT/$ID.jpg"
"$FFMPEG" -hide_banner -v error -y -ss "$MID" -i "$OUT/$ID.mp4" -frames:v 1 -q:v 3 "$OUT/$ID-mid.jpg"
echo "$ID: start $START s, length $LEN s -> $OUT/$ID.mp4 ($(stat -c %s "$OUT/$ID.mp4") bytes, ${DUR} s), $ID.webm ($(stat -c %s "$OUT/$ID.webm") bytes); posters $ID.jpg, $ID-mid.jpg (at $MID s)"
