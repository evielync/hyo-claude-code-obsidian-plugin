import { runBank, DATA, type MakeBuild } from "./harness";
import { SCENARIOS } from "./scenarios";
import { LiveCall } from "../../src/voice/live-call";
import { GptLiveSession, buildLiveInstructions, readAgentIdentity } from "../../src/voice/gpt-live";
import { resolveLiveVoice } from "../../src/voice/live-voice";
import { describeStep, attentionLine } from "../../src/voice/voice-words";
import { LIVE_BACKEND_PERSONA } from "../../src/voice/voice-persona";

/** This build (voice-gptlive-v2): LiveCall, as Hyo runs it, on the WebSocket path. */
const make: MakeBuild = (key, h) => {
  const v = resolveLiveVoice(DATA.gptLiveVoice, DATA.gptLiveCustomVoices);
  const instructions = buildLiveInstructions(DATA.voicePersonality || "", readAgentIdentity(DATA.defaultAgent || "chad"), {
    voiceDescription: v.description,
    aboutYou: process.env.ABOUT_YOU ?? DATA.voiceAboutYou ?? "",
  });
  const call = new LiveCall({
    transports: ["ws"],
    after: 0,
    session: { apiKey: key, voice: v.voice, instructions, history: [], headless: h.headless },
    onHandoff: (prompt, said) => h.job(prompt, said),
    onTurn: (side, text) => h.onTurn(side, text),
    onUi: () => {},
    onLive: () => h.onLive(),
    onEnded: (record, reason) => h.onEnded(record, reason),
    onError: (m) => h.onError(m),
    createSession: (o) => new GptLiveSession(o),
  });
  return {
    start: () => call.start(),
    hangUp: () => call.hangUp(),
    claudeReply: (md) => call.finishReply(md),
    claudeStep: (name, input) => call.step(describeStep(name, input)),
    permissionAsked: (tool, input) => call.notifyAttention(attentionLine("permission", tool, input)),
    permissionAnswered: (allowed) => call.permissionAnswered(allowed),
    record: () => call.callRecord,
  };
};

void runBank("v2", SCENARIOS, make, LIVE_BACKEND_PERSONA);
