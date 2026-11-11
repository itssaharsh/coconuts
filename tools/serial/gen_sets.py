#!/usr/bin/env python3
"""Writes assets-src/sets/<id>.json for the six Serial sets (inputs of assets-src/serial/bake_set.py). Edit layouts here, then run build_all.sh.
Piece format: see the header of assets-src/serial/bake_set.py. rotY is degrees about +Y."""
import json, os
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
OUT = ROOT + '/assets-src/sets/'
KITS = {
    'dg': 'kaykit/Dungeon-Remastered/addons/kaykit_dungeon_remastered/Assets/gltf',
    'hx': 'kaykit/Medieval-Hexagon-Pack/addons/kaykit_medieval_hexagon_pack/Assets/gltf',
    'hw': 'kaykit/Halloween-Bits/addons/kaykit_halloween_bits/Assets/gltf',
}
CONV = ('Kit units, y-up, floor y=0, audience at +z looking down -z, +x = the audience\'s right (left/right mark names are the audience\'s left/right). '
        'Runtime scale: 1 unit = 1/12 of the proscenium opening width. Proscenium opening x in [-6,6], y in [0,6.75], plane z=+4. Stage floor z in [-4,4], x in [-8,8]; '
        'back wall inner face z=-4. Everything with |x|>6.85 is discarded by the runtime. Marks are [x, z].')
FOOT = {'x': [-8, 8], 'z': [-4, 4], 'floorY': 0, 'backWallInnerZ': -4, 'frontEdgeZ': 4, 'visibleX': [-6, 6], 'openingY': [0, 6.75]}
D, HX, HW = 'dg', 'hx', 'hw'
ST = [0.141, 0.172]; FLOOR = [0.672, 0.14]; WOOD = [0.547, 0.109]; RED = [0.469, 0.6]
GRASS = [0.079, 0.576]; DIRT = [0.43, 0.60]; HDIRT = [0.797, 0.27]

def pc(src, x, z, ry=0, y=0, s=1, **kw):
    d = {'src': src, 'pos': [x, y, z], 'rotY': ry, 'scale': s}; d.update(kw); return d
def box(name, mn, mx, like, uv): return {'type': 'box', 'name': name, 'min': mn, 'max': mx, 'like': like, 'uv': uv}
def torch_light(n, x, y=3.0, z=-3.5, i=1.0): return {'name': n, 'kind': 'torch', 'pos': [x, y, z], 'color': '#ffa040', 'intensity': i, 'distance': 12}
DOOR = {'axis': [0, 1, 0], 'closed': 0, 'open': -1.75, 'note': 'hinge on the -x edge of the leaf; negative angle swings the free edge towards the audience (+z), positive swings it away behind the wall'}
LID = {'axis': [1, 0, 0], 'closed': 0, 'open': -1.9, 'note': 'hinge along the back edge; negative angle lifts the front'}
def floor(tile=':floor_tile_large', rocks=()):
    out = []
    for ix, x in enumerate([-6, -2, 2, 6]):
        for iz, z in enumerate([-2, 2]):
            out.append(pc(D + (':floor_tile_large_rocks' if (x, z) in rocks else tile), x, z, ry=90 * ((ix * 3 + iz) % 4)))
    return out
def wall_back(items):  # items: (piece, x, scaleX)
    return [pc(D + ':' + n, x, -4.5, s=[sx, 1, 1], **kw) for n, x, sx, kw in items]
def spec(id_, title, kind, sky, pieces, prims, marks, lights, dyn, meta=None):
    assert len(lights) <= 4
    return {'id': id_, 'title': title, 'kind': kind, 'sky': sky, 'kits': KITS, 'convention': CONV, 'footprint': FOOT, 'pieces': pieces, 'prims': prims,
            'marks': marks, 'lights': lights, 'dynamic': dyn, 'meta': meta or {}}
WINGS = {'wings_left': [-8.5, 2], 'wings_right': [8.5, 2]}

def gate():
    P = floor(rocks=((-6, -2), (6, 2)))
    P += wall_back([('wall', -5.5, 1, {}), ('wall_doorway', -1.5, 1, {'dynamic_children': {'wall_doorway_door': 'door'}}), ('wall_archedwindow_gated', 2.5, 1, {}), ('wall', 6.5, 1, {})])
    P[-4] = pc(D + ':wall_archedwindow_gated', -5.5, -4.5); P[-2] = pc(D + ':wall', 2.5, -4.5)
    P += [pc(D + ':torch_mounted', -3.45, -3.95, y=2.4), pc(D + ':torch_mounted', 0.45, -3.95, y=2.4)]
    P += [pc(HX + ':buildings/red/building_tower_A_red', 4.8, -5.3, s=3.2)]
    P += [pc(D + ':barrel_large', 5.6, -2.2), pc(D + ':crates_stacked', 3.0, -2.5, 12, s=0.9), pc(D + ':crates_stacked', 6.1, -0.9, -20, s=0.55)]
    P += [pc(HX + ':decoration/nature/tree_single_B', -6.0, -2.9, s=3.4), pc(D + ':crates_stacked', -3.9, -3.0, 20, s=0.7)]
    marks = {'door': [-1.5, -2.6], 'centre': [0, 0.8], 'left': [-3.8, 1.2], 'right': [3.8, 1.2], 'guard': [4.2, -1.4], **WINGS}
    lights = [torch_light('torch_l', -3.45, 3.05, -3.5), torch_light('torch_r', 0.45, 3.05, -3.5)]
    return spec('gate', 'Castle gate at night', 'exterior', 'night', P, [], marks, lights, {'door': DOOR},
                {'note': 'tower reaches ~7 units on the right third; guard sits at the guard mark between barrel and crates'})

def vault():
    P = floor(rocks=((6, -2),))
    P += wall_back([('wall', -7.6, 1, {}), ('wall_doorway', -3.6, 1, {'dynamic_children': {'wall_doorway_door': 'door'}}), ('wall', -0.5, 0.55, {}),
                    ('wall_archedwindow_gated', 2.6, 1, {}), ('wall', 6.6, 1, {})])
    P += [pc(D + ':wall', -6.5, -2, 90), pc(D + ':wall_window_open', 6.5, -2, -90)]
    P += [pc(D + ':torch_mounted', -6.0, -3.95, y=2.4), pc(D + ':torch_mounted', 0.6, -3.95, y=2.4), pc(D + ':torch_mounted', 4.9, -3.95, y=2.4)]
    P += [pc(D + ':banner_thin_red', -0.5, -4.2, y=-0.3), pc(D + ':banner_patternA_red', 5.9, -4.2, y=0.1), pc(D + ':banner_patternB_yellow', -6.35, -1.0, 90, y=0.1)]
    P += [pc(D + ':chest_gold', -0.6, -2.6, 0, dynamic_children={'chest_gold_lid': 'chest_lid'}), pc(D + ':coin_stack_large', -2.0, -2.4), pc(D + ':coin_stack_medium', -1.5, -1.7, 40),
          pc(D + ':coin_stack_small', 0.9, -1.8), pc(D + ':coin_stack_medium', 1.4, -2.7, 70), pc(D + ':coin_stack_small', 0.9, -2.0), pc(D + ':coin', 0.2, -1.4, 20), pc(D + ':coin', -1.4, -1.1, 80)]
    P += [pc(D + ':table_medium_decorated_A', 4.2, -1.6, 12, s=1.0), pc(D + ':candle_lit', 3.7, -1.6, y=1.0), pc(D + ':bottle_A_green', 4.5, -1.2, y=1.0), pc(D + ':bottle_B_brown', 4.1, -2.0, y=1.0),
          pc(D + ':stool', 5.7, -0.9), pc(D + ':stool', 3.0, -0.9, 80)]
    P += [pc(D + ':barrel_large', 5.5, -3.1), pc(D + ':barrel_small_stack', 4.2, -3.3), pc(D + ':keg_decorated', 5.4, -1.6 - 0.0, 90, s=0.7) if False else pc(D + ':barrel_small', 6.2, -2.0),
          pc(D + ':crates_stacked', -5.2, -3.0, 12), pc(D + ':trunk_medium_A', -4.0, -0.6, 20), pc(D + ':box_small', -5.8, -0.2, -15)]
    marks = {'door': [-3.6, -2.6], 'chest': [-2.4, -1.7], 'window': [2.6, -2.6], 'table': [4.2, -0.2], 'centre': [0, 1], 'left': [-3.8, 1.2], 'right': [3.8, 1.2], **WINGS}
    lights = [torch_light('torch_l', -6.0, 3.05), torch_light('torch_c', 0.6, 3.05), torch_light('torch_r', 4.9, 3.05, i=0.8),
              {'name': 'candle_table', 'kind': 'candle', 'pos': [3.7, 1.8, -1.6], 'color': '#ffc070', 'intensity': 0.4, 'distance': 6}]
    return spec('vault', 'Treasury vault', 'interior', 'dark', P, [], marks, lights, {'door': DOOR, 'chest_lid': LID})

def graveyard():
    P = []
    for x in (-6, -2, 2, 6):
        for z in (-2, 2): P.append(pc(HW + ':floor_dirt', x, z, ry=90 * ((x + z) % 4)))
    for z in (2.6, 0.8, -1.0, -2.8): P.append(pc(HW + ':path_A' if z > 0 else HW + ':path_B', 0.0, z, 90 if z > 0 else 0, y=0))
    P += [pc(HW + ':arch_gate', 0, -4.1), pc(HW + ':fence', -4.1, -4.1), pc(HW + ':fence', -8.1, -4.1), pc(HW + ':fence', 4.1, -4.1), pc(HW + ':fence_pillar', 2.3, -4.1), pc(HW + ':fence_pillar', -2.3, -4.1)]
    P += [pc(HW + ':crypt', 5.2, -8.3), pc(HW + ':tree_dead_large', -5.3, -3.0, 20), pc(HW + ':tree_dead_small', -1.5, -6.0)]
    P += [pc(HW + ':gravestone', -1.4, -3.3), pc(HW + ':grave_A', 2.4, -3.2), pc(HW + ':gravemarker_B', -3.4, -2.9, 10), pc(HW + ':gravemarker_A', 0.4, -3.4, -8),
          pc(HW + ':gravemarker_B', 3.6, -2.6, -15), pc(HW + ':grave_B', -5.5, -0.9, 8), pc(HW + ':gravestone', -1.5, -0.9, -6), pc(HW + ':gravemarker_A', 2.1, -0.6, 12), pc(HW + ':grave_B', 5.6, -0.8, -8)]
    P += [pc(HW + ':post_lantern', -4.2, -3.7, 0), pc(HW + ':pumpkin_orange_jackolantern', 1.9, -0.0 - 0.4, 200, s=0.8), pc(HW + ':pumpkin_orange', 2.9, 0.2, 30, s=0.6),
          pc(HW + ':skull', -2.5, -0.5, 40, s=0.5), pc(HW + ':bone_A', 4.4, -0.7, 20)]
    marks = {'grave_a': [-3.4, -1.6], 'grave_b': [0.4, -2.2], 'grave_c': [3.6, -1.4], 'centre': [0, 1.2], 'left': [-3.8, 1.2], 'right': [3.8, 1.2], 'tree': [-5.3, -3.0], **WINGS}
    lights = [{'name': 'lantern', 'kind': 'torch', 'pos': [-4.2, 3.0, -2.5], 'color': '#ffb050', 'intensity': 1.0, 'distance': 12},
              {'name': 'jack', 'kind': 'candle', 'pos': [1.9, 1.1, -0.4], 'color': '#ff9030', 'intensity': 0.6, 'distance': 7}]
    return spec('graveyard', 'Graveyard', 'exterior', 'night', P, [], marks, lights, {}, {'note': 'grave plots at the three grave_* marks are kept clear (flat dirt)'})

def inn():
    P = floor(rocks=())
    P = [pc(D + (':floor_wood_large' if True else ''), x, z, ry=90 * ((i) % 4)) for i, (x, z) in enumerate([(a, b) for a in (-6, -2, 2, 6) for b in (-2, 2)])]
    P += wall_back([('wall_doorway', -4.0, 1, {'dynamic_children': {'wall_doorway_door': 'door'}}), ('wall', 0.0, 1, {}), ('wall', 4.0, 1, {}), ('wall', 8.0, 1, {}), ('wall', -8.0, 1, {})])
    P += [pc(D + ':wall_window_open', -6.5, -2, 90), pc(D + ':wall', 6.5, -2, -90)]
    for x in (1.0, 5.0): P.append(pc(D + ':shelf_large', x, -3.95, y=2.0)); P.append(pc(D + ':shelf_large', x, -3.95, y=3.1))
    for i, x in enumerate((0.3, 1.0, 1.8, 4.2, 5.0, 5.8)):
        P.append(pc(D + (':bottle_A_green', ':bottle_B_brown', ':bottle_A_labeled_brown')[i % 3], x, -3.7, y=2.35)); P.append(pc(D + (':bottle_C_green', ':bottle_A_brown')[i % 2], x + 0.3, -3.7, y=3.45))
    P += [pc(D + ':table_long_tablecloth', 3.4, -1.1, 90), pc(D + ':table_long', 7.2, -1.1, 90)]
    P += [pc(D + ':keg_decorated', 6.0, -3.0, 0, s=0.8), pc(D + ':barrel_large', 2.4, -3.2), pc(D + ':barrel_small_stack', 0.8, -3.3)]
    P += [pc(D + ':plate_food_A', 3.4, -1.1, y=1.0), pc(D + ':candle_lit', 4.6, -1.1, y=1.0)]
    P += [pc(D + ':table_small', -2.3, -0.9), pc(D + ':stool', -3.5, -0.9), pc(D + ':stool', -1.1, -0.9), pc(D + ':stool', -2.3, -2.1),
          pc(D + ':table_small', 0.1, -1.8), pc(D + ':stool', 0.1, -0.6, 30), pc(D + ':candle_lit', -2.3, -0.9, y=1.0)]
    P += [pc(D + ':barrel_large', -5.5, -0.5), pc(D + ':barrel_small_stack', -5.3, -2.0, 90), pc(D + ':crates_stacked', -5.2, -3.3, 8)]
    P += [pc(D + ':torch_mounted', -6.0, -3.95, y=2.4), pc(D + ':torch_mounted', 3.0, -3.95, y=4.0) if False else pc(D + ':banner_thin_red', -1.8, -4.2, y=0.8)]
    marks = {'bar': [4.0, 0.5], 'behind_bar': [4.0, -3.0], 'table_l': [-2.3, 0.4], 'table_r': [0.1, -0.6], 'door': [-4.0, -2.6], 'centre': [0, 1.2], 'left': [-3.8, 1.2], 'right': [3.8, 1.2], **WINGS}
    lights = [torch_light('torch', -6.0, 3.05), {'name': 'bar_lamp', 'kind': 'candle', 'pos': [4.6, 2.2, -1.1], 'color': '#ffc070', 'intensity': 0.9, 'distance': 9},
              {'name': 'table_candle', 'kind': 'candle', 'pos': [-2.3, 1.9, -0.9], 'color': '#ffc070', 'intensity': 0.5, 'distance': 6},
              {'name': 'hearth', 'kind': 'fire', 'pos': [-5.2, 1.2, -1.2], 'color': '#ff8a30', 'intensity': 0.7, 'distance': 8}]
    return spec('inn', 'Tavern', 'interior', 'dark', P, [], marks, lights, {'door': DOOR})

def hall():
    P = floor(tile=':floor_tile_large')
    P += wall_back([('wall_doorway', -5.6, 1, {'dynamic_children': {'wall_doorway_door': 'door'}}), ('wall', -1.6, 1, {}), ('wall', 2.4, 1, {}), ('wall', 6.4, 1, {}), ('wall', -9.6, 1, {})])
    P += [pc(D + ':wall', -6.5, -2, 90), pc(D + ':wall', 6.5, -2, -90)]
    P += [pc(D + ':pillar_decorated', -4.6, -3.0), pc(D + ':pillar_decorated', 4.6, -3.0)]
    P += [pc(D + ':banner_shield_red', 0.0, -4.2, y=0.6), pc(D + ':banner_patternA_red', -2.2, -4.2, y=0.6), pc(D + ':banner_patternA_red', 2.2, -4.2, y=0.6)]
    P += [pc(D + ':chair', 0.0, -3.0, y=0.55, s=1.9), pc(D + ':torch_lit', -2.9, -3.2, y=1.2, s=1.6), pc(D + ':torch_lit', 2.9, -3.2, y=1.2, s=1.6)]
    P += [pc(D + ':torch_mounted', -3.3, -3.95, y=2.4), pc(D + ':torch_mounted', 3.3, -3.95, y=2.4)]
    prims = [box('dais1', [-2.6, 0, -4], [2.6, 0.3, -1.9], D + ':wall', FLOOR), box('dais2', [-2.0, 0.3, -4], [2.0, 0.55, -2.4], D + ':wall', FLOOR),
             box('carpet', [-0.8, 0.0, -1.9], [0.8, 0.09, 2.9], D + ':wall', RED), box('carpet_d', [-0.8, 0.3, -2.4], [0.8, 0.33, -1.85], D + ':wall', RED)]
    marks = {'throne': [0, -1.2], 'dais_left': [-3.4, -2.6], 'dais_right': [3.4, -2.6], 'door': [-5.6, -2.6], 'centre': [0, 1.2], 'left': [-3.8, 1.2], 'right': [3.8, 1.2], **WINGS}
    lights = [torch_light('brazier_l', -2.9, 2.6, -3.2), torch_light('brazier_r', 2.9, 2.6, -3.2), torch_light('torch_l', -3.3, 3.05), torch_light('torch_r', 3.3, 3.05)]
    return spec('hall', 'Throne room', 'interior', 'dark', P, prims, marks, lights, {'door': DOOR})

def camp():
    P = []; K = 4.0
    N = HX + ':decoration/nature/'
    P += [pc(N + 'trees_A_medium', -6.2, -4.6, 0, s=5.2), pc(N + 'trees_B_small', -1.6, -5.0, 40, s=5.5), pc(N + 'trees_A_medium', 2.2, -5.2, 90, s=5.2), pc(N + 'trees_B_small', 6.0, -4.8, 10, s=5.5),
          pc(N + 'tree_single_B', -4.0, -3.2, 0, s=4.2), pc(N + 'tree_single_A', 0.2, -3.6, 0, s=4.4), pc(N + 'tree_single_B', 5.4, -3.2, 0, s=4.0),
          pc(N + 'tree_single_A', -6.6, -1.2, 0, s=4.2), pc(N + 'trees_A_small', 6.4, -1.0, 0, s=4.0)]
    P += [pc(HX + ':decoration/props/tent', 4.2, -2.4, 160, s=5.2), pc(HX + ':decoration/props/wheelbarrow', 1.8, -2.5, 60, s=3.6), pc(HX + ':decoration/props/sack', 2.9, -2.9, 0, s=3.4),
          pc(HX + ':decoration/props/crate_A_big', -4.2, -2.1, 25, s=3.6), pc(HX + ':decoration/props/barrel', -2.9, -3.3, 0, s=4.0)]
    P += [pc(HX + ':decoration/props/resource_lumber', -1.6, -0.8, 0, s=1.4), pc(N + 'rock_single_C', -2.7, -0.2, 20, s=4), pc(N + 'rock_single_D', -0.5, -0.1, 80, s=4), pc(N + 'rock_single_E', -1.9, -1.7, 40, s=3.2),
          pc(N + 'rock_single_A', -0.7, -1.4, 10, s=4)]
    P += [pc(HX + ':decoration/props/resource_lumber', -3.7, 0.0, 70, s=1.1, y=0), pc(HX + ':decoration/props/crate_A_big', 0.5, -0.9, 20, s=3.6)]
    P += [pc(N + 'rock_single_C', -7.2, 1.2, 0, s=5), pc(N + 'rock_single_E', 7.0, 0.9, 80, s=5)]
    prims = [box('grass', [-8.5, -0.5, -6], [8.5, 0, 4], HX + ':buildings/neutral/wall_straight', GRASS), box('clearing', [-5.2, -0.5, -3.4], [2.6, 0.04, 3.4], HX + ':buildings/neutral/wall_straight', DIRT)]
    marks = {'fire': [-1.6, 0.5], 'log': [-3.7, 0.0], 'cart': [1.8, -2.5], 'centre': [1.2, 1], 'left': [-3.8, 1.2], 'right': [3.8, 1.2], **WINGS}
    lights = [{'name': 'campfire', 'kind': 'fire', 'pos': [-1.6, 1.0, -0.8], 'color': '#ff8a30', 'intensity': 1.6, 'distance': 14}]
    return spec('camp', 'Forest camp', 'exterior', 'night', P, prims, marks, lights, {})

if __name__ == '__main__':
    os.makedirs(OUT, exist_ok=True)
    for fn in (gate, vault, graveyard, inn, hall, camp):
        d = fn(); json.dump(d, open(OUT + d['id'] + '.json', 'w'), indent=1); print('wrote', d['id'], len(d['pieces']), 'pieces')
