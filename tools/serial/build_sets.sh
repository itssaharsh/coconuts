#!/usr/bin/env bash
# usage: tools/serial/build_sets.sh [id ...]   (default: all six)
BL=/home/saharsh/.local/opt/blender-4.5.16-linux-x64/blender
python3 tools/serial/gen_sets.py >/dev/null
for s in ${@:-gate vault graveyard inn hall camp market}; do $BL -b --python assets-src/serial/bake_set.py -- assets-src/sets/$s.json 2>&1 | grep -E "BAKED|Error|rror|Traceback|File" ; done
