// Forget the Serial's saved place in the managed browser, so a test run starts from reel one.
// Run: iwsdk browser run tools/xr/clear-save.mjs
export default async function run({ frame, page }) {
  const clear = () => {
    try {
      localStorage.removeItem('coconuts.serial');
      return true;
    } catch {
      return false;
    }
  };
  const inFrame = frame ? await frame.evaluate(clear).catch(() => false) : false;
  const inPage = await page.evaluate(clear).catch(() => false);
  return { inFrame, inPage };
}
