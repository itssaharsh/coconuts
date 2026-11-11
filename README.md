# Coconuts: the Serial

A toy theatre on your desk plays a silent-film serial, and you make every sound in it. Mixed reality for Meta
Quest and Meta VR Glasses, hands only, seated, in the headset's browser (Meta's Immersive Web SDK, WebXR).

Six foley props sit on a small table in front of you: coconut shells, a little door, a desk bell, a thunder
sheet, a slide whistle and a bag of glass. The stage waits for you. The knight raises his fist at the castle
gate and nothing happens until you knock; his horse runs only as fast as you clop; the sleeping thief wakes
differently for every sound. When a reel ends a card asks "What happens next?", you answer with a sound (or by
holding the megaphone and saying it), and an AI Director writes the next reel around your answer.

Live: https://coconuts-foley.vercel.app (open it in the Quest browser; without a headset the page itself plays:
click the props, or use the keys C D B T W G and the space bar).

Built from scratch inside the Meta VR Start Developer Competition window: the first commit (ca173c2) is
timestamped 2026-11-10T17:13:38Z, after the build opened on 24 September 2026. Entertainment track, New
Experience division.

## What is real

| Piece | State |
|---|---|
| The theatre: six 3D sets, an endless road, nine rigged characters, a horse, its own lighting and film look | real, in the build; CC0 kits baked by the scripts in `tools/serial/` |
| Reel one (the gate, the ride, the robbers' den) | written by hand; every moment waits for the player's sound |
| The reels after it | planned by the Director (Claude) from the player's pitch and what their sounds did so far, then assembled from hand-staged pieces and checked; a written reel for every prop plays whenever the model is slow, wrong or absent |
| The six props | hand interactions: a pat, a pinch from afar, gaze and pinch, or pick up and shake; recorded CC0 sounds with a synthesised fallback |
| Speaking a pitch | optional: hold the megaphone, speech-to-text by AssemblyAI; off without a microphone or the key, and the pitch cards always work |
| Wall size | the player's thunder bursts the toy theatre to the size of the wall; a tile switches back, and it stays small if the headset cannot keep its frame rate |
| Headset testing | the IWSDK desktop emulator only (Quest 3 profile); no physical headset was available to the builder |

## How it plays

1. **Enter in your headset.** Your room dims and the theatre stands behind a small table, 46 cm ahead and at
   desk height. The marquee says what to do: try the props, then tap the clapper.
2. **Reel one.** "A knight. A door." He walks to the gate and waits. Knock three times on the little door and
   the gate opens. "His horse runs on your hooves": clop the coconuts and the road slides by; stop, and the
   knight nearly goes over the horse's neck. In the robbers' den the thief sleeps on his loot: whatever you
   sound wakes him in its own way. Thunder, a slammed door, a duel that rings on your bell, a leap through
   the window on your crash of glass.
3. **What happens next?** Three pitches, each on a prop. Sound one, or hold the megaphone and say your own.
   The Director writes the reel; it rolls by itself.
4. **Come back.** The serial keeps its place in the browser: next time the marquee says "Previously…" and the
   clapper goes on with the story.

Every prop answers four ways, so nothing depends on one kind of tracking: an open hand's pat, a pinch from
afar, gaze and pinch (Meta VR Glasses), or pick it up and shake. A stage kept waiting asks twice (the actor
looks out at you, the prop glows), then takes any sound, then goes on by itself: no reel can stall.

Tiles on the table rim pause, step the volume, start the reel again and switch the stage between desk and wall.

## The Director

`POST /api/reel` takes the story so far (what each reel was and what the player's sounds did in it) and the
player's pitch, and answers with a plan: up to three scenes, who is in them, which pieces play in which order,
and the words on the cards, plus three pitches for the reel after and one line to the player.

- The model never writes stage directions. It chooses from twelve **pieces** (a knock, a ride, a sleeper
  to wake, a duel, a storm, a smash, a whistle, a slammed door, a chase, a toast, an arrival, a card), each
  staged once by hand in `src/serial/pieces.ts` and each waiting for one kind of sound.
- The plan is checked twice (`checkPlan` on the server and again in the browser, then the assembled reel
  against the set's marks). One repair turn; after that, or after 9 seconds, a written reel plays.
- Claude (`claude-opus-5-5`, one structured-output call, low effort, cached system prompt) is tried first,
  Gemini second, the written reels last. A per-IP limit and a daily cap bound the cost.
- The player's spoken pitch is story material, never instructions: it is cleaned, kept out of the system
  prompt, and echoed on a card.

The classic mode from the first version is still here at `?films`: three public-domain silent films
(Keaton, Lloyd, Méliès) to dub by hand, with a cue lane, a replayable take and a one-line review.

## Run it

```bash
npm install
npm run dev         # the IWSDK dev runtime with the desktop emulator (Quest 3 profile)
npm run build       # static site in dist/ plus the Vercel functions in api/
npm test            # unit tests: the stage runtime with a fake stage, the pieces, the Director, hearing, the foley kit
```

Keys, all optional (in the environment of the functions): `ANTHROPIC_API_KEY` for the Director,
`GEMINI_API_KEY` as its second, `ASSEMBLYAI_API_KEY` for spoken pitches. Without any of them the serial plays
its written reels.

Two more ways to look at the stage:

```bash
npx vite --config vite.stage.config.ts      # the theatre alone on http://127.0.0.1:8792/stage.html (keys play the props)
python3 qa/stage/play.py out "written=thunder" bell 200   # a reel plays itself and saves a still at every wait
node tools/director/serve.mjs               # the functions on http://127.0.0.1:8796 for the dev pages
```

Scripted emulator runs, with `npx iwsdk dev up --ai-mode agent --allow-browser-automation --headless` running:

```bash
node tools/xr/run-serial.mjs --reels 2 --pitch thunder --shots qa/serial   # clapper, reel one by far pinches, the pitch, the next reel
node tools/xr/run-serial.mjs --silent                                      # nobody plays: the reel still reaches its end
node tools/xr/run-props.mjs                                                # every prop driven by a natural hand
```

## How it is built

- `src/serial/`: the stage, in plain three.js with no engine dependency.
  `theatre.ts` (proscenium, curtain, sets, lamps, cards), `film.ts` (one shader for the stage: its own light in
  stage space, the faded print that every landed cue restores, and the wings, so it looks the same in any room
  and costs the same), `cast.ts` (nine characters on one rig, the horse), `player.ts` (beats into tasks; cues,
  rides and open moments that wait for sound), `pieces.ts` (plans into reels), `serial.ts` (reels, pitches,
  the Director, the saved place), `tasks.ts` (a cooperative scheduler: no timers, so a reel can be stepped
  and tested).
- `src/foley/`: the table, the props and the hands. `system.ts` is the one ECS system: it places the stage for
  the player's eyes, turns pats, pinches and hand motion into sounds, and feeds them to the stage.
- `api/`: the Director (`reel.ts`), hearing (`hear.ts`), the classic mode's reviewer and voice.
- `tools/serial/`, `assets-src/`: the asset pipeline (Blender and glTF-Transform scripts that bake the sets and
  strip the characters). `tools/audio/`: the cuts of the recorded sounds. `tools/xr/`: emulator drivers.

Hands only, no controllers. Seated, everything inside a two-foot radius.

## Accessibility

- One hand is enough, and no grip is needed: a pat or a far pinch sounds every prop; the clapper and the tiles
  answer a touch.
- Eyes do the aiming on Meta VR Glasses: look at a prop and pinch once with either hand.
- Nothing is timed: the stage waits, asks again, then goes on. Every sound is also seen (a sound word on the
  stage, a card that names what it did).
- The volume tile mutes in three steps; the pause tile holds the reel; the size tile keeps the stage small.
- The page plays without a headset, by mouse or keyboard.

## Credits and licences

MIT for the code (see `LICENSE`).

- Characters, dungeon, graveyard and furniture: KayKit packs by Kay Lousberg (CC0). Nature, village and the
  horse: Quaternius (CC0).
- Sounds and the piano rags: CC0 or public domain; every file with its source and licence line in
  [`public/audio/CREDITS.md`](public/audio/CREDITS.md).
- The classic mode's films are public domain; see each clip's provenance in `public/clips/`.
