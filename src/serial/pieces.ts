// Pieces: the stock scenes a reel is assembled from. The Director (a person, or the model behind /api/reel) does not
// write beats; it writes a plan: which sets, who is in them, which pieces in which order, and the words on the cards.
// Every piece is staged here once, by hand, and waits for exactly one kind of sound, so any plan that passes
// `checkPlan` plays, reads on the stage and gives the player something to do.
// (.js on the relative imports: /api/reel runs this file as plain ESM on Node, which needs the extension; Vite and tsc map it to the .ts)
import type { PropId } from '../foley/types.js';
import { type Beat, type CastEntry, CHARACTERS, type CharacterId, type Reel, type Side, type Tint, TINT_NAMES } from './schema.js';

export const SET_IDS = ['gate', 'vault', 'graveyard', 'inn', 'hall', 'camp', 'road', 'road-forest', 'road-village'] as const;
export type SetId = (typeof SET_IDS)[number];

/** What each set offers a piece: its film stock, a door, a window, where a sleeper lies, where the dead rise. */
export const SETS: Record<SetId, { tint: Tint; door?: boolean; window?: boolean; sleep?: [string, 'sleep' | 'sitfloor']; graves?: string[]; road?: boolean; about: string }> = {
  gate: { tint: 'blue', door: true, sleep: ['guard', 'sitfloor'], about: 'a castle gate at night: a wall with an arched door, torches, barrels where a guard dozes' },
  vault: { tint: 'amber', door: true, window: true, sleep: ['chest', 'sleep'], about: 'a torch-lit treasury: a chest of gold, a door, a barred window, a table' },
  graveyard: { tint: 'blue', sleep: ['grave_b', 'sleep'], graves: ['grave_a', 'grave_c', 'grave_b'], about: 'a graveyard at night: tombstones, a dead tree, a crypt, three graves the dead can rise from' },
  inn: { tint: 'amber', door: true, sleep: ['table_l', 'sitfloor'], about: 'a tavern: a bar with kegs, two tables, a door' },
  hall: { tint: 'amber', door: true, sleep: ['dais_right', 'sitfloor'], about: 'a throne room: a throne on a dais, banners, braziers, a door' },
  camp: { tint: 'red', sleep: ['log', 'sitfloor'], about: 'a forest clearing at night: a campfire, a log, a tent' },
  road: { tint: 'blue', road: true, about: 'an open road at night (only the ride piece plays here)' },
  'road-forest': { tint: 'green', road: true, about: 'a forest road (only the ride piece plays here)' },
  'road-village': { tint: 'plain', road: true, about: 'a village road by day (only the ride piece plays here)' },
};

export type PiecePlan =
  /** A plain intertitle. */
  | { piece: 'card'; line: string; sub?: string }
  /** Someone walks on. */
  | { piece: 'arrive'; who: string; from?: Side; line?: string }
  /** The ride: only on a road set; the horse runs on the player's coconuts. */
  | { piece: 'ride'; who: string; line?: string; clops?: number }
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
  | { piece: 'toast'; line?: string };

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
const PIECES = ['card', 'arrive', 'ride', 'knock', 'wake', 'duel', 'storm', 'smash', 'whistle', 'slam', 'chase', 'toast'];
/** Pieces that wait for a sound (a reel needs at least two). */
const SOUNDING = new Set(['ride', 'knock', 'wake', 'duel', 'storm', 'smash', 'whistle', 'slam', 'toast']);

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
    bell: { title: 'A bell! “Supper?”', flag: 'woke_hungry', beats: [up, { k: 'emote', who: s, emote: 'heart' }, { k: 'do', who: s, verb: 'cheer', face: 'audience' }] },
    thunder: {
      title: 'Thunder! A fright!',
      flag: 'woke_scared',
      beats: [{ k: 'fx', fx: 'lightning' }, up, { k: 'do', who: s, verb: 'flinch' }, { k: 'emote', who: s, emote: 'sweat' }],
    },
    glass: { title: 'Glass! “Burglars!”', flag: 'woke_alert', beats: [up, { k: 'emote', who: s, emote: 'angry' }, { k: 'do', who: s, verb: 'guard', face: 'audience', secs: 1.2 }] },
    door: info.door
      ? {
          title: 'A knock. “Come in!”',
          flag: 'woke_polite',
          beats: [up, { k: 'move', who: s, to: 'door_side', face: 'door' }, { k: 'door', open: true }, { k: 'emote', who: s, emote: '?' }, { k: 'door', open: false }],
        }
      : { title: 'A knock? Out here?', flag: 'woke_polite', beats: [up, { k: 'emote', who: s, emote: '?' }, { k: 'do', who: s, verb: 'idle', face: 'left', secs: 0.8 }] },
    coconuts: { title: 'Hooves! “The Duke!”', flag: 'woke_fooled', beats: [up, { k: 'do', who: s, verb: 'cheer', face: 'audience' }, { k: 'emote', who: s, emote: 'sweat' }] },
    whistle: { title: 'A tune. A little dance.', flag: 'woke_merry', beats: [up, { k: 'emote', who: s, emote: 'note' }, { k: 'do', who: s, verb: 'cheer', face: 'audience' }, { k: 'do', who: s, verb: 'jump' }] },
  };
}

/** Turn a checked plan into a reel the player can run. Throws on a plan `checkPlan` would reject. */
export function assemble(plan: ReelPlan, id: string): Reel {
  const errs = checkPlan(plan);
  if (errs.length) throw new Error(`plan rejected: ${errs.slice(0, 3).join('; ')}`);
  const beats: Beat[] = [];
  let first: { set: SetId; tint: Tint; cast: CastEntry[] } | null = null;
  let steelSaid = false;

  for (const sc of plan.scenes) {
    const info = SETS[sc.set];
    const tint = sc.tint ?? info.tint;
    const on = new Set<string>(); // who is on the stage right now
    const cast: CastEntry[] = sc.cast.map((c) => ({ id: c.id, char: c.char, ...(c.items?.length ? { items: c.items } : {}) }));
    const entry = (cid: string) => cast.find((c) => c.id === cid)!;
    // who is already in place when the curtain opens
    const lead = sc.pieces[0];
    if (lead.piece === 'ride') {
      Object.assign(entry(lead.who), { mounted: true, at: 'centre' });
      on.add(lead.who);
    }
    if (lead.piece === 'wake' && info.sleep) {
      Object.assign(entry(lead.sleeper), { at: info.sleep[0], pose: info.sleep[1], zzz: true });
      on.add(lead.sleeper);
    }
    const storm = sc.pieces.find((p) => p.piece === 'storm') as Extract<PiecePlan, { piece: 'storm' }> | undefined;
    (storm?.risers ?? []).forEach((r, i) => {
      if (on.has(r) || !info.graves) return;
      Object.assign(entry(r), { at: info.graves[i], pose: 'sleep' });
      on.add(r);
    });
    const scene: Beat[] = [];
    let side: Side = 'left';
    /** Bring an actor to a mark: on from the wings if they are off, across the stage if they are on. */
    const bring = (who: string, to: string, opts: { face?: string; gait?: 'walk' | 'run'; from?: Side } = {}): Beat => {
      if (on.has(who)) return { k: 'move', who, to, ...(opts.gait ? { gait: opts.gait } : {}), ...(opts.face ? { face: opts.face } : {}) };
      on.add(who);
      const from = opts.from ?? side;
      side = from === 'left' ? 'right' : 'left';
      return { k: 'enter', who, from, to, ...(opts.gait ? { gait: opts.gait } : {}), ...(opts.face ? { face: opts.face } : {}) };
    };
    const everyone = () => [...on];

    for (const pc of sc.pieces) {
      switch (pc.piece) {
        case 'card':
          scene.push({ k: 'title', text: pc.line, ...(pc.sub ? { sub: pc.sub } : {}), secs: pc.sub ? 2.8 : 2.2 });
          break;
        case 'arrive':
          if (pc.line) scene.push({ k: 'title', text: pc.line, secs: 2.2 });
          scene.push(bring(pc.who, pc.from === 'right' ? 'right' : 'left', { from: pc.from }));
          break;
        case 'ride':
          scene.push({ k: 'title', text: pc.line ?? 'Ride! Ride!', secs: 2 });
          scene.push({
            k: 'ride',
            who: pc.who,
            label: 'Clop the coconuts',
            need: pc.clops ?? 10,
            secs: 22,
            hit: [{ k: 'wait', secs: 0.5 }],
            miss: [{ k: 'title', text: 'The horse walked.', sub: 'It took all night.', secs: 2.2 }],
          });
          break;
        case 'knock': {
          scene.push(bring(pc.who, 'door_side', { face: 'door' }));
          const answer: Beat[] = [{ k: 'door', open: true }, { k: 'wait', secs: 0.4 }];
          if (on.has(pc.opener)) answer.push({ k: 'move', who: pc.opener, to: 'door', face: pc.who });
          else {
            on.add(pc.opener);
            answer.push({ k: 'enter', who: pc.opener, from: 'door', to: 'door', face: pc.who });
          }
          answer.push({ k: 'emote', who: pc.opener, emote: '!' });
          scene.push({
            k: 'cue',
            prop: 'door',
            label: 'Knock for him',
            who: pc.who,
            times: 3,
            each: [{ k: 'do', who: pc.who, verb: 'punch', face: 'door', secs: 0.42 }],
            hit: answer,
            miss: [{ k: 'title', text: 'Nobody knocked.', sub: 'The door opens anyway.', secs: 2.2 }, ...answer],
          });
          if (pc.line) scene.push({ k: 'title', text: pc.line, secs: 2.4 });
          break;
        }
        case 'wake':
          scene.push(bring(pc.who, 'right', { face: pc.sleeper, from: 'right' }));
          scene.push({
            k: 'open',
            prompt: 'What wakes the sleeper?',
            branches: wakes(pc.sleeper, sc.set),
            miss: [{ k: 'title', text: 'The sleeper wakes alone.', sub: '(Nobody made a sound.)', secs: 2.2 }, { k: 'do', who: pc.sleeper, verb: 'getup' }],
          });
          scene.push({ k: 'par', beats: [{ k: 'do', who: pc.sleeper, verb: 'flinch', face: pc.who }, { k: 'emote', who: pc.sleeper, emote: '!' }] });
          break;
        case 'duel': {
          const loser = pc.loser === 'a' ? pc.a : pc.b;
          const winner = loser === pc.a ? pc.b : pc.a;
          scene.push({ k: 'par', beats: [bring(pc.a, 'left', { face: pc.b, from: 'left' }), bring(pc.b, 'centre', { face: pc.a, from: 'right' })] });
          scene.push({ k: 'move', who: pc.a, to: pc.b });
          if (!steelSaid) scene.push({ k: 'title', text: 'Steel rings like a bell.', secs: 1.9 });
          steelSaid = true;
          const blows = pc.blows ?? 2;
          const exchange = (striker: string, other: string, verb: 'chop' | 'stab'): Beat => ({
            k: 'par',
            beats: [{ k: 'do', who: striker, verb, face: other }, { k: 'do', who: other, verb: 'block', face: striker }],
          });
          for (let i = 0; i < blows - 1; i++) {
            const [striker, other] = i % 2 === 0 ? [pc.a, pc.b] : [pc.b, pc.a];
            scene.push({ k: 'cue', prop: 'bell', label: i === 0 ? 'Ring: a blow!' : 'Ring: a parry!', who: striker, hold: 9, hit: [exchange(striker, other, i % 2 === 0 ? 'chop' : 'stab')] });
          }
          scene.push({
            k: 'cue',
            prop: 'bell',
            label: 'Ring: the last blow!',
            who: winner,
            hold: 9,
            hit: [
              { k: 'par', beats: [{ k: 'do', who: winner, verb: 'slash', face: loser }, { k: 'do', who: loser, verb: 'stagger', face: winner }] },
              { k: 'do', who: loser, verb: 'fall' },
              { k: 'do', who: winner, verb: 'cheer', face: 'audience' },
            ],
          });
          break;
        }
        case 'storm': {
          scene.push({ k: 'title', text: pc.line ?? 'A storm breaks.', secs: 2 });
          const risers = (pc.risers ?? []).filter((r) => info.graves);
          const standing = everyone().filter((x) => !risers.includes(x));
          scene.push({
            k: 'cue',
            prop: 'thunder',
            label: 'Shake the thunder',
            hold: 12,
            times: 2,
            each: [{ k: 'fx', fx: 'lightning' }, { k: 'par', beats: standing.map((x): Beat => ({ k: 'do', who: x, verb: 'flinch' })) }],
            hit: [
              { k: 'fx', fx: 'shake' },
              ...(risers.length
                ? [
                    { k: 'par', beats: risers.map((r): Beat => ({ k: 'do', who: r, verb: 'awaken' })) } as Beat,
                    { k: 'par', beats: [...risers.map((r): Beat => ({ k: 'emote', who: r, emote: 'skull' })), ...standing.map((x): Beat => ({ k: 'emote', who: x, emote: '!' }))] } as Beat,
                    { k: 'title', text: 'Your thunder woke the dead.', secs: 2.2 } as Beat,
                  ]
                : [{ k: 'par', beats: standing.map((x): Beat => ({ k: 'emote', who: x, emote: 'sweat' })) } as Beat]),
            ],
          });
          break;
        }
        case 'smash':
          if (info.window) {
            scene.push(bring(pc.who, 'window', { gait: 'run', face: 'window' }));
            scene.push({ k: 'cue', prop: 'glass', label: 'Smash! A leap!', who: pc.who, hold: 10, hit: [{ k: 'do', who: pc.who, verb: 'jump', secs: 0.45 }, { k: 'exit', who: pc.who, to: 'window', gait: 'run' }] });
            on.delete(pc.who);
          } else {
            scene.push(bring(pc.who, 'centre'));
            scene.push({
              k: 'cue',
              prop: 'glass',
              label: 'Smash a bottle!',
              who: pc.who,
              hold: 10,
              hit: [{ k: 'do', who: pc.who, verb: 'throw' }, { k: 'par', beats: everyone().filter((x) => x !== pc.who).map((x): Beat => ({ k: 'do', who: x, verb: 'jump' })) }],
            });
          }
          break;
        case 'whistle':
          scene.push(bring(pc.who, 'centre'));
          scene.push({
            k: 'cue',
            prop: 'whistle',
            label: 'Whistle for help',
            who: pc.who,
            hold: 10,
            hit: [{ k: 'emote', who: pc.who, emote: 'note' }, bring(pc.comes, pc.who, { gait: 'run' }), { k: 'emote', who: pc.comes, emote: '!' }],
          });
          break;
        case 'slam':
          scene.push({ k: 'par', beats: [bring(pc.who, 'door_side', { gait: 'run', face: 'door' }), { k: 'door', open: true }] });
          scene.push({
            k: 'cue',
            prop: 'door',
            label: 'Slam it shut!',
            who: pc.who,
            hold: 10,
            hit: [{ k: 'door', open: false }, { k: 'fx', fx: 'shake' }, { k: 'do', who: pc.who, verb: 'stagger' }],
            miss: [{ k: 'title', text: 'The door sticks.', secs: 1.6 }, { k: 'door', open: false }, { k: 'do', who: pc.who, verb: 'stagger' }],
          });
          break;
        case 'chase': {
          const start = bring(pc.runner, 'centre', { gait: 'run' });
          scene.push(start, { k: 'emote', who: pc.runner, emote: 'sweat' }, { k: 'exit', who: pc.runner, to: side, gait: 'run' });
          on.delete(pc.runner);
          scene.push(bring(pc.chaser, 'centre', { gait: 'run' }), { k: 'emote', who: pc.chaser, emote: 'angry' }, { k: 'exit', who: pc.chaser, to: side, gait: 'run' });
          on.delete(pc.chaser);
          break;
        }
        case 'toast':
          if (pc.line) scene.push({ k: 'title', text: pc.line, secs: 2 });
          scene.push({
            k: 'cue',
            prop: 'bell',
            label: 'Ring the bell!',
            hold: 10,
            hit: [{ k: 'par', beats: everyone().map((x): Beat => ({ k: 'do', who: x, verb: 'cheer', face: 'audience' })) }],
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
  { prop: 'bell', text: 'Ask at the inn' },
];

const KNIGHT = { id: 'knight', char: 'knight' as const, items: ['sword_1handed', 'shield_round'] };
const THIEF = { id: 'thief', char: 'rogue_hooded' as const, items: ['dagger'] };

export const WRITTEN: Record<PropId, ReelPlan> = {
  coconuts: {
    title: 'The Chase',
    scenes: [
      { set: 'road-forest', cast: [KNIGHT], pieces: [{ piece: 'ride', who: 'knight', line: 'After him!', clops: 12 }] },
      {
        set: 'camp',
        cast: [KNIGHT, THIEF, { id: 'brute', char: 'barbarian' }],
        pieces: [
          { piece: 'wake', who: 'knight', sleeper: 'brute' },
          { piece: 'card', line: '“Where is the thief?”' },
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
  // the other props, for the day a pitch is made with them and the Director is away
  door: {
    title: 'The Duke at Home',
    scenes: [
      {
        set: 'hall',
        cast: [KNIGHT, { id: 'duke', char: 'skeleton_mage', items: ['skeleton_staff'] }, { id: 'guard', char: 'skeleton_warrior' }],
        pieces: [
          { piece: 'knock', who: 'knight', opener: 'guard', line: '“The Duke is not at home.”' },
          { piece: 'duel', a: 'knight', b: 'guard', blows: 2 },
          { piece: 'arrive', who: 'duke', from: 'right', line: 'The Duke was at home.' },
          { piece: 'slam', who: 'knight' },
        ],
      },
    ],
    cliffhanger: 'Locked in with the Duke.',
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
          { piece: 'card', line: '“The thief serves the Duke.”' },
          { piece: 'storm', line: 'The fire spits.' },
          { piece: 'duel', a: 'sage', b: 'brute', blows: 1 },
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
