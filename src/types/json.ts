/**
 * Checking JSON that came from outside: a file on disk, a line from the
 * Claude CLI, a message from the phone. Parsed JSON is `unknown` until it has
 * been looked at; these narrow it without trusting it.
 */

/** A JSON object whose fields haven't been checked yet. */
export type JsonObject = Record<string, unknown>;

/** A plain object (not null, not an array). */
export function isObject(v: unknown): v is JsonObject {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The value as an object to read fields from, or null if it isn't one. */
export function asObject(v: unknown): JsonObject | null {
  return isObject(v) ? v : null;
}

/** The value if it's a string. */
export function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/** A thrown value's `code` (Node's errors carry one, such as "ENOENT"). */
export function errorCode(e: unknown): unknown {
  return asObject(e)?.code;
}

/** A thrown value's message, for showing. */
export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
