// Sets or clears the flags a capture run needs in the managed browser's storage, then reports them.
//   CAPTURE=1 iwsdk browser run tools/video/flag.mjs     (CAPTURE=0 turns capture off; the Serial's saved place is always cleared)
//   REEL=bell also makes the first clapper roll that prop's written reel (empty clears it)
export default async function run({ frame, page }) {
  const on = process.env.CAPTURE !== '0';
  const reel = process.env.REEL ?? '';
  const voice = process.env.VOICE === '1';
  const set = ([flag, reel, voice]) => {
    try {
      if (flag) localStorage.setItem('coconuts.capture', '1');
      else localStorage.removeItem('coconuts.capture');
      localStorage.removeItem('coconuts.serial');
      if (reel) localStorage.setItem('coconuts.reel', reel);
      else localStorage.removeItem('coconuts.reel');
      // VOICE=1: as if the player had allowed the microphone on the page (the megaphone glows and the pitch card offers it)
      if (voice) localStorage.setItem('coconuts.voice', '1');
      else localStorage.removeItem('coconuts.voice');
      return { capture: localStorage.getItem('coconuts.capture'), show: localStorage.getItem('coconuts.show') };
    } catch (e) {
      return { error: String(e) };
    }
  };
  return { frame: frame ? await frame.evaluate(set, [on, reel, voice]).catch((e) => ({ error: String(e) })) : null, page: await page.evaluate(set, [on, reel, voice]).catch((e) => ({ error: String(e) })) };
}
