// Where are we running? The emulator's headless browser draws in software and has no speakers.
export function automationRun(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.webdriver;
}

/**
 * `?sound` keeps the audio graph on in an automation run, for recording the video's soundtrack. The flag is
 * kept in sessionStorage because the dev runtime reloads the page without its query on entering XR.
 */
export function soundForced(): boolean {
  if (typeof location === 'undefined') return false;
  try {
    if (new URLSearchParams(location.search).has('sound')) sessionStorage.setItem('coconuts.sound', '1');
    return sessionStorage.getItem('coconuts.sound') === '1';
  } catch {
    return new URLSearchParams(location.search).has('sound');
  }
}
