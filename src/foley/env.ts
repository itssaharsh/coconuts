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

/**
 * Which show is on: the Serial (the toy theatre, the default) or the classic films (`?films`). Kept in localStorage for
 * the same reason as the sound flag; `?serial` goes back to the default.
 */
export function serialMode(): boolean {
  if (typeof location === 'undefined') return true;
  const q = new URLSearchParams(location.search);
  try {
    if (q.has('films')) localStorage.setItem('coconuts.show', 'films');
    else if (q.has('serial')) localStorage.removeItem('coconuts.show');
    return localStorage.getItem('coconuts.show') !== 'films';
  } catch {
    return !q.has('films');
  }
}

/**
 * `?capture` makes every drawn frame a thirtieth of a second of the show, however long the frame took: the slow
 * emulator then yields a smooth film once its frames are played back at 30 a second. `?nocapture` turns it off.
 */
export function captureMode(): boolean {
  if (typeof location === 'undefined') return false;
  const q = new URLSearchParams(location.search);
  try {
    if (q.has('nocapture')) localStorage.removeItem('coconuts.capture');
    else if (q.has('capture')) localStorage.setItem('coconuts.capture', '1');
    return localStorage.getItem('coconuts.capture') === '1';
  } catch {
    return q.has('capture');
  }
}
