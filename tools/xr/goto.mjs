// Navigate the managed emulator browser to the app with query parameters, e.g. CLIP=test node ... browser run tools/xr/goto.mjs
export default async function run({ page }) {
  const url = new URL(page.url());
  const clip = process.env.CLIP;
  if (clip) url.searchParams.set('clip', clip);
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith('QP_')) url.searchParams.set(k.slice(3).toLowerCase(), String(v));
  }
  await page.goto(url.toString(), { waitUntil: 'load' });
  return { url: url.toString() };
}
