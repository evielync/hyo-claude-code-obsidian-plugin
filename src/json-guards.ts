// Guards for reading parsed JSON (settings files, data.json, stream events),
// which arrives as `unknown` and is narrowed before use.

/** A plain object whose fields can be read by name. */
export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The message of a thrown value (an Error or anything with a `message`), or the value itself as text. */
export function errorMessage(e: unknown): string {
  if (isRecord(e) && typeof e.message === "string" && e.message) return e.message;
  return String(e);
}
