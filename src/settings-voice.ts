import type { Setting } from "obsidian";
import type { Page, Row } from "./settings-layout";
import type { CustomLiveVoice } from "./voice/live-voice";
import { DEFAULT_VOICE_PERSONALITY } from "./voice/gpt-live";
import { DICTATION_PROVIDERS, isDictationProvider, type DictationProvider } from "./voice/dictation";

/**
 * Settings → Hyo → Voice. Two groups: everything about a voice call
 * (GPT-Live: its key, its voice, who you are and how it talks), then
 * everything about dictation (the service that transcribes the phone's mic).
 */

/** The settings the Voice page reads and writes. */
export interface VoiceSettings {
  openAiApiKey: string;
  gptLiveCustomVoices: CustomLiveVoice[];
  voiceAboutYouNote: string;
  voicePersonality: string;
  dictationProvider: DictationProvider;
  elevenLabsApiKey: string;
}

/** What the Voice page needs from the settings tab. */
export interface VoiceHost {
  settings(): VoiceSettings;
  /** A password box for an API key, saved as it's typed. */
  keyInput(setting: Setting, placeholder: string, get: () => string, set: (v: string) => void): void;
  /** The voice dropdown and its Play sample button. */
  voicePicker(setting: Setting): void;
  /** Name, id and description boxes for adding a custom voice. */
  customVoiceAdder(setting: Setting): void;
  /** Take a custom voice off the list. */
  removeCustomVoice(id: string): Promise<void>;
  /** About you: the note picker, and the box underneath when no note is used. */
  aboutYou(setting: Setting): void;
  /** A full-width box under the row's name and description, saved as it's typed. */
  stackedTextArea(setting: Setting, o: { placeholder: string; get: () => string; set: (v: string) => void }): void;
  /** A value other rows' visibility depends on changed. */
  refreshVisibility(): void;
}

export function voicePage(host: VoiceHost): Page {
  const settings = () => host.settings();
  // The page is built afresh on every draw, so this follows the note setting.
  const aboutYouNote = settings().voiceAboutYouNote || "";

  const customVoices: Row[] = (settings().gptLiveCustomVoices || []).map((c) => ({
    kind: "custom",
    name: c.name || "Custom voice",
    desc: `${c.id}${c.description ? ` · ${c.description.slice(0, 120)}${c.description.length > 120 ? "…" : ""}` : ""}`,
    build: (setting: Setting) => {
      setting.addButton((btn) => btn.setButtonText("Remove").onClick(() => host.removeCustomVoice(c.id)));
    },
  }));

  const calls: Row[] = [
    {
      kind: "custom",
      name: "OpenAI API key",
      desc: "A voice call is a real back-and-forth with OpenAI's GPT-Live: it talks with you and hands anything that needs your files or real work to Claude. Get a key from platform.openai.com → API keys. Calls are billed to this key at OpenAI's per-minute rate. Calls from your phone use this key too, through your desktop.",
      aliases: ["voice call", "gpt-live"],
      build: (setting) => host.keyInput(setting, "sk-...", () => settings().openAiApiKey, (v) => (settings().openAiApiKey = v)),
    },
    {
      kind: "custom",
      name: "Voice",
      desc: "One of OpenAI's built-in voices, or a custom voice you've added below. Takes effect on the next call. Play sample says one line in the chosen voice (about two seconds of call time).",
      build: (setting) => host.voicePicker(setting),
    },
    ...customVoices,
    {
      kind: "custom",
      name: "Add a custom voice",
      desc: "Paste a custom voice's id (it starts voice_) and the description it was made from. It joins the list above.",
      build: (setting) => host.customVoiceAdder(setting),
    },
    {
      kind: "custom",
      name: "About you",
      desc: aboutYouNote
        ? `The voice reads your note "${aboutYouNote.replace(/\.md$/, "")}" fresh at the start of each call.`
        : "A few lines the voice always knows: your name, what you do, how you like to be spoken to. Or use a note from your vault instead.",
      build: (setting) => host.aboutYou(setting),
    },
    {
      kind: "custom",
      name: "Personality",
      desc: "How the voice talks to you: its character and tone.",
      build: (setting) =>
        host.stackedTextArea(setting, {
          placeholder: DEFAULT_VOICE_PERSONALITY,
          get: () => settings().voicePersonality || "",
          set: (v) => (settings().voicePersonality = v),
        }),
    },
  ];

  const dictationOptions: Record<string, string> = {};
  for (const p of DICTATION_PROVIDERS) dictationOptions[p.id] = p.label;
  const dictation: Row[] = [
    {
      kind: "control",
      key: "dictationProvider",
      name: "Dictation service",
      desc: "Who turns your words into text when you hold or tap the mic on your phone. OpenAI uses the OpenAI API key from Voice calls; ElevenLabs needs a key of its own.",
      aliases: ["speech to text", "transcription", "microphone"],
      binding: {
        type: "dropdown",
        options: dictationOptions,
        get: () => settings().dictationProvider,
        set: (v) => {
          if (isDictationProvider(v)) settings().dictationProvider = v;
        },
      },
      after: () => host.refreshVisibility(),
    },
    {
      kind: "custom",
      name: "ElevenLabs API key",
      desc: "For dictation. Get your API key from elevenlabs.io/app/settings/api-keys",
      visible: () => settings().dictationProvider === "elevenlabs",
      build: (setting) => host.keyInput(setting, "xi_...", () => settings().elevenLabsApiKey, (v) => (settings().elevenLabsApiKey = v)),
    },
  ];

  return {
    kind: "page",
    id: "voice",
    name: "Voice",
    desc: "Talk to your agent on a voice call, and choose who transcribes your dictation.",
    sections: [
      { heading: "Voice calls (GPT-Live)", items: calls },
      { heading: "Dictation", items: dictation },
    ],
  };
}
