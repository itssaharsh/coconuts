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

def cell(c, r, f=0.5): return [(c + 0.5) / 8, (r + f) / 4]   # texel centre of the 8x4 gradient atlas of the Hexagon pack (f = how far down the cell)
def market():
    L = HX + ':buildings/neutral/wall_straight'
    PL = cell(1, 0, 0.08); YEL = cell(3, 1, 0.2); SAL = cell(7, 2, 0.3); BRN = cell(2, 1, 0.8); DBRN = cell(7, 1, 0.8)
    RED = cell(1, 3, 0.4); BLU = cell(1, 1, 0.3); GRN = cell(3, 3, 0.4); CRM = cell(5, 3, 0.2); ORG = cell(6, 2, 0.3); TAN1 = cell(5, 1, 0.5); TAN2 = cell(3, 2, 0.5); TAN3 = cell(6, 3, 0.5); STO = cell(6, 1, 0.5)
    pr = []
    def b(n, mn, mx, uv, **kw):
        d = box(n, mn, mx, L, uv); d.update(kw); pr.append(d)
    # --- cobbled ground: running-bond stones of three tans over a dark joint colour
    b('ground', [-9, -0.5, -4.6], [9, -0.001, 4.6], DBRN)
    cols = [TAN1, TAN2, TAN3, TAN2]
    for r in range(9):
        z0 = -4.5 + r * 1.0; off = 0.0 if r % 2 == 0 else 1.0
        for i in range(-5, 5):
            x0 = i * 2.0 + off
            if x0 + 2.0 < -9 or x0 > 9: continue
            b('st', [max(x0, -9) + 0.05, 0.0, z0 + 0.05], [min(x0 + 2.0, 9) - 0.05, 0.03, z0 + 0.95], cols[(i * 3 + r) % 4])
    # --- house fronts along the back wall (face z=-4), with gable roofs
    fronts = [(-7.2, -1.6, 4.0, PL, RED), (-1.6, 3.4, 4.5, YEL, ORG), (3.4, 7.2, 3.7, SAL, BLU)]
    for (x0, x1, h, col, roof) in fronts:
        pass
    # house A (door at -3.6, opening x -4.6..-2.6, y 0..2.8)
    b('A_l', [-7.2, 0, -4.5], [-4.6, 4.0, -4.0], PL); b('A_r', [-2.6, 0, -4.5], [-1.6, 4.0, -4.0], PL); b('A_top', [-4.6, 2.8, -4.5], [-2.6, 4.0, -4.0], PL)
    b('A_rec', [-4.6, 0, -4.5], [-2.6, 2.8, -4.38], DBRN)
    # house B (window at 2.6: opening x 1.8..3.4, y 1.5..3.0)
    b('B_l', [-1.6, 0, -4.5], [1.8, 4.5, -4.0], YEL); b('B_r', [3.4, 0, -4.5], [3.5, 4.5, -4.0], YEL)
    b('B_lo', [1.8, 0, -4.5], [3.4, 1.5, -4.0], YEL); b('B_hi', [1.8, 3.0, -4.5], [3.4, 4.5, -4.0], YEL); b('B_glass', [1.8, 1.5, -4.5], [3.4, 3.0, -4.38], cell(1, 0, 0.5))
    b('B_mx', [2.55, 1.5, -4.42], [2.65, 3.0, -4.3], BRN); b('B_my', [1.8, 2.2, -4.42], [3.4, 2.3, -4.3], BRN)
    b('B_sh_l', [1.35, 1.5, -4.1], [1.8, 3.0, -4.0], GRN); b('B_sh_r', [3.4, 1.5, -4.1], [3.85, 3.0, -4.0], GRN)
    b('B_sill', [1.7, 1.35, -4.2], [3.5, 1.5, -3.75], BRN)
    for i, x in enumerate((1.95, 2.35, 2.75, 3.15)): b('flw', [x - 0.12, 1.5, -4.0], [x + 0.12, 1.8, -3.82], (RED, YEL, RED, ORG)[i])
    b('C', [3.5, 0, -4.5], [7.2, 3.7, -4.0], SAL)
    # half timbering: posts and rails (dark brown) on the three fronts
    for x in (-7.1, -1.7, -1.55, 3.45, 7.1): b('post', [x - 0.12, 0, -4.1], [x + 0.12, (4.0 if x < -1.6 else 4.5 if x < 3.5 else 3.7), -3.94], DBRN)
    for (x0, x1, y) in ((-7.2, -1.6, 2.9), (-7.2, -1.6, 4.0), (-1.6, 3.4, 4.5), (-1.6, 3.4, 3.15), (3.5, 7.2, 3.7), (3.5, 7.2, 2.2)):
        b('rail', [x0, y - 0.12, -4.1], [x1, y + 0.12, -3.94], DBRN)
    for x in (-6.0, -5.2, -1.9, 4.6, 5.8, 6.6): b('stud', [x - 0.09, 0.0 if x != -1.9 else 0.0, -4.08], [x + 0.09, 2.9 if x < 0 else 2.2 if x > 4 else 3.0, -3.95], DBRN)
    b('lintel', [-4.75, 2.8, -4.12], [-2.45, 3.05, -3.92], DBRN); b('jamb_l', [-4.75, 0, -4.12], [-4.58, 2.8, -3.92], DBRN); b('jamb_r', [-2.62, 0, -4.12], [-2.45, 2.8, -3.92], DBRN)
    b('step', [-4.9, 0, -4.12], [-2.3, 0.18, -3.6], STO)
    # gable roofs (two slabs each) + chimneys
    import math
    for (x0, x1, eave, col, fc) in ((-7.4, -1.4, 4.0, RED, PL), (-1.8, 3.6, 4.5, ORG, YEL), (3.3, 7.4, 3.7, BLU, SAL)):
        xc = (x0 + x1) / 2; half = (x1 - x0) / 2; th = 28; L2 = half / math.cos(math.radians(th)) + 0.1
        yc = eave + half / 2 * math.tan(math.radians(th)) + 0.05
        b('roof_l', [xc - half / 2 - L2 / 2 + 0.0, yc - 0.12, -6.0], [xc - half / 2 + L2 / 2, yc + 0.12, -3.6], col, rotZ=th, pivot_c=True)
        b('roof_r', [xc + half / 2 - L2 / 2, yc - 0.12, -6.0], [xc + half / 2 + L2 / 2, yc + 0.12, -3.6], col, rotZ=-th, pivot_c=True)
        b('gable', [xc - half + 0.2, eave, -4.4], [xc + half - 0.2, eave + half * math.tan(math.radians(th)) - 0.1, -4.2], fc)
    b('chim', [-6.4, 4.4, -5.4], [-5.8, 6.2, -4.8], STO); b('chim2', [5.9, 3.9, -5.4], [6.5, 5.6, -4.8], STO)
    # --- market stalls with striped awnings
    def stall(cx, c1, c2, good, name):
        b(name + '_ctr', [cx - 1.3, 0, -3.55], [cx + 1.3, 1.1, -2.65], BRN); b(name + '_top', [cx - 1.4, 1.1, -3.65], [cx + 1.4, 1.2, -2.55], TAN2)
        for x in (cx - 1.35, cx + 1.35):
            b(name + '_pf', [x - 0.1, 0, -2.6], [x + 0.1, 3.0, -2.4], BRN); b(name + '_pb', [x - 0.1, 0, -3.75], [x + 0.1, 3.5, -3.55], BRN)
        for i in range(8):
            xa = cx - 1.6 + i * 0.4
            b(name + '_aw', [xa, 3.12, -3.9], [xa + 0.4, 3.24, -2.2], c1 if i % 2 == 0 else c2, rotX=10)
            b(name + '_val', [xa, 2.72, -2.28], [xa + 0.4, 3.05, -2.2], c1 if i % 2 == 0 else c2)
        for i, g in enumerate(good):
            xg = cx - 0.95 + i * 0.63; b(name + '_g', [xg - 0.25, 1.2, -3.4], [xg + 0.25, 1.62, -2.95], g); b(name + '_g2', [xg - 0.17, 1.62, -3.3], [xg + 0.17, 1.9, -3.05], g)
    stall(-6.9, RED, CRM, (RED, YEL, GRN, ORG), 'sl')
    stall(0.3, BLU, YEL, (ORG, GRN, RED, YEL), 'sr')
    # --- sacks, crates, barrels (small, at the sides)
    for (x, z, w, h, col) in ((-7.0, -3.7, 0.55, 0.65, CRM),  (-1.15, -3.5, 0.7, 0.8, BRN), (-0.7, -3.6, 0.6, 0.6, TAN2), (6.2, -3.7, 0.5, 0.5, CRM)):
        b('crate', [x - w, 0, z - w], [x + w, h * 1.1, z + w], col)
    for (x, z) in ((-7.4, -3.5),):
        b('bar', [x - 0.45, 0, z - 0.45], [x + 0.45, 0.9, z + 0.45], BRN); b('barh', [x - 0.47, 0.25, z - 0.47], [x + 0.47, 0.35, z + 0.47], STO); b('barh', [x - 0.47, 0.6, z - 0.47], [x + 0.47, 0.7, z + 0.47], STO)
    # --- hay cart (far left side) : bed, sides, hay, two octagon wheels, shafts
    cz, cxp = 1.2, 6.1
    b('cart_bed', [cxp - 0.9, 0.7, cz - 1.3], [cxp + 0.9, 0.85, cz + 1.3], BRN)
    for dx in (-0.9, 0.9): b('cart_side', [cxp + dx - 0.07, 0.85, cz - 1.3], [cxp + dx + 0.07, 1.5, cz + 1.3], BRN)
    b('cart_end', [cxp - 0.9, 0.85, cz - 1.3], [cxp + 0.9, 1.5, cz - 1.2], BRN); b('hay', [cxp - 0.8, 0.85, cz - 1.1], [cxp + 0.8, 1.7, cz + 1.2], YEL)
    for dx in (-1.0, 1.0):
        b('wheel', [cxp + dx - 0.07, 0.0, cz - 0.1 - 0.62], [cxp + dx + 0.07, 1.24, cz - 0.1 + 0.62], BRN); b('wheel', [cxp + dx - 0.07, 0.0, cz - 0.1 - 0.62], [cxp + dx + 0.07, 1.24, cz - 0.1 + 0.62], BRN, rotX=45)
    b('shaft', [cxp - 0.7, 0.55, cz + 1.3], [cxp - 0.55, 0.7, cz + 2.7], BRN); b('shaft', [cxp + 0.55, 0.55, cz + 1.3], [cxp + 0.7, 0.7, cz + 2.7], BRN)
    # --- bunting along the back wall
    cols = [RED, YEL, BLU, GRN, ORG]
    n = 0
    for (xa, xb) in ((-6.8, -0.2), (0.2, 6.8)):
        xm = (xa + xb) / 2; hw = (xb - xa) / 2
        for i in range(15):
            x = xa + (i + 0.5) * (xb - xa) / 15; y = 3.95 - 0.85 * (1 - ((x - xm) / hw) ** 2)
            b('flag', [x - 0.16, y - 0.36, -3.93], [x + 0.16, y - 0.04, -3.9], cols[n % 5], rotZ=45); n += 1
    pieces = [pc(HX + ':buildings/red/building_well_red', 5.9, -2.7, 0, s=3.9), pc(HX + ':buildings/red/building_church_red', 1.0, -9.5, 0, s=4.6),
              pc(HX + ':buildings/red/building_windmill_red', -5.5, -9.5, 0, s=4.0) if False else pc(HX + ':decoration/props/flag_red', 6.2, -3.9, 0, y=3.7, s=3.0)]
    marks = {'door': [-3.6, -2.6], 'window': [2.6, -2.6], 'stall_l': [-6.6, -1.4], 'stall_r': [0.3, -1.4], 'well': [4.0, -0.3], 'centre': [0, 1.2], 'left': [-3.8, 1.2], 'right': [3.8, 1.2], **WINGS}
    # the door: leaf + straps + handle, one dynamic node hinged on its -x edge (x=-4.6) at the wall face
    piv = [-4.6, 0, -4.17]
    for n_, mn, mx, uv in (('leaf', [-4.6, 0, -4.3], [-2.6, 2.8, -4.05], GRN), ('strap1', [-4.6, 0.5, -4.05], [-2.6, 0.72, -3.99], DBRN), ('strap2', [-4.6, 2.0, -4.05], [-2.6, 2.22, -3.99], DBRN),
                           ('plank', [-3.63, 0, -4.05], [-3.57, 2.8, -3.99], DBRN), ('handle', [-2.95, 1.25, -4.05], [-2.8, 1.45, -3.93], YEL)):
        d = box(n_, mn, mx, L, uv); d['dynamic'] = 'door'; d['pivot'] = piv; pr.append(d)
    return spec('market', 'Village market at noon', 'exterior', 'day', pieces, pr, marks, [], {'door': DOOR}, {'note': 'sunny set, no lamps; dressing on the back wall and sides, acting area |x|<=4.5, z -1.2..3.6 kept clear'})

if __name__ == '__main__':
    os.makedirs(OUT, exist_ok=True)
    for fn in (gate, vault, graveyard, inn, hall, camp, market):
        d = fn(); json.dump(d, open(OUT + d['id'] + '.json', 'w'), indent=1); print('wrote', d['id'], len(d['pieces']), 'pieces')
