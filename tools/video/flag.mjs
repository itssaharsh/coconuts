// Sets or clears the flags a capture run needs in the managed browser's storage, then reports them.
//   CAPTURE=1 iwsdk browser run tools/video/flag.mjs     (CAPTURE=0 turns capture off; the Serial's saved place is always cleared)
export default async function run({ frame, page }) {
  const on = process.env.CAPTURE !== '0';
  const set = (flag) => {
    try {
      if (flag) localStorage.setItem('coconuts.capture', '1');
      else localStorage.removeItem('coconuts.capture');
      localStorage.removeItem('coconuts.serial');
      return { capture: localStorage.getItem('coconuts.capture'), show: localStorage.getItem('coconuts.show') };
    } catch (e) {
      return { error: String(e) };
    }
  };
  return { frame: frame ? await frame.evaluate(set, on).catch((e) => ({ error: String(e) })) : null, page: await page.evaluate(set, on).catch((e) => ({ error: String(e) })) };
}
