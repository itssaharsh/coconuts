// Shared foley types: props, hits, takes.

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
  { id: 'glass', name: 'Bag of glass', sound: 'crash', x: 0.32, z: -0.1 },
];

export type HitKind = 'clop' | 'knock' | 'slam' | 'ding' | 'rumble' | 'whistle' | 'crash';

/** One recorded event of a take. `t` is seconds into the clip. */
export interface HitEvent {
  t: number;
  prop: PropId;
  kind: HitKind;
  /** 0..1 strength or pitch, by kind. */
  v: number;
  /** Which hand, when known. */
  hand?: 'left' | 'right' | 'gaze';
}

export interface Take {
  clipId: string;
  events: HitEvent[];
  startedAt: string;
}
