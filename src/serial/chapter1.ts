// Chapter one, written by hand: the reels every player sees first. Each moment that matters waits for a sound.
import type { Beat, CastEntry, Reel } from './schema';

const KNIGHT: Pick<CastEntry, 'id' | 'char' | 'items'> = { id: 'knight', char: 'knight', items: ['sword_1handed', 'shield_round'] };

/** What the sleeping thief does with each sound: the first time the player's choice writes the story. */
const WAKES: Extract<Beat, { k: 'open' }>['branches'] = {
  bell: {
    title: 'A bell! “Supper?”',
    flag: 'thief_hungry',
    did: 'woke the thief, who thought it was supper',
    beats: [
      { k: 'do', who: 'thief', verb: 'getup' },
      { k: 'emote', who: 'thief', emote: 'heart' },
      { k: 'move', who: 'thief', to: 'table', face: 'upstage' },
      { k: 'do', who: 'thief', verb: 'pickup' },
    ],
  },
  thunder: {
    title: 'Thunder! He hides.',
    flag: 'thief_scared',
    did: 'woke the thief and sent him to hide',
    beats: [
      { k: 'fx', fx: 'lightning' },
      { k: 'do', who: 'thief', verb: 'getup' },
      { k: 'do', who: 'thief', verb: 'flinch' },
      { k: 'move', who: 'thief', to: 'aside_left', gait: 'run' },
      { k: 'do', who: 'thief', verb: 'sitfloor' },
      { k: 'emote', who: 'thief', emote: 'sweat' },
      { k: 'do', who: 'thief', verb: 'getup' },
    ],
  },
  glass: {
    title: 'Glass! “Burglars!”',
    flag: 'thief_alert',
    did: 'woke the thief, who shouted burglars',
    beats: [
      { k: 'do', who: 'thief', verb: 'getup' },
      { k: 'emote', who: 'thief', emote: 'angry' },
      { k: 'do', who: 'thief', verb: 'guard', face: 'window', secs: 1.4 },
    ],
  },
  door: {
    title: 'A knock. “Come in!”',
    flag: 'thief_polite',
    did: 'woke the thief, who called come in',
    beats: [
      { k: 'do', who: 'thief', verb: 'getup' },
      { k: 'move', who: 'thief', to: 'door_side', face: 'door' },
      { k: 'door', open: true },
      { k: 'emote', who: 'thief', emote: '?' },
      { k: 'door', open: false },
    ],
  },
  coconuts: {
    title: 'Hooves! “The Duke!”',
    flag: 'thief_fooled',
    did: 'woke the thief, who thought the Duke had come',
    beats: [
      { k: 'do', who: 'thief', verb: 'getup' },
      { k: 'do', who: 'thief', verb: 'cheer', face: 'audience' },
      { k: 'emote', who: 'thief', emote: 'sweat' },
    ],
  },
  whistle: {
    title: 'A tune. He dances.',
    flag: 'thief_merry',
    did: 'woke the thief, who danced to it',
    beats: [
      { k: 'do', who: 'thief', verb: 'getup' },
      { k: 'emote', who: 'thief', emote: 'note' },
      { k: 'do', who: 'thief', verb: 'cheer', face: 'audience' },
      { k: 'do', who: 'thief', verb: 'jump' },
    ],
  },
};

export const REEL_1: Reel = {
  id: 'c1r1',
  title: 'The Midnight Knock',
  sub: 'A knight. A door.',
  set: 'gate',
  tint: 'blue',
  cast: [KNIGHT, { id: 'butler', char: 'skeleton_minion' }, { id: 'guard', char: 'barbarian', at: 'guard', pose: 'sitfloor', zzz: true }],
  beats: [
    { k: 'enter', who: 'knight', from: 'left', to: 'door_side', face: 'door' },
    {
      k: 'cue',
      prop: 'door',
      label: 'Knock for him',
      who: 'knight',
      times: 3,
      did: 'opened the castle gate',
      each: [{ k: 'do', who: 'knight', verb: 'punch', face: 'door', secs: 0.42 }],
      hit: [
        { k: 'door', open: true },
        { k: 'wait', secs: 0.4 },
        { k: 'enter', who: 'butler', from: 'door', to: 'door', face: 'knight' },
        { k: 'par', beats: [{ k: 'emote', who: 'butler', emote: '!' }, { k: 'do', who: 'butler', verb: 'cheer', face: 'knight' }] },
      ],
      miss: [
        { k: 'title', text: 'Nobody knocked.', sub: 'The butler opens anyway. He was bored.', secs: 2.4 },
        { k: 'door', open: true },
        { k: 'enter', who: 'butler', from: 'door', to: 'door', face: 'knight' },
      ],
    },
    { k: 'title', text: '“The crown is stolen!”', sub: '“The thief rode north, sir.”', secs: 2.2 },
    { k: 'par', beats: [{ k: 'do', who: 'knight', verb: 'jump', face: 'audience' }, { k: 'emote', who: 'knight', emote: '!' }] },
    { k: 'exit', who: 'knight', to: 'right', gait: 'run' },

    { k: 'scene', set: 'road', tint: 'blue', cast: [{ ...KNIGHT, mounted: true, at: 'centre' }] },
    { k: 'title', text: 'His horse runs on your hooves.', secs: 1.8 },
    {
      k: 'ride',
      who: 'knight',
      label: 'Clop the coconuts',
      need: 7,
      did: 'carried the knight down the road',
      secs: 22,
      hit: [{ k: 'wait', secs: 0.5 }],
      miss: [{ k: 'title', text: 'The horse walked.', sub: 'It took all night.', secs: 2.4 }],
    },

    {
      k: 'scene',
      set: 'vault',
      tint: 'amber',
      cast: [{ id: 'thief', char: 'rogue_hooded', at: 'chest', pose: 'sleep', zzz: true, item: 'dagger' }, KNIGHT],
    },
    { k: 'title', text: 'The robbers’ den.', sub: 'The thief sleeps on his loot.', secs: 2.1 },
    { k: 'enter', who: 'knight', from: 'right', to: 'front_right', face: 'thief' },
    {
      k: 'open',
      prompt: 'What wakes him?',
      branches: WAKES,
      miss: [
        { k: 'title', text: 'He wakes by himself.', sub: '(Nobody made a sound.)', secs: 2.2 },
        { k: 'do', who: 'thief', verb: 'getup' },
      ],
    },
    { k: 'par', beats: [{ k: 'do', who: 'thief', verb: 'flinch', face: 'knight' }, { k: 'emote', who: 'thief', emote: '!' }] },
    { k: 'title', text: '“The crown, villain!”', secs: 1.5 },
    // the player's thunder blows the toy theatre open to the size of the wall: the rest of the reel is played large
    { k: 'title', text: 'A storm breaks overhead.', secs: 1.4 },
    {
      k: 'cue',
      prop: 'thunder',
      label: 'Shake the thunder!',
      hold: 10,
      did: 'burst the toy theatre open to the size of the wall',
      hit: [
        { k: 'fx', fx: 'grow' },
        { k: 'fx', fx: 'shake' },
        { k: 'par', beats: [{ k: 'do', who: 'thief', verb: 'flinch' }, { k: 'do', who: 'knight', verb: 'flinch' }] },
      ],
    },
    { k: 'par', beats: [{ k: 'move', who: 'thief', to: 'door_side', gait: 'run', face: 'door' }, { k: 'door', open: true }] },
    {
      k: 'cue',
      prop: 'door',
      label: 'Slam it shut!',
      who: 'thief',
      hold: 10,
      did: 'slammed the door in the thief’s face',
      hit: [
        { k: 'door', open: false },
        { k: 'fx', fx: 'shake' },
        { k: 'do', who: 'thief', verb: 'stagger' },
      ],
      miss: [
        { k: 'title', text: 'The door sticks.', secs: 1.6 },
        { k: 'door', open: false },
        { k: 'do', who: 'thief', verb: 'stagger' },
      ],
    },
    { k: 'par', beats: [{ k: 'move', who: 'thief', to: 'duel_a', gait: 'run', face: 'knight' }, { k: 'move', who: 'knight', to: 'duel_b', face: 'thief' }] },
    { k: 'title', text: 'Steel rings like a bell.', secs: 1.5 },
    {
      k: 'cue',
      prop: 'bell',
      label: 'Ring: he strikes!',
      who: 'knight',
      hold: 9,
      did: 'rang every blow of the duel',
      hit: [{ k: 'par', beats: [{ k: 'do', who: 'knight', verb: 'chop', face: 'thief' }, { k: 'do', who: 'thief', verb: 'block', face: 'knight' }] }],
    },
    {
      k: 'cue',
      prop: 'bell',
      label: 'Ring: he parries!',
      who: 'knight',
      hold: 9,
      did: 'rang every blow of the duel',
      hit: [{ k: 'par', beats: [{ k: 'do', who: 'thief', verb: 'stab', face: 'knight' }, { k: 'do', who: 'knight', verb: 'block', face: 'thief' }] }],
    },
    {
      k: 'cue',
      prop: 'bell',
      label: 'Ring: the last blow!',
      who: 'knight',
      hold: 9,
      did: 'rang every blow of the duel',
      hit: [
        { k: 'par', beats: [{ k: 'do', who: 'knight', verb: 'slash', face: 'thief' }, { k: 'do', who: 'thief', verb: 'stagger', face: 'knight' }] },
        { k: 'item', who: 'thief', item: 'dagger', hold: false },
        { k: 'emote', who: 'thief', emote: 'sweat' },
      ],
    },
    // the film breaks out: the thief leaves the picture, by the footlights, onto the player's own desk
    { k: 'title', text: 'One way out.', secs: 1.3 },
    { k: 'move', who: 'thief', to: 'footlights', gait: 'run', face: 'audience' },
    { k: 'emote', who: 'thief', emote: '!' },
    {
      k: 'cue',
      prop: 'glass',
      label: 'Smash! He jumps!',
      who: 'thief',
      hold: 10,
      did: 'broke the picture and let the thief out of it, onto the player’s table',
      // the picture breaks, the theatre is a toy on the desk again, and he is out of it
      hit: [{ k: 'fx', fx: 'shrink' }, { k: 'wait', secs: 0.5 }],
      miss: [{ k: 'title', text: 'He kicks it out himself.', secs: 1.6 }, { k: 'fx', fx: 'shrink' }, { k: 'wait', secs: 0.5 }],
    },
    // no card covers the leap; the house lights come up over the player's own room, because that is where he is now
    { k: 'fx', fx: 'house_up' },
    {
      k: 'par',
      beats: [
        { k: 'leap', who: 'thief' },
        { k: 'seq', beats: [{ k: 'wait', secs: 0.5 }, { k: 'move', who: 'knight', to: 'footlights_side', gait: 'run', face: 'audience' }, { k: 'emote', who: 'knight', emote: 'angry' }] },
        { k: 'seq', beats: [{ k: 'wait', secs: 1.9 }, { k: 'title', text: 'He has left the picture!', sub: 'He is in your room.', secs: 2.0 }] },
      ],
    },
    {
      k: 'cue',
      prop: 'whistle',
      label: 'Whistle him off the edge',
      who: 'knight',
      hold: 12,
      did: 'sent the thief over the edge of the table',
      hit: [{ k: 'drop', who: 'thief' }, { k: 'do', who: 'knight', verb: 'cheer', face: 'audience' }],
      miss: [{ k: 'title', text: 'He climbs down by himself.', secs: 1.8 }, { k: 'drop', who: 'thief' }],
    },
    { k: 'fx', fx: 'house_down' },
    // (the next reel begins with him climbing back into the picture)
    { k: 'flag', set: 'thief_out' },
    { k: 'fx', fx: 'lightning' },
  ],
  cliffhanger: 'The thief is loose in your room.',
};

export const CHAPTER_1: Reel[] = [REEL_1];
