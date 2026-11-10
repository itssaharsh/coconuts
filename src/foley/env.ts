// Where are we running? The emulator's headless browser draws in software and has no speakers.
export function automationRun(): boolean {
  if (typeof navigator !== 'undefined' && navigator.webdriver) return true;
  return typeof location !== 'undefined' && new URLSearchParams(location.search).has('automation');
}
