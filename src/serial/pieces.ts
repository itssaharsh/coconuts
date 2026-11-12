// Pieces: the stock scenes a reel is assembled from. The Director (a person, or the model behind /api/reel) does not
// write beats; it writes a plan: which sets, who is in them, which pieces in which order, and the words on the cards.
// Every piece is staged here once, by hand, and waits for exactly one kind of sound, so any plan that passes
// `checkPlan` plays, reads on the stage and gives the player something to do.
// (.js on the relative imports: /api/reel runs this file as plain ESM on Node, which needs the extension; Vite and tsc map it to the .ts)
import type { PropId } from '../foley/types.js';
import { type Beat, type CastEntry, CHARACTERS, type CharacterId, DERIVED_MARKS, type Reel, type Side, type Tint, TINT_NAMES } from './schema.js';

export const SET_IDS = ['gate', 'vault', 'graveyard', 'inn', 'hall', 'camp', 'market', 'road', 'road-forest', 'road-village'] as const;
export type SetId = (typeof SET_IDS)[number];

/** What each set offers a piece: its film stock, a door, a window, where a sleeper lies, where the dead rise. */
export const SETS: Record<SetId, { tint: Tint; door?: boolean; window?: boolean; sleep?: [string, 'sleep' | 'sitfloor']; graves?: string[]; road?: boolean; about: string }> = {
  gate: { tint: 'blue', door: true, sleep: ['guard', 'sitfloor'], about: 'a castle gate at night: a wall with an arched door, torches, barrels where a guard dozes' },
  vault: { tint: 'amber', door: true, window: true, sleep: ['chest', 'sleep'], about: 'a torch-lit treasury: a chest of gold, a door, a barred window, a table' },
  graveyard: { tint: 'blue', sleep: ['grave_b', 'sleep'], graves: ['grave_a', 'grave_c', 'grave_b'], about: 'a graveyard at night: tombstones, a dead tree, a crypt, three graves the dead can rise from' },
  inn: { tint: 'amber', door: true, sleep: ['table_l', 'sitfloor'], about: 'a tavern: a bar with kegs, two tables, a door' },
  hall: { tint: 'amber', door: true, sleep: ['dais_right', 'sitfloor'], about: 'a throne room: a throne on a dais, banners, braziers, a door' },
  camp: { tint: 'red', sleep: ['log', 'sitfloor'], about: 'a forest clearing at night: a campfire, a log, a tent' },
  market: { tint: 'plain', door: true, window: true, sleep: ['stall_r', 'sitfloor'], about: 'a village market square at noon, the one sunny place: house fronts with a door and a window, striped stalls, bunting, a cart' },
  road: { tint: 'blue', road: true, about: 'an open road at night (only the ride piece plays here)' },
  'road-forest': { tint: 'green', road: true, about: 'a forest road (only the ride piece plays here)' },
  'road-village': { tint: 'plain', road: true, about: 'a village road by day (only the ride piece plays here)' },
};

export type PiecePlan =
  /** A plain intertitle. */
  | { piece: 'card'; line: string; sub?: string }
  /** Someone walks on. */
  | { piece: 'arrive'; who: string; from?: Side; line?: string }
  /** The ride: only on a road set; the horse runs on the player's coconuts. With `wolves`, a pack runs after it and gains whenever the hooves slow. */
  | { piece: 'ride'; who: string; line?: string; clops?: number; wolves?: boolean }
  /** `who` knocks (the player knocks for them) and `opener` answers the door. Needs a door. */
  | { piece: 'knock'; who: string; opener: string; line?: string }
  /** `sleeper` is asleep when the curtain opens; any sound wakes them, each in its own way. */
  | { piece: 'wake'; who: string; sleeper: string }
  /** A duel: each blow waits for the bell. */
  | { piece: 'duel'; a: string; b: string; blows?: number; loser?: 'a' | 'b' }
  /** Thunder. In the graveyard the `risers` climb out of their graves. */
  | { piece: 'storm'; line?: string; risers?: string[] }
  /** Glass: with a window, `who` leaps through it and is gone; without, a bottle breaks and everyone jumps. */
  | { piece: 'smash'; who: string }
  /** `who` whistles and `comes` runs on. */
  | { piece: 'whistle'; who: string; comes: string }
  /** `who` bolts for the door and the player slams it in their face. Needs a door. */
  | { piece: 'slam'; who: string }
  /** `runner` flees across the stage and off; `chaser` goes after. */
  | { piece: 'chase'; runner: string; chaser: string }
  /** The bell for a toast or last orders: everyone on stage cheers. */
  | { piece: 'toast'; line?: string }
  /** A monster comes out of the dark and `hero` fights it: thunder drives it back, the bell rings two blows, glass finishes it. */
  | { piece: 'boss'; hero: string; beast?: 'spider' | 'bull' | 'wolf'; line?: string };

export interface ScenePlan {
  set: SetId;
  tint?: Tint;
  cast: { id: string; char: CharacterId; items?: string[] }[];
  pieces: PiecePlan[];
}

export interface ReelPlan {
  title: string;
  scenes: ScenePlan[];
  cliffhanger: string;
}

/** One way the story could go next; the player picks it by sounding its prop (or by saying something else). */
export interface Pitch {
  prop: PropId;
  text: string;
}

const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

/** Names an actor may not take: a beat that says "to the door" must mean the door, not an actor called door. */
const RESERVED = new Set([
  ...DERIVED_MARKS,
  'door', 'window', 'centre', 'left', 'right', 'table', 'chest', 'bar', 'behind_bar', 'table_l', 'table_r', 'throne', 'dais_left', 'dais_right',
  'fire', 'log', 'cart', 'tree', 'grave_a', 'grave_b', 'grave_c', 'upstage_left', 'upstage_right', 'wings_left', 'wings_right', 'audience', 'upstage',
  'monster', 'wolf_a', 'wolf_b',
]);
const PIECES = ['card', 'arrive', 'ride', 'knock', 'wake', 'duel', 'storm', 'smash', 'whistle', 'slam', 'chase', 'toast', 'boss'];
const BOSSES = ['spider', 'bull', 'wolf'];
/** Pieces that wait for a sound (a reel needs at least two). */
const SOUNDING = new Set(['ride', 'knock', 'wake', 'duel', 'storm', 'smash', 'whistle', 'slam', 'toast', 'boss']);

/** Every problem with a plan, empty when `assemble` can stage it. Plans come from a model: nothing is assumed. */
export function checkPlan(plan: unknown): string[] {
  const errs: string[] = [];
  const p = plan as Partial<ReelPlan> | null;
  if (!p || typeof p !== 'object') return ['the plan is not an object'];
  const line = (s: unknown, max: number, what: string, optional = false) => {
    if (s === undefined && optional) return;
    if (typeof s !== 'string' || !s.trim()) errs.push(`${what}: missing text`);
    else if (words(s) > max) errs.push(`${what}: at most ${max} words`);
    else if (s.length > 80) errs.push(`${what}: too long`);
  };
  line(p.title, 6, 'title');
  line(p.cliffhanger, 10, 'cliffhanger');
  if (!Array.isArray(p.scenes) || p.scenes.length < 1 || p.scenes.length > 3) return [...errs, 'a reel has one to three scenes'];
  let sounding = 0;
  p.scenes.forEach((sc, si) => {
    const at = `scene ${si + 1}`;
    if (!sc || typeof sc !== 'object') return void errs.push(`${at}: not an object`);
    const set = SETS[sc.set as SetId];
    if (!set) return void errs.push(`${at}: unknown set ${String(sc.set)}`);
    if (sc.tint !== undefined && !(TINT_NAMES as readonly string[]).includes(sc.tint)) errs.push(`${at}: unknown tint ${String(sc.tint)}`);
    if (!Array.isArray(sc.cast) || sc.cast.length < 1 || sc.cast.length > 4) return void errs.push(`${at}: one to four actors`);
    const ids = new Set<string>();
    for (const c of sc.cast) {
      if (!c || typeof c.id !== 'string' || !/^[a-z][a-z0-9_]{0,15}$/.test(c.id)) errs.push(`${at}: an actor id is a short lowercase word`);
      else if (RESERVED.has(c.id)) errs.push(`${at}: an actor cannot be called ${c.id} (that is a place on the stage)`);
      else if (ids.has(c.id)) errs.push(`${at}: actor ${c.id} twice`);
      else ids.add(c.id);
      if (!c || !(CHARACTERS as readonly string[]).includes(c.char)) errs.push(`${at}: unknown character ${String(c?.char)}`);
    }
    if (!Array.isArray(sc.pieces) || sc.pieces.length < 1 || sc.pieces.length > 5) return void errs.push(`${at}: one to five pieces`);
    const who = (id: unknown, what: string) => {
      if (typeof id !== 'string' || !ids.has(id)) errs.push(`${at} ${what}: ${String(id)} is not in this scene's cast`);
    };
    let wakes = 0;
    sc.pieces.forEach((pc, pi) => {
      const w = `piece ${pi + 1}`;
      if (!pc || typeof pc !== 'object' || !PIECES.includes(pc.piece)) return void errs.push(`${at} ${w}: unknown piece ${String(pc?.piece)}`);
      if (SOUNDING.has(pc.piece)) sounding++;
      if (set.road && pc.piece !== 'ride' && pc.piece !== 'card') errs.push(`${at} ${w}: only the ride and cards play on a road`);
      switch (pc.piece) {
        case 'card':
          line(pc.line, 8, `${at} ${w} line`);
          line(pc.sub, 10, `${at} ${w} sub`, true);
          break;
        case 'arrive':
          who(pc.who, w);
          line(pc.line, 8, `${at} ${w} line`, true);
          break;
        case 'ride':
          if (!set.road) errs.push(`${at} ${w}: the ride needs a road set`);
          who(pc.who, w);
          line(pc.line, 8, `${at} ${w} line`, true);
          if (pc.clops !== undefined && !(pc.clops >= 6 && pc.clops <= 16)) errs.push(`${at} ${w}: six to sixteen clops`);
          if (pc.wolves !== undefined && typeof pc.wolves !== 'boolean') errs.push(`${at} ${w}: wolves is true or false`);
          break;
        case 'knock':
          if (!set.door) errs.push(`${at} ${w}: this set has no door`);
          who(pc.who, w);
          who(pc.opener, w);
          if (pc.who === pc.opener) errs.push(`${at} ${w}: nobody answers their own knock`);
          line(pc.line, 8, `${at} ${w} line`, true);
          break;
        case 'wake':
          if (!set.sleep) errs.push(`${at} ${w}: nowhere to sleep in this set`);
          if (pi !== 0 || ++wakes > 1) errs.push(`${at} ${w}: a sleeper is found first, and only one a scene`);
          who(pc.who, w);
          who(pc.sleeper, w);
          if (pc.who === pc.sleeper) errs.push(`${at} ${w}: two different actors`);
          break;
        case 'duel':
          who(pc.a, w);
          who(pc.b, w);
          if (pc.a === pc.b) errs.push(`${at} ${w}: two different actors`);
          if (pc.blows !== undefined && !(pc.blows >= 1 && pc.blows <= 3)) errs.push(`${at} ${w}: one to three blows`);
          break;
        case 'storm':
          line(pc.line, 8, `${at} ${w} line`, true);
          for (const r of pc.risers ?? []) who(r, w);
          if ((pc.risers?.length ?? 0) > (set.graves?.length ?? 0)) errs.push(`${at} ${w}: the dead rise only from the graveyard's three graves`);
          break;
        case 'smash':
        case 'slam':
          if (pc.piece === 'slam' && !set.door) errs.push(`${at} ${w}: this set has no door`);
          who(pc.who, w);
          break;
        case 'whistle':
          who(pc.who, w);
          who(pc.comes, w);
          if (pc.who === pc.comes) errs.push(`${at} ${w}: two different actors`);
          break;
        case 'chase':
          who(pc.runner, w);
          who(pc.chaser, w);
          if (pc.runner === pc.chaser) errs.push(`${at} ${w}: two different actors`);
          break;
        case 'toast':
          line(pc.line, 8, `${at} ${w} line`, true);
          break;
        case 'boss':
          who(pc.hero, w);
          if (pc.beast !== undefined && !BOSSES.includes(pc.beast)) errs.push(`${at} ${w}: the beast is a spider, a bull or a wolf`);
          if (sc.pieces.filter((x) => x?.piece === 'boss').length > 1) errs.push(`${at} ${w}: one monster a scene`);
          line(pc.line, 8, `${at} ${w} line`, true);
          break;
      }
    });
  });
  if (sounding < 2) errs.push('a reel needs at least two pieces that wait for a sound');
  if (sounding > 7) errs.push('at most seven pieces that wait for a sound');
  return errs;
}

/** What a sleeper does with each sound. */
function wakes(s: string, set: SetId): Extract<Beat, { k: 'open' }>['branches'] {
  const info = SETS[set];
  const up: Beat = { k: 'do', who: s, verb: 'getup' };
  return {
    bell: { title: 'A bell! “Supper?”', flag: 'woke_hungry', did: `woke ${s}, who thought it was supper`, beats: [up, { k: 'emote', who: s, emote: 'heart' }, { k: 'do', who: s, verb: 'cheer', face: 'audience' }] },
    thunder: {
      title: 'Thunder! A fright!',
      flag: 'woke_scared',
      did: `woke ${s} with a fright`,
      beats: [{ k: 'fx', fx: 'lightning' }, up, { k: 'do', who: s, verb: 'flinch' }, { k: 'emote', who: s, emote: 'sweat' }],
    },
    glass: { title: 'Glass! “Burglars!”', flag: 'woke_alert', did: `woke ${s}, who shouted burglars`, beats: [up, { k: 'emote', who: s, emote: 'angry' }, { k: 'do', who: s, verb: 'guard', face: 'audience', secs: 1.2 }] },
    door: info.door
      ? {
          title: 'A knock. “Come in!”',
          flag: 'woke_polite',
          did: `woke ${s}, who went to answer the door`,
          beats: [up, { k: 'move', who: s, to: 'door_side', face: 'door' }, { k: 'door', open: true }, { k: 'emote', who: s, emote: '?' }, { k: 'door', open: false }],
        }
      : { title: 'A knock? Out here?', flag: 'woke_polite', did: `woke ${s}, who wondered who knocks out here`, beats: [up, { k: 'emote', who: s, emote: '?' }, { k: 'do', who: s, verb: 'idle', face: 'left', secs: 0.8 }] },
    coconuts: { title: 'Hooves! “The Duke!”', flag: 'woke_fooled', did: `woke ${s}, who thought the Duke had come`, beats: [up, { k: 'do', who: s, verb: 'cheer', face: 'audience' }, { k: 'emote', who: s, emote: 'sweat' }] },
    whistle: { title: 'A tune. A little dance.', flag: 'woke_merry', did: `woke ${s}, who danced to it`, beats: [up, { k: 'emote', who: s, emote: 'note' }, { k: 'do', who: s, verb: 'cheer', face: 'audience' }, { k: 'do', who: s, verb: 'jump' }] },
  };
}

/** Turn a checked plan into a reel the player can run. Throws on a plan `checkPlan` would reject. */
export function assemble(plan: ReelPlan, id: string): Reel {
  const errs = checkPlan(plan);
  if (errs.length) throw new Error(`plan rejected: ${errs.slice(0, 3).join('; ')}`);
  const beats: Beat[] = [];
  let first: { set: SetId; tint: Tint; cast: CastEntry[] } | null = null;

  for (const sc of plan.scenes) {
    const info = SETS[sc.set];
    const tint = sc.tint ?? info.tint;
    // Staging keeps a little book: who is on the stage, on which mark, and who is lying down. Every piece asks the
    // book for a free spot, so nobody stands on (or in front of) anybody else.
    const at = new Map<string, string>();
    const down = new Set<string>();
    const cast: CastEntry[] = sc.cast.map((c) => ({ id: c.id, char: c.char, ...(c.items?.length ? { items: c.items } : {}) }));
    const entry = (cid: string) => cast.find((c) => c.id === cid)!;
    // who is already in place when the curtain opens
    const lead = sc.pieces[0];
    if (lead.piece === 'ride') {
      Object.assign(entry(lead.who), { mounted: true, at: 'centre' });
      at.set(lead.who, 'centre');
      // the pack waits in the wings until the ride begins
      if (lead.wolves) cast.push({ id: 'wolf_a', char: 'wolf' }, { id: 'wolf_b', char: 'wolf' });
    }
    if (lead.piece === 'wake' && info.sleep) {
      Object.assign(entry(lead.sleeper), { at: info.sleep[0], pose: info.sleep[1], zzz: true });
      at.set(lead.sleeper, info.sleep[0]);
      down.add(lead.sleeper);
    }
    // the monster waits in the wings under the name "monster" (its mark is the lair: a name must never be both)
    const monster = sc.pieces.find((p) => p.piece === 'boss') as Extract<PiecePlan, { piece: 'boss' }> | undefined;
    // (the spider was built as a giant; a bull or a wolf has to grow into the part)
    if (monster) cast.push({ id: 'monster', char: monster.beast ?? 'spider', ...(monster.beast && monster.beast !== 'spider' ? { size: 1.7 } : {}) });
    const storm = sc.pieces.find((p) => p.piece === 'storm') as Extract<PiecePlan, { piece: 'storm' }> | undefined;
    (storm?.risers ?? []).forEach((r, i) => {
      if (at.has(r) || !info.graves) return;
      Object.assign(entry(r), { at: info.graves[i], pose: 'sleep' });
      at.set(r, info.graves[i]);
      down.add(r);
    });
    const scene: Beat[] = [];
    let side: Side = 'left';
    const taken = (mark: string, by?: string) => [...at].some(([who, m]) => m === mark && who !== by);
    /** The first of these marks nobody else stands on (the first of all when every one is taken). */
    const free = (marks: string[], by?: string) => marks.find((m) => !taken(m, by)) ?? marks[0];
    /** Bring an actor to a mark: on from the wings if they are off, across the stage if they are on. */
    const bring = (who: string, to: string | string[], opts: { face?: string; gait?: 'walk' | 'run'; from?: Side } = {}): Beat => {
      const mark = typeof to === 'string' ? to : free(to, who);
      const extra = { ...(opts.gait ? { gait: opts.gait } : {}), ...(opts.face ? { face: opts.face } : {}) };
      if (at.has(who)) {
        at.set(who, mark);
        return { k: 'move', who, to: mark, ...extra };
      }
      at.set(who, mark);
      const from = opts.from ?? side;
      side = from === 'left' ? 'right' : 'left';
      return { k: 'enter', who, from, to: mark, ...extra };
    };
    /** Walk everyone who is not part of the action (and can walk) off these marks, to the sides of the stage. */
    const clear = (marks: string[], except: string[], toward: string[] = ['aside_left', 'aside_right', 'front_left', 'front_right']): void => {
      const moves: Beat[] = [];
      for (const [who, m] of [...at]) {
        if (except.includes(who) || down.has(who) || !marks.includes(m)) continue;
        moves.push(bring(who, toward.filter((t) => !marks.includes(t)), { face: 'centre' }));
      }
      if (moves.length) scene.push(moves.length === 1 ? moves[0] : { k: 'par', beats: moves });
    };
    const leave = (who: string, to: Side | string, gait: 'walk' | 'run' = 'run'): Beat => {
      at.delete(who);
      down.delete(who);
      return { k: 'exit', who, to, gait };
    };
    const standing = () => [...at.keys()].filter((x) => !down.has(x));
    const FRONT = ['front_left', 'front_right', 'aside_left', 'aside_right'];

    for (const pc of sc.pieces) {
      switch (pc.piece) {
        case 'card':
          scene.push({ k: 'title', text: pc.line, ...(pc.sub ? { sub: pc.sub } : {}), secs: pc.sub ? 2.8 : 2.2 });
          break;
        case 'arrive':
          if (pc.line) scene.push({ k: 'title', text: pc.line, secs: 2.2 });
          scene.push(bring(pc.who, pc.from === 'right' ? ['front_right', 'aside_right', 'front_left'] : ['front_left', 'aside_left', 'front_right'], { from: pc.from }));
          break;
        case 'ride':
          scene.push({ k: 'title', text: pc.line ?? 'Ride! Ride!', secs: 2 });
          scene.push({
            k: 'ride',
            who: pc.who,
            label: pc.wolves ? 'Clop! Outrun them!' : 'Clop the coconuts',
            did: pc.wolves ? `carried ${pc.who} ahead of the wolves` : `carried ${pc.who} down the road`,
            need: pc.clops ?? 8,
            secs: 22,
            ...(pc.wolves ? { pursuers: ['wolf_a', 'wolf_b'] } : {}),
            hit: [{ k: 'wait', secs: 0.5 }],
            miss: [{ k: 'title', text: 'The horse walked.', sub: 'It took all night.', secs: 2.2 }],
          });
          break;
        case 'knock': {
          // doors are stage left: whoever is not knocking waits on the other side, where they hide nothing
          clear(['door_side', 'door', 'front_left', 'aside_left', 'left'], [pc.who, pc.opener], ['front_right', 'aside_right']);
          scene.push(bring(pc.who, 'door_side', { face: 'door' }));
          const answer: Beat[] = [{ k: 'door', open: true }, { k: 'wait', secs: 0.4 }];
          if (at.has(pc.opener)) answer.push({ k: 'move', who: pc.opener, to: 'door', face: pc.who });
          else answer.push({ k: 'enter', who: pc.opener, from: 'door', to: 'door', face: pc.who });
          at.set(pc.opener, 'door');
          down.delete(pc.opener);
          answer.push({ k: 'emote', who: pc.opener, emote: '!' });
          scene.push({
            k: 'cue',
            prop: 'door',
            label: 'Knock for him',
            did: `brought ${pc.opener} to the door`,
            who: pc.who,
            times: 3,
            each: [{ k: 'do', who: pc.who, verb: 'punch', face: 'door', secs: 0.42 }],
            hit: answer,
            miss: [{ k: 'title', text: 'Nobody knocked.', sub: 'The door opens anyway.', secs: 2.2 }, ...answer],
          });
          if (pc.line) scene.push({ k: 'title', text: pc.line, secs: 2.4 });
          // the two of them come down to the front, so the next piece has the door and the middle of the stage
          scene.push({ k: 'par', beats: [bring(pc.who, ['front_right', 'aside_right'], { face: pc.opener }), bring(pc.opener, ['front_left', 'aside_left'], { face: pc.who })] });
          break;
        }
        case 'wake':
          scene.push(bring(pc.who, ['front_right', 'front_left'], { face: pc.sleeper, from: 'right' }));
          scene.push({
            k: 'open',
            prompt: 'What wakes the sleeper?',
            branches: wakes(pc.sleeper, sc.set),
            miss: [{ k: 'title', text: 'The sleeper wakes alone.', sub: '(Nobody made a sound.)', secs: 2.2 }, { k: 'do', who: pc.sleeper, verb: 'getup' }],
          });
          down.delete(pc.sleeper);
          scene.push({ k: 'par', beats: [{ k: 'do', who: pc.sleeper, verb: 'flinch', face: pc.who }, { k: 'emote', who: pc.sleeper, emote: '!' }] });
          break;
        case 'duel': {
          const loser = pc.loser === 'a' ? pc.a : pc.b;
          const winner = loser === pc.a ? pc.b : pc.a;
          // the duel has the middle of the stage to itself: a to the audience's left, b to the right, a sword apart
          clear(['duel_a', 'duel_b', 'centre', 'front_left', 'front_right'], [pc.a, pc.b], ['aside_left', 'aside_right']);
          down.delete(pc.a);
          down.delete(pc.b);
          scene.push({ k: 'par', beats: [bring(pc.a, 'duel_a', { face: pc.b, from: 'left' }), bring(pc.b, 'duel_b', { face: pc.a, from: 'right' })] });
          const blows = pc.blows ?? 2;
          const exchange = (striker: string, other: string, verb: 'chop' | 'stab'): Beat => ({
            k: 'par',
            beats: [{ k: 'do', who: striker, verb, face: other }, { k: 'do', who: other, verb: 'block', face: striker }],
          });
          for (let i = 0; i < blows - 1; i++) {
            const [striker, other] = i % 2 === 0 ? [pc.a, pc.b] : [pc.b, pc.a];
            scene.push({ k: 'cue', prop: 'bell', label: i === 0 ? 'Ring: a blow!' : 'Ring: a parry!', did: `rang the duel of ${pc.a} and ${pc.b}`, who: striker, hold: 9, hit: [exchange(striker, other, i % 2 === 0 ? 'chop' : 'stab')] });
          }
          scene.push({
            k: 'cue',
            prop: 'bell',
            label: 'Ring: the last blow!',
            did: `rang the duel of ${pc.a} and ${pc.b}`,
            who: winner,
            hold: 9,
            hit: [
              { k: 'par', beats: [{ k: 'do', who: winner, verb: 'slash', face: loser }, { k: 'do', who: loser, verb: 'stagger', face: winner }] },
              { k: 'do', who: loser, verb: 'fall' },
              { k: 'do', who: winner, verb: 'cheer', face: 'audience' },
              // the beaten one picks themselves up and runs: the stage is clear for what comes next
              { k: 'do', who: loser, verb: 'getup' },
            ],
          });
          scene.push(leave(loser, loser === pc.a ? 'left' : 'right'));
          break;
        }
        case 'storm': {
          scene.push({ k: 'title', text: pc.line ?? 'A storm breaks.', secs: 2 });
          const risers = (pc.risers ?? []).filter(() => info.graves);
          const up = standing().filter((x) => !risers.includes(x));
          scene.push({
            k: 'cue',
            prop: 'thunder',
            label: 'Shake the thunder',
            did: risers.length ? 'brought the rain and woke the dead' : 'brought the rain',
            hold: 12,
            times: 2,
            // the player's first thunderclap brings the rain down
            each: [{ k: 'fx', fx: 'lightning' }, { k: 'fx', fx: 'rain' }, { k: 'par', beats: up.map((x): Beat => ({ k: 'do', who: x, verb: 'flinch' })) }],
            hit: [
              { k: 'fx', fx: 'rain' },
              { k: 'fx', fx: 'grow' },
              { k: 'fx', fx: 'shake' },
              ...(risers.length
                ? [
                    { k: 'par', beats: risers.map((r): Beat => ({ k: 'do', who: r, verb: 'awaken' })) } as Beat,
                    { k: 'par', beats: [...risers.map((r): Beat => ({ k: 'emote', who: r, emote: 'skull' })), ...up.map((x): Beat => ({ k: 'emote', who: x, emote: '!' }))] } as Beat,
                    { k: 'title', text: 'Your thunder woke the dead.', secs: 2.2 } as Beat,
                  ]
                : [{ k: 'par', beats: up.map((x): Beat => ({ k: 'emote', who: x, emote: 'sweat' })) } as Beat]),
            ],
          });
          for (const r of risers) down.delete(r);
          break;
        }
        case 'smash':
          if (info.window) {
            clear(['window', 'window_side'], [pc.who], ['front_left', 'aside_left']);
            scene.push(bring(pc.who, 'window', { gait: 'run', face: 'window' }));
            scene.push({ k: 'cue', prop: 'glass', label: 'Smash! A leap!', did: `broke the window ${pc.who} leapt through`, who: pc.who, hold: 10, hit: [{ k: 'do', who: pc.who, verb: 'jump', secs: 0.45 }, leave(pc.who, 'window')] });
          } else {
            scene.push(bring(pc.who, FRONT));
            scene.push({
              k: 'cue',
              prop: 'glass',
              label: 'Smash a bottle!',
              did: 'smashed a bottle and made everyone jump',
              who: pc.who,
              hold: 10,
              hit: [{ k: 'do', who: pc.who, verb: 'throw', face: 'audience' }, { k: 'par', beats: standing().filter((x) => x !== pc.who).map((x): Beat => ({ k: 'do', who: x, verb: 'jump' })) }],
            });
          }
          break;
        case 'whistle':
          scene.push(bring(pc.who, ['front_left', 'front_right'], { from: 'left' }));
          scene.push({
            k: 'cue',
            prop: 'whistle',
            label: 'Whistle for help',
            did: `called ${pc.comes} to help`,
            who: pc.who,
            hold: 10,
            hit: [{ k: 'emote', who: pc.who, emote: 'note' }, bring(pc.comes, ['front_right', 'front_left', 'aside_right'], { gait: 'run', face: pc.who, from: 'right' }), { k: 'emote', who: pc.comes, emote: '!' }],
          });
          down.delete(pc.comes);
          break;
        case 'slam':
          clear(['door_side', 'door', 'front_left', 'aside_left', 'left'], [pc.who], ['front_right', 'aside_right']);
          scene.push({ k: 'par', beats: [bring(pc.who, 'door_side', { gait: 'run', face: 'door' }), { k: 'door', open: true }] });
          scene.push({
            k: 'cue',
            prop: 'door',
            label: 'Slam it shut!',
            did: `slammed the door on ${pc.who}`,
            who: pc.who,
            hold: 10,
            hit: [{ k: 'door', open: false }, { k: 'fx', fx: 'shake' }, { k: 'do', who: pc.who, verb: 'stagger' }],
            miss: [{ k: 'title', text: 'The door sticks.', secs: 1.6 }, { k: 'door', open: false }, { k: 'do', who: pc.who, verb: 'stagger' }],
          });
          break;
        case 'chase': {
          scene.push(bring(pc.runner, 'centre', { gait: 'run' }), { k: 'emote', who: pc.runner, emote: 'sweat' });
          const out = side; // the wing the runner did not come from
          scene.push(leave(pc.runner, out));
          scene.push(bring(pc.chaser, 'centre', { gait: 'run' }), { k: 'emote', who: pc.chaser, emote: 'angry' }, leave(pc.chaser, out));
          break;
        }
        case 'boss': {
          // the middle and the back of the stage are the monster's; everyone but the hero keeps to the corners
          {
            // wherever they stood (a stall, a grave, the bar), they run for the corners
            const corners = ['aside_left', 'aside_right'];
            const flee: Beat[] = [];
            for (const [who, m] of [...at]) {
              if (who === pc.hero || down.has(who) || corners.includes(m)) continue;
              flee.push(bring(who, corners, { gait: 'run', face: 'centre' }));
            }
            if (flee.length) scene.push(flee.length === 1 ? flee[0] : { k: 'par', beats: flee });
          }
          scene.push({ k: 'title', text: pc.line ?? 'Something stirs in the dark.', secs: 2.2 });
          scene.push(bring('monster', 'lair', { from: 'right', face: 'audience' }));
          scene.push({ k: 'fx', fx: 'shake' });
          scene.push({ k: 'par', beats: [bring(pc.hero, 'front_left', { face: 'monster', from: 'left' }), ...standing().filter((x) => x !== 'monster').map((x): Beat => ({ k: 'emote', who: x, emote: '!' }))] });
          scene.push({
            k: 'cue',
            prop: 'thunder',
            label: 'Thunder! Drive it back!',
            did: `drove the ${pc.beast ?? 'spider'} back`,
            who: pc.hero,
            hold: 10,
            hit: [{ k: 'fx', fx: 'grow' }, { k: 'fx', fx: 'lightning' }, { k: 'do', who: 'monster', verb: 'flinch' }],
          });
          scene.push({
            k: 'cue',
            prop: 'bell',
            label: 'Ring: a blow!',
            did: `rang the fight with the ${pc.beast ?? 'spider'}`,
            who: pc.hero,
            hold: 9,
            hit: [{ k: 'par', beats: [{ k: 'do', who: pc.hero, verb: 'chop', face: 'monster' }, { k: 'do', who: 'monster', verb: 'stagger' }] }],
          });
          scene.push({
            k: 'cue',
            prop: 'bell',
            label: 'Ring: it strikes!',
            did: `rang the fight with the ${pc.beast ?? 'spider'}`,
            who: pc.hero,
            hold: 9,
            hit: [{ k: 'par', beats: [{ k: 'do', who: 'monster', verb: 'chop', face: pc.hero }, { k: 'do', who: pc.hero, verb: 'block', face: 'monster' }] }],
          });
          scene.push({
            k: 'cue',
            prop: 'glass',
            label: 'Smash! Finish it!',
            did: `finished the ${pc.beast ?? 'spider'}`,
            who: pc.hero,
            hold: 10,
            hit: [
              { k: 'do', who: pc.hero, verb: 'throw', face: 'monster' },
              { k: 'fx', fx: 'shake' },
              { k: 'do', who: 'monster', verb: 'fall' },
              { k: 'do', who: pc.hero, verb: 'cheer', face: 'audience' },
            ],
          });
          down.add('monster');
          break;
        }
        case 'toast':
          if (pc.line) scene.push({ k: 'title', text: pc.line, secs: 2 });
          scene.push({
            k: 'cue',
            prop: 'bell',
            label: 'Ring the bell!',
            did: 'rang for a toast',
            hold: 10,
            hit: [{ k: 'par', beats: standing().map((x): Beat => ({ k: 'do', who: x, verb: 'cheer', face: 'audience' })) }],
          });
          break;
      }
    }
    if (!first) {
      first = { set: sc.set, tint, cast };
      beats.push(...scene);
    } else beats.push({ k: 'scene', set: sc.set, tint, cast }, ...scene);
  }
  return { id, title: plan.title, set: first!.set, tint: first!.tint, cast: first!.cast, beats, cliffhanger: plan.cliffhanger };
}

// ---- the written library: what plays when the Director is not there, and what its plans are measured against

/** After reel one: three ways on, each with a reel written for it. */
export const PITCHES_2: Pitch[] = [
  { prop: 'coconuts', text: 'Ride after the thief' },
  { prop: 'thunder', text: 'A storm in the graveyard' },
  { prop: 'bell', text: 'Ask at the market' },
];

const KNIGHT = { id: 'knight', char: 'knight' as const, items: ['sword_1handed', 'shield_round'] };
const THIEF = { id: 'thief', char: 'rogue_hooded' as const, items: ['dagger'] };

export const WRITTEN: Record<PropId, ReelPlan> = {
  coconuts: {
    title: 'The Chase',
    scenes: [
      { set: 'road-forest', cast: [KNIGHT], pieces: [{ piece: 'ride', who: 'knight', line: 'Wolves on the north road!', clops: 14, wolves: true }] },
      {
        set: 'camp',
        cast: [KNIGHT, THIEF, { id: 'brute', char: 'barbarian' }],
        pieces: [
          { piece: 'wake', who: 'knight', sleeper: 'brute' },
          { piece: 'storm', line: 'The fire spits. The sky answers.' },
          { piece: 'duel', a: 'knight', b: 'brute', blows: 2 },
          { piece: 'chase', runner: 'thief', chaser: 'knight' },
        ],
      },
    ],
    cliffhanger: 'The thief runs for the graveyard.',
  },
  thunder: {
    title: 'The Graveyard Shortcut',
    scenes: [
      {
        set: 'graveyard',
        cast: [KNIGHT, { id: 'bones', char: 'skeleton_warrior', items: ['skeleton_blade'] }, { id: 'rattle', char: 'skeleton_minion' }, THIEF],
        pieces: [
          { piece: 'arrive', who: 'knight', line: 'A shortcut. Through the graveyard.' },
          { piece: 'storm', line: 'The sky growls.', risers: ['bones', 'rattle'] },
          { piece: 'duel', a: 'knight', b: 'bones', blows: 2 },
          { piece: 'whistle', who: 'knight', comes: 'thief' },
          { piece: 'chase', runner: 'thief', chaser: 'knight' },
        ],
      },
    ],
    cliffhanger: 'The dead do not stay down.',
  },
  bell: {
    title: 'Market Day',
    scenes: [
      { set: 'road-village', cast: [KNIGHT], pieces: [{ piece: 'ride', who: 'knight', line: 'To market, at a trot!', clops: 12 }] },
      {
        set: 'market',
        cast: [KNIGHT, { id: 'seller', char: 'barbarian' }, THIEF],
        pieces: [
          { piece: 'wake', who: 'knight', sleeper: 'seller' },
          { piece: 'toast', line: '“Fresh pies! Ring for one!”' },
          { piece: 'card', line: '“A hooded man? He bought my bull.”' },
          { piece: 'boss', hero: 'knight', beast: 'bull', line: 'The bull did not like the price.' },
          { piece: 'chase', runner: 'thief', chaser: 'knight' },
        ],
      },
    ],
    cliffhanger: 'The bull is wearing the crown.',
  },
  // the other props, for the day a pitch is made with them and the Director is away
  door: {
    title: 'The Duke at Home',
    scenes: [
      {
        set: 'hall',
        cast: [KNIGHT, { id: 'duke', char: 'skeleton_mage', items: ['skeleton_staff'] }, { id: 'guard', char: 'skeleton_warrior' }],
        pieces: [
          { piece: 'knock', who: 'knight', opener: 'guard', line: '“The Duke is not at home.”' },
          { piece: 'arrive', who: 'duke', from: 'right', line: 'The Duke was at home.' },
          { piece: 'card', line: '“Meet my pet, sir knight.”' },
          { piece: 'boss', hero: 'knight', beast: 'spider', line: 'Eight legs. No manners.' },
        ],
      },
    ],
    cliffhanger: 'The Duke slips out the back.',
  },
  whistle: {
    title: 'A Friend in Need',
    scenes: [
      {
        set: 'camp',
        cast: [KNIGHT, { id: 'sage', char: 'mage', items: ['staff'] }, { id: 'brute', char: 'barbarian' }],
        pieces: [
          { piece: 'arrive', who: 'knight', line: 'Lost in the forest.' },
          { piece: 'whistle', who: 'knight', comes: 'sage' },
          { piece: 'card', line: '“The thief serves the Duke!”' },
          { piece: 'storm', line: 'The Duke’s storm rolls in.' },
          { piece: 'duel', a: 'knight', b: 'brute', blows: 2 },
        ],
      },
    ],
    cliffhanger: 'The wizard has a plan.',
  },
  glass: {
    title: 'Breaking In',
    scenes: [
      {
        set: 'vault',
        cast: [KNIGHT, THIEF, { id: 'guard', char: 'skeleton_minion' }],
        pieces: [
          { piece: 'wake', who: 'knight', sleeper: 'guard' },
          { piece: 'duel', a: 'knight', b: 'guard', blows: 1 },
          { piece: 'arrive', who: 'thief', from: 'right', line: 'The thief comes home.' },
          { piece: 'slam', who: 'thief' },
          { piece: 'smash', who: 'thief' },
        ],
      },
    ],
    cliffhanger: 'An empty chest. A full moon.',
  },
};

/** A second written reel for a prop: played when that prop is pitched again and the Director is away. */
export const WRITTEN_MORE: Partial<Record<PropId, ReelPlan>> = {
  bell: {
    title: 'Last Orders',
    scenes: [
      {
        set: 'inn',
        cast: [KNIGHT, { id: 'keeper', char: 'barbarian' }, THIEF, { id: 'sage', char: 'mage' }],
        pieces: [
          { piece: 'knock', who: 'knight', opener: 'keeper', line: '“A hooded stranger? Upstairs.”' },
          { piece: 'toast', line: '“A drink first, sir knight!”' },
          { piece: 'arrive', who: 'thief', from: 'right' },
          { piece: 'duel', a: 'knight', b: 'thief', blows: 2 },
          { piece: 'smash', who: 'sage' },
        ],
      },
    ],
    cliffhanger: 'The thief was never the thief.',
  },
};
