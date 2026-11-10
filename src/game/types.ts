// Shared game types: the level data, orders, plans and steps.
// The planner (src/game/planner.ts), the XR layer and the /api/talk validator all speak this.

export type HelperId = 'pip' | 'mo' | 'tuck';

/** Tile coordinates on the tray: x 0..11 from the player's left, y 0..7 from near to far. One tile = 4 cm. */
export interface Tile {
  x: number;
  y: number;
}

export type PropKind =
  | 'crate'
  | 'heavy_crate'
  | 'plank_crate'
  | 'bridge'
  | 'pad'
  | 'key'
  | 'gate'
  | 'stool'
  | 'tree'
  | 'stone';

export type PropColor = 'red' | 'green' | 'blue' | 'brass' | 'wood';

export interface Prop {
  id: string;
  kind: PropKind;
  /** Spoken name, e.g. "the red crate by the wall". Namesakes get a distinguishing phrase. */
  label: string;
  /** Short name used in orders, e.g. "red crate"; two props may share it (ambiguity). */
  shortName: string;
  color?: PropColor;
  tile: Tile;
  /** Tiles a multi-tile prop covers in addition to `tile` (a gate spans two). */
  extraTiles?: Tile[];
  /** How many helpers it takes to carry (1 or 2); undefined = not carriable. */
  weight?: 1 | 2;
  state?: {
    open?: boolean; // gate
    laid?: boolean; // plank laid as a bridge
    carriedBy?: HelperId | HelperId[] | null;
  };
}

export interface Helper {
  id: HelperId;
  name: string;
  /** Hex colour of the body. */
  color: string;
  /** One line a writer would use: "bright, eager, literal". */
  personality: string;
  tile: Tile;
  carrying?: string | null;
}

export interface Goal {
  /** The prop that must end on the pad. */
  propId: string;
  padId: string;
}

export type PlantedMoment = 'block_water' | 'ask_which' | 'reorder_key' | 'too_heavy' | 'literal_there' | 'negotiate';

export interface Level {
  id: number;
  slug: string;
  name: string;
  width: 12;
  height: 8;
  /** Tiles that are water. A plank laid on a water tile makes it walkable. */
  water: Tile[];
  /** Tiles nothing can enter (tray edge decorations, walls). */
  blocked: Tile[];
  props: Prop[];
  helpers: Helper[];
  goals: Goal[];
  /** The planted moment this level teaches and the line key it must show. */
  planted: { moment: PlantedMoment; lineKey: string };
  /** The intended orders, in sequence, that solve the level (the answer key). */
  answerKey: { orders: Order[]; expectedCards: string[][] };
}

/** What a WHERE pinch pointed at. */
export type Target =
  | { kind: 'prop'; id: string }
  | { kind: 'tile'; tile: Tile }
  | { kind: 'water'; tile: Tile };

export interface Order {
  who: HelperId;
  /** A prop id, a shortName (possibly ambiguous), or null for "come here". */
  what: string | null;
  where: Target;
}

export type Verb =
  | 'walk'
  | 'pick_up'
  | 'put_down'
  | 'lay_plank'
  | 'pick_key'
  | 'open_gate'
  | 'lift_together'
  | 'carry_together'
  | 'ask'
  | 'wait';

export interface Step {
  verb: Verb;
  /** Two words shown on the plan card, e.g. "walk", "pick up", "lay plank". */
  label: string;
  by: HelperId | HelperId[];
  /** Prop acted on, if any. */
  propId?: string;
  /** Destination tile for walks and put-downs. */
  tile?: Tile;
  /** Path for walks (tile by tile), filled by the planner. */
  path?: Tile[];
}

export type PlanResult =
  | { kind: 'plan'; steps: Step[]; lineKey?: string }
  | { kind: 'ask'; question: string; candidates: string[]; lineKey: string }
  | {
      kind: 'blocked';
      at: Tile;
      reason: 'water' | 'gate' | 'heavy' | 'literal' | 'unreachable';
      lineKey: string;
      /** The steps that can run before the block (walk up to the bank). */
      steps: Step[];
    };

/** Mutable runtime state of a level: positions and prop states change as steps run. */
export interface LevelState {
  level: Level;
  helpers: Record<HelperId, Helper>;
  props: Record<string, Prop>;
  /** Water tiles that now carry a plank (walkable). */
  bridges: Tile[];
  /** Number of questions the helpers asked so far (for the result card). */
  questions: number;
  /** Steps completed so far (for the result card). */
  stepsDone: number;
}

export interface ValidationResult {
  ok: boolean;
  /** First illegal step index and a plain reason, for the model's retry. */
  error?: { index: number; reason: string };
}

/** A line of table talk or a planted line. */
export interface Line {
  who: HelperId;
  text: string;
}
