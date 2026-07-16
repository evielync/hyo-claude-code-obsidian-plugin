// Lightweight debug logger.
//
// Off by default so the plugin never spams the developer console in normal use.
// Flip DEBUG to true (or call setDebug(true)) while developing to see the
// verbose "[hyo] ..." tracing that used to be raw console.log calls.

let DEBUG = false;

export function setDebug(on: boolean): void {
  DEBUG = on;
}

export function debug(...args: unknown[]): void {
  if (DEBUG) console.log(...args);
}
