// A tool call's input is whatever JSON Claude sent for that tool, so its
// shape isn't known ahead of time. These read one field from it safely.
import { isRecord } from "../json-guards";

/** The raw value of `key` on a tool input, or undefined when there is none. */
export function inputField(input: unknown, key: string): unknown {
  return isRecord(input) ? input[key] : undefined;
}

/** `key` on a tool input when it's a string, else undefined. */
export function inputString(input: unknown, key: string): string | undefined {
  const value = inputField(input, key);
  return typeof value === "string" ? value : undefined;
}
