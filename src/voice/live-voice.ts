/**
 * Which voice a GPT-Live call speaks in. Pure: shared by desktop, the phone's
 * gateway and tests.
 */

/**
 * A custom GPT-Live voice (OpenAI's custom voices guide): its id, a name to
 * show, and the description it was made from, which goes into the call's
 * instructions so the voice holds its character.
 */
export interface CustomLiveVoice {
  id: string;
  name: string;
  description: string;
}

/** What `gptLiveVoice` holds when a custom voice is chosen. */
export const CUSTOM_VOICE_PREFIX = "custom:";

/**
 * The voice a call uses: a built-in name, or `{ id }` for a custom voice
 * (SDK: `voice?: string | BuiltInVoice | CustomVoice`, `CustomVoice { id }`),
 * plus the custom voice's description for the instructions.
 */
export function resolveLiveVoice(
  selected: string | undefined,
  customs: CustomLiveVoice[] | undefined
): { voice: string | { id: string }; description: string } {
  const sel = selected || "marin";
  if (sel.startsWith(CUSTOM_VOICE_PREFIX)) {
    const id = sel.slice(CUSTOM_VOICE_PREFIX.length);
    const c = (customs || []).find((v) => v.id === id);
    if (c) return { voice: { id: c.id }, description: c.description || "" };
    return { voice: "marin", description: "" }; // removed since: fall back rather than fail the call
  }
  return { voice: sel, description: "" };
}

