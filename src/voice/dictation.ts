/**
 * Dictation: which service turns a recording into text (Settings → Voice →
 * Dictation), and the one-time move from the settings Hyo kept when it had
 * two voice engines.
 *
 * Pure (no Obsidian, no Node), shared by settings, the plugin and the phone.
 */

export type DictationProvider = "elevenlabs" | "openai";

export const DICTATION_PROVIDERS: { id: DictationProvider; label: string }[] = [
  { id: "openai", label: "OpenAI" },
  { id: "elevenlabs", label: "ElevenLabs" },
];

export function isDictationProvider(v: unknown): v is DictationProvider {
  return v === "elevenlabs" || v === "openai";
}

interface DictationKeys {
  dictationProvider: DictationProvider;
  elevenLabsApiKey: string;
  openAiApiKey: string;
}

/** The chosen service, its key (empty when not added yet), and what to say when it's missing. */
export function dictationSetup(s: DictationKeys): {
  provider: DictationProvider;
  apiKey: string;
  missingKeyNotice: string;
} {
  const provider = s.dictationProvider;
  return provider === "elevenlabs"
    ? {
        provider,
        apiKey: s.elevenLabsApiKey,
        missingKeyNotice: "Add your ElevenLabs API key in Settings → Hyo → Voice to dictate.",
      }
    : {
        provider,
        apiKey: s.openAiApiKey,
        missingKeyNotice: "Add your OpenAI API key in Settings → Hyo → Voice to dictate.",
      };
}

/** Saved fields that belonged to the ElevenLabs voice mode (spoken replies, voice choice, the engine switch). */
const RETIRED_VOICE_FIELDS = ["voiceEngine", "voiceId", "voiceName", "voicePlaybackSpeed", "voiceAutoSpeak"];

/**
 * Bring saved settings from a Hyo with two voice engines forward: the voice
 * call is always GPT-Live now, and dictation gets its own setting. Whoever
 * had the ElevenLabs engine keeps dictating with ElevenLabs; GPT-Live (and
 * the "realtime" value an early build saved) dictates with OpenAI. With no
 * engine saved, dictation follows whichever key is there; with neither, the
 * default applies. The retired fields are removed. Returns true when
 * anything changed, so it's saved.
 */
export function migrateVoiceSettings(saved: Record<string, unknown>): boolean {
  let changed = false;
  if (!isDictationProvider(saved.dictationProvider)) {
    const engine = saved.voiceEngine;
    const hasElevenLabs = typeof saved.elevenLabsApiKey === "string" && saved.elevenLabsApiKey !== "";
    const hasOpenAi = typeof saved.openAiApiKey === "string" && saved.openAiApiKey !== "";
    const provider: DictationProvider | null =
      engine === "elevenlabs"
        ? "elevenlabs"
        : typeof engine === "string"
          ? "openai"
          : hasElevenLabs && !hasOpenAi
            ? "elevenlabs"
            : hasOpenAi
              ? "openai"
              : null;
    if (provider) {
      saved.dictationProvider = provider;
      changed = true;
    }
  }
  for (const field of RETIRED_VOICE_FIELDS) {
    if (field in saved) {
      delete saved[field];
      changed = true;
    }
  }
  return changed;
}
