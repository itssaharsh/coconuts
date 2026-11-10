// Where are we running? The emulator's headless browser draws in software and has no speakers.
export function automationRun(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.webdriver;
}

/** `?sound` keeps the audio graph on in an automation run, for recording the video's soundtrack. */
export function soundForced(): boolean {
  return typeof location !== 'undefined' && new URLSearchParams(location.search).has('sound');
}
