// Sets or clears the flags a capture run needs in the managed browser's storage, then reports them.
//   CAPTURE=1 iwsdk browser run tools/video/flag.mjs     (CAPTURE=0 turns capture off; the Serial's saved place is always cleared)
//   REEL=bell also makes the first clapper roll that prop's written reel (empty clears it)
//   VOICE=1 is as if the microphone had been allowed; SAY=<data: URL of a recording> is what a held megaphone hears
//   SAVE=<the Serial's saved story, as JSON> starts from that story: the clapper goes straight to "What happens next?"
export default async function run({ frame, page }) {
  const on = process.env.CAPTURE !== '0';
  const reel = process.env.REEL ?? '';
  const voice = process.env.VOICE === '1';
  const say = process.env.SAY ?? '';
  const save = process.env.SAVE ?? '';
  const set = ([flag, reel, voice, say, save]) => {
    try {
      if (flag) localStorage.setItem('coconuts.capture', '1');
      else localStorage.removeItem('coconuts.capture');
      if (save) localStorage.setItem('coconuts.serial', save);
      else localStorage.removeItem('coconuts.serial');
      if (say) localStorage.setItem('coconuts.say', say);
      else localStorage.removeItem('coconuts.say');
      if (reel) localStorage.setItem('coconuts.reel', reel);
      else localStorage.removeItem('coconuts.reel');
      // VOICE=1: as if the player had allowed the microphone on the page (the megaphone glows and the pitch card offers it)
      if (voice) localStorage.setItem('coconuts.voice', '1');
      else localStorage.removeItem('coconuts.voice');
      return { capture: localStorage.getItem('coconuts.capture'), show: localStorage.getItem('coconuts.show'), say: (localStorage.getItem('coconuts.say') ?? '').length, saved: !!localStorage.getItem('coconuts.serial') };
    } catch (e) {
      return { error: String(e) };
    }
  };
  return { frame: frame ? await frame.evaluate(set, [on, reel, voice, say, save]).catch((e) => ({ error: String(e) })) : null, page: await page.evaluate(set, [on, reel, voice, say, save]).catch((e) => ({ error: String(e) })) };
}
