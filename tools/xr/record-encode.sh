#!/usr/bin/env bash
# Turns qa/rec/frame-*.jpg + frames.json into an MP4 at the measured frame rate (variable timing kept via concat).
set -euo pipefail
DIR=${1:-qa/rec}; OUT=${2:-qa/rec/take.mp4}
python3 - "$DIR" <<'PY'
import json,sys,os
d=sys.argv[1]; fr=json.load(open(os.path.join(d,'frames.json')))
with open(os.path.join(d,'list.txt'),'w') as f:
    for i,x in enumerate(fr):
        dur = (fr[i+1]['t']-x['t']) if i+1<len(fr) else 1/15
        f.write(f"file '{x['name']}'\nduration {max(0.01,dur):.4f}\n")
    if fr: f.write(f"file '{fr[-1]['name']}'\n")
PY
ffmpeg -y -loglevel error -f concat -safe 0 -i "$DIR/list.txt" -vsync vfr -pix_fmt yuv420p -vf "scale=trunc(iw/2)*2:trunc(ih/2)*2" "$OUT"
echo "wrote $OUT"; ffprobe -v error -show_entries format=duration -of csv=p=0 "$OUT"
