/**
 * Checking JSON that came from outside: a file on disk, a line from the
 * Claude CLI, a message from the phone or the Mac. Parsed JSON is `unknown`
 * until it has been looked at; these narrow it without trusting it.
 *
 * The one place these helpers live: every other module imports them.
 */

/** A JSON object whose fields haven't been checked yet. */
export type JsonObject = Record<string, unknown>;

/** A plain object (not null, not an array). */
export function isObject(v: unknown): v is JsonObject {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Anything whose properties can be read by name: an object or an array, not
 * null. For when an array is acceptable too; use isObject when it isn't.
 */
export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** The value as an object to read fields from, or null if it isn't one. */
export function asObject(v: unknown): JsonObject | null {
  return isObject(v) ? v : null;
}

/** `v[key]` when `v` is an object, otherwise undefined (like `v?.[key]` on parsed JSON). */
export function field(v: unknown, key: string): unknown {
  return isRecord(v) ? v[key] : undefined;
}

/** The value if it's a string. */
export function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/** A thrown value's `code` (Node's errors carry one, such as "ENOENT"). */
export function errorCode(e: unknown): unknown {
  return asObject(e)?.code;
}

/** A thrown value's `message`, when it has a non-empty string one (an Error, or anything error-like). */
export function messageOf(e: unknown): string | undefined {
  const m = field(e, "message");
  return typeof m === "string" && m ? m : undefined;
}

/** A caught error in words, for showing: its message, else the value as text. */
export function errorMessage(e: unknown): string {
  return messageOf(e) ?? String(e);
}

/** What to log for a caught error: its message, else the value itself. */
export function errorText(e: unknown): unknown {
  return messageOf(e) ?? e;
}
