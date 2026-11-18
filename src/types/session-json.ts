/** Narrowing for parsed JSON and other values whose shape isn't known yet. */

/** A JSON object (not null, not an array). */
export function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

/** A caught value's `message`, when it has a non-empty one (an Error, or an error-like object). */
function messageOf(e: unknown): string | undefined {
  return isRecord(e) && typeof e.message === "string" && e.message ? e.message : undefined;
}

/** What to log for a caught error: its message, else the value itself. */
export function errorText(e: unknown): unknown {
  return messageOf(e) ?? e;
}

/** A caught error in words, for showing to the person. */
export function errorMessage(e: unknown): string {
  return messageOf(e) ?? String(e);
}
