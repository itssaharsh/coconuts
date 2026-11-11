// The reel format: what the Director (authored or model) may ask the stage to do. Pure data and checks, no rendering,
// so the same file validates reels in the browser, in tests and in the reel function.
import type { PropId } from '../foley/types.js';

export const VERBS = [
  'idle', 'walk', 'run', 'jump', 'flinch', 'stagger', 'fall', 'faint', 'getup', 'block', 'chop', 'slash', 'stab', 'punch',
  'kick', 'pickup', 'throw', 'drink', 'knock', 'cheer', 'sit', 'stand', 'sitfloor', 'sleep', 'cast', 'zap', 'dodge',
  'guard', 'awaken', 'collapse', 'rise',
] as const;
export type Verb = (typeof VERBS)[number];

export const EMOTES = ['!', '?', 'zzz', 'heart', 'skull', 'note', 'angry', 'sweat', 'idea'] as const;
export type Emote = (typeof EMOTES)[number];

/** grow / shrink: the toy theatre bursts to the size of the wall in front of the player, and comes back. */
export const FX = ['lightning', 'rain', 'rainstop', 'dark', 'light', 'shake', 'dust', 'sparkle', 'grow', 'shrink'] as const;
export type Fx = (typeof FX)[number];

export const CHARACTERS = [
  'knight', 'barbarian', 'mage', 'rogue', 'rogue_hooded', 'skeleton_warrior', 'skeleton_minion', 'skeleton_rogue', 'skeleton_mage',
] as const;
export type CharacterId = (typeof CHARACTERS)[number];

/** Animals and monsters: each has its own rig and a handful of clips, and takes the same beats as a character. */
export const BEASTS = ['wolf', 'spider', 'rat', 'stag', 'bull'] as const;
export type BeastId = (typeof BEASTS)[number];
export type PerformerId = CharacterId | BeastId;
export const isBeast = (c: string): c is BeastId => (BEASTS as readonly string[]).includes(c);

/** Sounds the stage makes by itself (the player's props make the rest). */
export type StageCue = 'curtain' | 'creak' | 'whinny' | 'clang' | 'applause' | 'boing' | 'thud' | 'step';

export const TINT_NAMES = ['amber', 'blue', 'red', 'green', 'plain'] as const;
export type Tint = (typeof TINT_NAMES)[number];

export const PROPS: PropId[] = ['coconuts', 'door', 'bell', 'thunder', 'whistle', 'glass'];

export const ITEMS = [
  'sword_1handed', 'staff', 'wand', 'dagger', 'crossbow_1handed', 'mug', 'skeleton_blade', 'skeleton_axe', 'skeleton_staff',
  'skeleton_crossbow', 'shield_round', 'spellbook', 'skeleton_shield_small',
];

export const FACINGS = ['audience', 'upstage', 'left', 'right'];

/**
 * Marks every set has without listing them: the stage works them out. door_side and window_side stand beside the
 * door and the window; duel_a / duel_b face each other across the middle; front_* and aside_* are the clear places
 * downstage and in the front corners.
 */
export const DERIVED_MARKS = ['door_side', 'window_side', 'duel_a', 'duel_b', 'front_left', 'front_right', 'aside_left', 'aside_right', 'lair'];

/** A place on the stage: a named mark of the set, or the wings. */
export type Mark = string;
export type Side = 'left' | 'right';

export type Beat =
  /** An intertitle card, full frame, at most eight words; `sub` is a smaller second line. */
  | { k: 'title'; text: string; sub?: string; secs?: number }
  | { k: 'wait'; secs: number }
  /** `face` (here and below): a mark, an actor, or one of audience | upstage | left | right. */
  | { k: 'enter'; who: string; from: Side | 'door'; to: Mark; gait?: 'walk' | 'run'; face?: string }
  | { k: 'move'; who: string; to: Mark; gait?: 'walk' | 'run'; face?: string }
  /** Leave by the wings, or through a part of the set (door, window): the actor goes to that mark and is gone. */
  | { k: 'exit'; who: string; to: Side | Mark; gait?: 'walk' | 'run' }
  | { k: 'do'; who: string; verb: Verb; face?: string; secs?: number }
  /** Take a kit item in hand, or lose it. */
  | { k: 'item'; who: string; item: string; hold: boolean }
  | { k: 'emote'; who: string; emote: Emote }
  /** A hinged part of the set: the door unless `part` names another (chest_lid). A door opens away from the audience unless `toward`. */
  | { k: 'door'; open: boolean; part?: string; toward?: boolean }
  | { k: 'fx'; fx: Fx }
  | { k: 'tint'; tint: Tint }
  /** Beats that play together (two actors moving at once). */
  | { k: 'par'; beats: Beat[] }
  /**
   * The action waits for a sound. `prop` is the sound it wants; the stage holds for up to `hold` seconds.
   * hit: the wanted prop sounded. wrong: another prop sounded (optional; falls back to a stock reaction, then keeps waiting).
   * miss: nobody played.
   */
  | {
      k: 'cue';
      prop: PropId;
      label: string;
      who?: string;
      hold?: number;
      /** The sound is wanted this many times (three knocks); `each` plays on every one of them, `hit` after the last. */
      times?: number;
      each?: Beat[];
      hit: Beat[];
      wrong?: Partial<Record<PropId, Beat[]>>;
      /** What happens when nobody plays; left out, the story goes on as `hit` does (unscored). */
      miss?: Beat[];
    }
  /** The rider goes as fast as the clops come and stands still without them. `need` clops is a hit; `secs` is how much silence the ride forgives. */
  | { k: 'ride'; who: string; label: string; need: number; secs: number; /** Beasts that run after the horse: they gain when the hooves slow. */ pursuers?: string[]; hit: Beat[]; miss: Beat[] }
  /** The stage freezes on a question; whichever prop sounds picks the branch. */
  | { k: 'open'; prompt: string; hold?: number; branches: Partial<Record<PropId, { title: string; flag?: string; beats: Beat[] }>>; miss: Beat[] }
  /** Close the curtain, change the set and the cast behind it, open again. */
  | { k: 'scene'; set: string; tint?: Tint; cast?: CastEntry[] }
  | { k: 'flag'; set: string };

export interface CastEntry {
  /** The name beats use ("hero", "butler"). */
  id: string;
  char: PerformerId;
  /** Where the actor stands when the curtain opens; omit to keep them in the wings. */
  at?: Mark;
  /** A kit item in the hand (sword_1handed, staff, mug ...); `items` when both hands are full (sword and shield). */
  item?: string;
  items?: string[];
  /** Mounted on the horse. */
  mounted?: boolean;
  /** A pose held from the moment the curtain opens: asleep on the floor, sitting. */
  pose?: 'sleep' | 'sit' | 'sitfloor' | 'guard';
  /** Snores: a Zzz floats up now and then while the pose lasts. */
  zzz?: boolean;
}

export interface Reel {
  id: string;
  title: string;
  set: string;
  tint: Tint;
  cast: CastEntry[];
  beats: Beat[];
  /** The line on the card that ends the reel. */
  cliffhanger: string;
}

export interface SetInfo {
  id: string;
  marks: Record<string, [number, number]>;
  kind?: 'interior' | 'exterior';
  sky?: 'night' | 'day' | 'dusk' | 'storm' | 'dark';
}

const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

/** Every problem with a reel, empty when it can be played. `sets` gives the marks each set has. */
export function validateReel(reel: Reel, sets: Record<string, SetInfo>): string[] {
  const errs: string[] = [];
  let set = sets[reel.set];
  if (!set) errs.push(`set ${reel.set} is not in the catalogue`);
  if (!(TINT_NAMES as readonly string[]).includes(reel.tint)) errs.push(`tint ${reel.tint} unknown`);
  let cast = new Map<string, CastEntry>();
  const addCast = (list: CastEntry[], at: string) => {
    cast = new Map();
    for (const c of list) {
      if (cast.has(c.id)) errs.push(`${at}: cast id ${c.id} twice`);
      if (!(CHARACTERS as readonly string[]).includes(c.char) && !isBeast(c.char)) errs.push(`${at}: character ${c.char} unknown`);
      if (c.at && set && !set.marks[c.at]) errs.push(`${at}: mark ${c.at} is not in set ${set.id}`);
      for (const item of c.items ?? (c.item ? [c.item] : [])) if (!ITEMS.includes(item)) errs.push(`${at}: item ${item} unknown`);
      cast.set(c.id, c);
    }
    if (list.length > 5) errs.push(`${at}: more than five actors on stage`);
  };
  addCast(reel.cast, 'cast');
  const mark = (m: string, at: string) => {
    if (set && !set.marks[m] && !cast.has(m)) errs.push(`${at}: mark ${m} is not in set ${set.id}`);
  };
  const facing = (m: string | undefined, at: string) => {
    if (m && !FACINGS.includes(m)) mark(m, at);
  };
  const who = (w: string, at: string) => {
    if (!cast.has(w)) errs.push(`${at}: ${w} is not in the cast`);
  };
  let cues = 0;
  let opens = 0;
  const walk = (beats: Beat[], path: string, depth: number) => {
    if (depth > 4) {
      errs.push(`${path}: nested too deep`);
      return;
    }
    beats.forEach((b, i) => {
      const at = `${path}[${i}] ${b.k}`;
      switch (b.k) {
        case 'title':
          if (!b.text || words(b.text) > 8) errs.push(`${at}: an intertitle has one to eight words`);
          if (b.sub && words(b.sub) > 10) errs.push(`${at}: the second line has at most ten words`);
          break;
        case 'wait':
          if (!(b.secs > 0 && b.secs <= 6)) errs.push(`${at}: wait is 0 to 6 seconds`);
          break;
        case 'enter':
          who(b.who, at);
          mark(b.to, at);
          facing(b.face, at);
          break;
        case 'move':
          who(b.who, at);
          mark(b.to, at);
          facing(b.face, at);
          break;
        case 'exit':
          who(b.who, at);
          if (b.to !== 'left' && b.to !== 'right') mark(b.to, at);
          break;
        case 'item':
          who(b.who, at);
          if (!ITEMS.includes(b.item)) errs.push(`${at}: item ${b.item} unknown`);
          break;
        case 'do':
          who(b.who, at);
          if (!(VERBS as readonly string[]).includes(b.verb)) errs.push(`${at}: verb ${b.verb} unknown`);
          facing(b.face, at);
          break;
        case 'emote':
          who(b.who, at);
          if (!(EMOTES as readonly string[]).includes(b.emote)) errs.push(`${at}: emote ${b.emote} unknown`);
          break;
        case 'fx':
          if (!(FX as readonly string[]).includes(b.fx)) errs.push(`${at}: fx ${b.fx} unknown`);
          break;
        case 'tint':
          if (!(TINT_NAMES as readonly string[]).includes(b.tint)) errs.push(`${at}: tint ${b.tint} unknown`);
          break;
        case 'par':
          walk(b.beats, at, depth + 1);
          break;
        case 'cue':
          cues++;
          if (!PROPS.includes(b.prop)) errs.push(`${at}: prop ${b.prop} unknown`);
          if (!b.label || words(b.label) > 5) errs.push(`${at}: a cue label has one to five words`);
          if (b.who) who(b.who, at);
          if (b.times !== undefined && !(b.times >= 1 && b.times <= 6)) errs.push(`${at}: a cue wants its sound one to six times`);
          if (b.each) walk(b.each, `${at}.each`, depth + 1);
          walk(b.hit, `${at}.hit`, depth + 1);
          if (b.miss) walk(b.miss, `${at}.miss`, depth + 1);
          for (const [p, list] of Object.entries(b.wrong ?? {})) {
            if (!PROPS.includes(p as PropId)) errs.push(`${at}: wrong-sound prop ${p} unknown`);
            walk(list ?? [], `${at}.wrong.${p}`, depth + 1);
          }
          break;
        case 'ride':
          cues++;
          who(b.who, at);
          if (!(b.need >= 3 && b.need <= 40)) errs.push(`${at}: a ride needs 3 to 40 clops`);
          for (const p of b.pursuers ?? []) who(p, at);
          if (!(b.secs >= 4 && b.secs <= 60)) errs.push(`${at}: a ride lasts 4 to 60 seconds`);
          walk(b.hit, `${at}.hit`, depth + 1);
          walk(b.miss, `${at}.miss`, depth + 1);
          break;
        case 'open': {
          opens++;
          if (!b.prompt || words(b.prompt) > 8) errs.push(`${at}: the question has one to eight words`);
          const keys = Object.keys(b.branches);
          if (keys.length < 2) errs.push(`${at}: an open moment needs at least two branches`);
          for (const p of keys) {
            if (!PROPS.includes(p as PropId)) errs.push(`${at}: branch prop ${p} unknown`);
            const br = b.branches[p as PropId]!;
            if (!br.title || words(br.title) > 8) errs.push(`${at}.${p}: the branch title has one to eight words`);
            walk(br.beats, `${at}.${p}`, depth + 1);
          }
          walk(b.miss, `${at}.miss`, depth + 1);
          break;
        }
        case 'scene':
          set = sets[b.set];
          if (!set) errs.push(`${at}: set ${b.set} is not in the catalogue`);
          if (b.cast) addCast(b.cast, at);
          break;
        case 'door':
        case 'flag':
          break;
        default:
          errs.push(`${at}: unknown beat`);
      }
    });
  };
  walk(reel.beats, 'beats', 0);
  if (cues + opens < 2) errs.push('a reel needs at least two moments that wait for a sound');
  if (!reel.cliffhanger || words(reel.cliffhanger) > 10) errs.push('the cliffhanger line has one to ten words');
  return errs;
}
