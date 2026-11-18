/**
 * Reading JSON that arrives from elsewhere: the phone's messages to the
 * gateway, the gateway's replies on the phone, Claude Code's transcript
 * lines and the Tailscale CLI's status output. None of it is ours to trust,
 * so it comes in as `unknown` and is read through these.
 *
 * Pure (no Obsidian, no Node): shared by the desktop gateway and the phone.
 */

import type { VoiceCallRecord } from "../voice/voice-call";
import { isRecord } from "./json";

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
