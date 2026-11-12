# Thirty minutes on a real headset

The Serial has only ever run in the IWSDK desktop emulator: no physical headset was available while it was built.
Two read-throughs of the code looked for what only a device would show, and what they found was fixed, but a fix
that has not met a real hand is still a guess. This is the list to walk through with a Quest 3 or 3S, in order,
most likely trouble first. For the console, connect over USB and open `chrome://inspect`; the lines named below are
the app's own logs.

1. **Sound from both ways in.** Press the page's "Enter in your headset" and tap (do not pinch) the clapper: is
   there sound? Leave, then enter with the browser's own Enter AR button and tap the clapper: the slate should say
   that a pinch turns the sound on, and the first pinch should do it (`AUDIO locked`, then `AUDIO free`).
2. **Drumming.** Drum the coconuts with one finger, three or four taps a second, lifting only a little. Every tap
   should clop (`HIT coconuts`). Then lower a finger slowly onto the bell: if nothing sounds, tap it again without
   moving away (`TOUCH ignored` should be rare, and never five times running).
3. **Resting hands.** Leave a hand lying on the real desk among the props for a minute. Nothing should sound.
4. **Losing a hand.** Touch a prop, then hide that hand behind your back and bring it back near the props: no
   sound. Pick up the bag of glass, hide the hand: the bag hangs for a moment and goes home without a crash
   (`RELEASE glass (the hand went out of sight)`).
5. **Picking up.** Reach for the thunder sheet, the whistle and the bag of glass and pinch to lift each: none
   should sound before `GRAB`. Pinch-lift the coconuts while the other hand points at the bell: the bell stays quiet.
6. **The big moments.** Play reel one through the thunder (wall size) and the thief's leap with a frame-time
   overlay on. Look for a stall at the leap, at each sound word, and for the frame rate at wall size
   (`STAGE effects off` or `STAGE kept at desk size` mean the governor stepped in).
7. **The megaphone.** With the microphone allowed on the page: hold the megaphone at "What happens next?", say a
   line, let go; listen for the game's sound dropping in level or quality during and after the take. Having
   answered "No, sounds only" on the page: touch the megaphone; no browser prompt may appear.
8. **Seat and view.** Long-press the Meta button to recenter; enter standing and then sit; lean in over the table
   to watch the thief; take the headset off and put it back mid-reel. The stage should be placed again only for
   the first two (`STAGE placing again`), and the sound should come back after the last.
9. **The table and a real desk.** Sit at a desk. The table's top should stand a little above the real one, with
   every prop in reach of a pat. Sit low (or use a high desk) and enter again: it must not come out inside the desk.
