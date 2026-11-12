// Shared foley types: props and hits.

export type PropId = 'coconuts' | 'door' | 'bell' | 'thunder' | 'whistle' | 'glass';

export const PROP_IDS: PropId[] = ['coconuts', 'door', 'bell', 'thunder', 'whistle', 'glass'];

export interface PropSpec {
  id: PropId;
  /** What the prop is called on screen. */
  name: string;
  /** What it sounds like, in two words. */
  sound: string;
  /** Position on the table, metres from the table centre: x to the right, z toward the player. */
  x: number;
  z: number;
}

/** The six props laid out left to right within a seated reach (table 0.70 x 0.40 m). */
export const PROPS: PropSpec[] = [
  // front row (nearer the player) and back row, laid out so that from a seated eye line no prop hides another
  { id: 'coconuts', name: 'Coconut shells', sound: 'hoofbeats', x: -0.12, z: 0.09 },
  { id: 'door', name: 'Little door', sound: 'knock, slam', x: -0.14, z: -0.09 },
  { id: 'bell', name: 'Desk bell', sound: 'ding', x: 0.05, z: 0.11 },
  { id: 'thunder', name: 'Thunder sheet', sound: 'rumble', x: 0.1, z: -0.1 },
  { id: 'whistle', name: 'Slide whistle', sound: 'fall', x: 0.2, z: 0.07 },
  { id: 'glass', name: 'Bag of glass', sound: 'crash', x: 0.3, z: -0.15 },
];

/**
 * The way across the table for a character who has left the picture: it lands at the back edge, runs through the gap
 * between the door and the thunder sheet, then between the coconuts and the bell, and stops at the front edge.
 * Metres on the table top (x to the player's right, z toward the player). `unit` is what one stage unit measures out
 * here: 0.55 of its size in the desk-size theatre (1.1 m / 12), because a figure that comes nearer must be smaller
 * to look the same.
 */
export const DESK_ROUTE: { unit: number; path: [number, number][]; off: [number, number] } = {
  unit: (1.1 / 12) * 0.55,
  path: [
    [-0.035, -0.165],
    [-0.032, -0.085],
    [-0.018, 0.02],
    [-0.018, 0.165],
  ],
  off: [-0.018, 0.275],
};

export type HitKind = 'clop' | 'knock' | 'slam' | 'ding' | 'rumble' | 'whistle' | 'crash';

/** One sound made on a prop. `t` is always 0: nothing keeps a clock for the hits (the HIT log line prints it). */
export interface HitEvent {
  t: number;
  prop: PropId;
  kind: HitKind;
  /** 0..1 strength or pitch, by kind. */
  v: number;
  /** Which hand, when known. */
  hand?: 'left' | 'right' | 'gaze';
}
