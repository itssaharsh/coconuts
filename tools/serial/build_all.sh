#!/usr/bin/env bash
# Rebuilds everything under public/serial. Run from the repo root.
set -e
BL=/home/saharsh/.local/opt/blender-4.5.16-linux-x64/blender
node tools/serial/build_chars.mjs      # chars/, items/, anims.glb (+ assets-src/serial/chars_report.json)
node tools/serial/build_horse.mjs 0.75 # horse.glb
$BL -b --python assets-src/serial/decimate.py -- assets-src/kits/kaykit/Medieval-Hexagon-Pack/addons/kaykit_medieval_hexagon_pack/Assets/gltf/buildings/red/building_windmill_red.gltf assets-src/serial/work/windmill_dec.glb 1400
node tools/serial/build_scenery.mjs    # scenery/*.glb + index.json
tools/serial/build_sets.sh            # gen_sets.py + bake_set.py for gate vault graveyard inn hall camp
node tools/serial/build_catalog.mjs    # catalog.json
