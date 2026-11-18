// Dictation's service, and bringing settings forward from two voice engines.
import test from "node:test";
import assert from "node:assert/strict";
import { migrateVoiceSettings, dictationSetup } from "../src/voice/dictation";

const RETIRED = ["voiceEngine", "voiceId", "voiceName", "voicePlaybackSpeed", "voiceAutoSpeak"];

test("the ElevenLabs engine keeps dictating with ElevenLabs, and the retired fields go", () => {
  const saved: Record<string, unknown> = {
    voiceEngine: "elevenlabs",
    voiceId: "abc",
    voiceName: "Chad",
    voicePlaybackSpeed: 1.25,
    voiceAutoSpeak: true,
    elevenLabsApiKey: "xi_1",
    model: "claude-sonnet-5-5",
  };
  assert.equal(migrateVoiceSettings(saved), true);
  assert.equal(saved.dictationProvider, "elevenlabs");
  for (const f of RETIRED) assert.equal(f in saved, false, f);
  assert.equal(saved.model, "claude-sonnet-5-5");
  assert.equal(saved.elevenLabsApiKey, "xi_1");
});

test("GPT-Live, and the early 'realtime' value, dictate with OpenAI", () => {
  for (const engine of ["gpt-live", "realtime"]) {
    const saved: Record<string, unknown> = { voiceEngine: engine, elevenLabsApiKey: "xi_1" };
    migrateVoiceSettings(saved);
    assert.equal(saved.dictationProvider, "openai", engine);
    assert.equal("voiceEngine" in saved, false);
  }
});

test("with no engine saved, dictation follows the key that's there", () => {
  const el: Record<string, unknown> = { elevenLabsApiKey: "xi_1" };
  migrateVoiceSettings(el);
  assert.equal(el.dictationProvider, "elevenlabs");

  const oa: Record<string, unknown> = { openAiApiKey: "sk-1", elevenLabsApiKey: "xi_1" };
  migrateVoiceSettings(oa);
  assert.equal(oa.dictationProvider, "openai");

  const none: Record<string, unknown> = {};
  assert.equal(migrateVoiceSettings(none), false);
  assert.equal("dictationProvider" in none, false);
});

test("a chosen service is kept, and settings already moved aren't saved again", () => {
  const saved: Record<string, unknown> = { dictationProvider: "elevenlabs", openAiApiKey: "sk-1" };
  assert.equal(migrateVoiceSettings(saved), false);
  assert.equal(saved.dictationProvider, "elevenlabs");
});

test("dictation uses the chosen service's key, and names it when it's missing", () => {
  const keys = { elevenLabsApiKey: "xi_1", openAiApiKey: "" };
  const el = dictationSetup({ ...keys, dictationProvider: "elevenlabs" });
  assert.equal(el.provider, "elevenlabs");
  assert.equal(el.apiKey, "xi_1");
  const oa = dictationSetup({ ...keys, dictationProvider: "openai" });
  assert.equal(oa.apiKey, "");
  assert.match(oa.missingKeyNotice, /OpenAI API key/);
});
