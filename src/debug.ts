// Lightweight debug logger.
//
// Off by default so the plugin never spams the developer console in normal use.
// Flip DEBUG to true (or call setDebug(true)) while developing to see the
// verbose "[hyo] ..." tracing (at the console's debug level, so it shows
// under "Verbose" in the developer tools).

let DEBUG = false;

export function setDebug(on: boolean): void {
  DEBUG = on;
}

export function debug(...args: unknown[]): void {
  if (DEBUG) console.debug(...args);
}
