// Where the figure waiting on the player's desk stands, in the world (metres), or null when nobody waits there.
// A capture run asks so that its emulated fingertip can go near it:   iwsdk browser run tools/video/figure.mjs
export default async function run({ frame, page }) {
  const ask = () => {
    try {
      return window.__capture?.figure?.() ?? null;
    } catch {
      return null;
    }
  };
  const inFrame = frame ? await frame.evaluate(ask).catch(() => null) : null;
  return inFrame ?? (await page.evaluate(ask).catch(() => null));
}
