/**
 * Reading JSON that arrives from elsewhere: the phone's messages to the
 * gateway, the gateway's replies on the phone, Claude Code's transcript
 * lines and the Tailscale CLI's status output. None of it is ours to trust,
 * so it comes in as `unknown` and is read through these.
 *
 * Pure (no Obsidian, no Node): shared by the desktop gateway and the phone.
 */

import type { VoiceCallRecord } from "../voice/voice-call";

/** A parsed JSON object (or array): something whose properties can be read. */
export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** `v[key]` when `v` is an object, otherwise undefined (like `v?.[key]` on parsed JSON). */
export function field(v: unknown, key: string): unknown {
  return isRecord(v) ? v[key] : undefined;
}

/** The value when it's a string, otherwise undefined. */
export function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/** An error's message, when it has one (anything thrown can arrive here). */
export function errorMessage(e: unknown): string | undefined {
  const m = field(e, "message");
  return typeof m === "string" ? m : undefined;
}

/**
 * A voice call record as the phone sends it to be saved (built by
 * voice-call.ts's `startCall` on the phone, so every required field is there).
 */
export function isVoiceCallRecord(v: unknown): v is VoiceCallRecord {
  return (
    isRecord(v) &&
    typeof v.id === "string" &&
    (v.engine === "gpt-live" || v.engine === "elevenlabs") &&
    typeof v.startedAt === "string" &&
    Array.isArray(v.turns) &&
    Array.isArray(v.handoffs) &&
    typeof v.after === "number"
  );
}
