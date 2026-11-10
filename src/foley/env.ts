// Where are we running? The emulator's headless browser draws in software and has no speakers.
export function automationRun(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.webdriver;
}

/**
 * `?sound` keeps the audio graph on in an automation run, for recording the video's soundtrack. The flag is
 * kept in localStorage because the dev runtime reloads the page without its query on entering XR.
 */
export function soundForced(): boolean {
  if (typeof location === 'undefined') return false;
  const q = new URLSearchParams(location.search);
  try {
    // the dev runtime reopens the page in a fresh tab on entering XR, so the flag lives in localStorage; ?nosound clears it
    if (q.has('nosound')) localStorage.removeItem('coconuts.sound');
    else if (q.has('sound')) localStorage.setItem('coconuts.sound', '1');
    return localStorage.getItem('coconuts.sound') === '1';
  } catch {
    return q.has('sound');
  }
}
