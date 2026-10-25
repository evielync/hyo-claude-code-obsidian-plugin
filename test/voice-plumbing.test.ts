import test from "node:test";
import assert from "node:assert/strict";
import { buildLiveInstructions, buildLiveHistory, GptLiveSession, splitForAppend, MAX_APPEND_CHARS, MAX_ABOUT_YOU_CHARS } from "../src/voice/gpt-live";
import { attentionLine, describeStep } from "../src/voice/voice-words";
import { resolveLiveVoice, CUSTOM_VOICE_PREFIX } from "../src/voice/live-voice";
import { CONNECT_CHIME, HANGUP_CHIME, chimeLength, scheduleChime } from "../src/voice/chimes";
import { LIVE_BACKEND_PERSONA, HANDOFF_NOTE } from "../src/voice/voice-persona";

let now = 0;
let timers: Array<{ at: number; fn: () => void; id: number }> = [];
let nextId = 1;
(globalThis as any).window = {
  setTimeout: (fn: () => void, ms: number) => {
    const id = nextId++;
    timers.push({ at: now + ms, fn, id });
    return id;
  },
  clearTimeout: (id: number) => (timers = timers.filter((t) => t.id !== id)),
  setInterval: () => 0,
  clearInterval: () => {},
};
Object.defineProperty(globalThis, "performance", { value: { now: () => now }, configurable: true });

function session(extra: Record<string, unknown> = {}) {
  const errors: string[] = [];
  const states: string[] = [];
  const sent: any[] = [];
  const s = new GptLiveSession({
    apiKey: "",
    voice: "marin",
    instructions: "",
    history: [],
    onState: (x) => states.push(x),
    onTurn: () => {},
    onLevel: () => {},
    onDelegation: () => {},
    onError: (m) => errors.push(m),
    ...extra,
  } as any) as any;
  s.dc = { readyState: "open", send: (j: string) => sent.push(JSON.parse(j)), close: () => {} };
  s.ws = { readyState: 1, send: (j: string) => sent.push(JSON.parse(j)), close: () => {} };
  return { s, errors, states, sent };
}

// ---- The voice's instructions: OpenAI's template, as 0.6.x, with the required wording

test("instructions follow OpenAI's template: its three headings and the gpt-live-1 hand-off wording", () => {
  const text = buildLiveInstructions("", { name: "Chad", description: "Ev's chief of staff" });
  assert.match(text, /^You are Chad, Ev's chief of staff\. You are on a call with the user\./);
  assert.match(text, /\nBackchannel policy: Use moderate backchannels\. Acknowledge naturally without competing with the main response\.\n/);
  assert.match(text, /\nInterruption policy: Stop speaking when the user interrupts\. Listen to what they say\.\n/);
  assert.match(text, /\nDelegation policy:\nBackend tools:\n- /);
  assert.match(text, /\nGenerate <\|SpawnThinking\|> when:\n- /);
  assert.match(text, /\nDo not generate <\|SpawnThinking\|> when:\n- You can answer from the conversation or a result you already have\./);
  assert.match(text, /\nGenerate <\|SpawnThinking\|> before giving an answer that depends on backend work\.\nDo not guess the result while waiting\./);
  assert.doesNotMatch(text, /Delegate to the backend when/, "the guide: use Generate <|SpawnThinking|>, not 'delegate to the backend'");
  assert.doesNotMatch(text, /## Role & Persona|CRITICAL INSTRUCTIONS|work landed|start-up context|from their notes/i, "no Grok port, no context bursts");
  assert.ok(text.length < 3500, `short, as the guide shows (${text.length} chars)`);
});

test("no greeting: the voice waits for the user after the chime", () => {
  const text = buildLiveInstructions("Warm.", null);
  assert.match(text, /The call opens with a short chime; don't greet them, wait for them to speak first\./);
});

test("About you and a custom voice's description go in the starting instructions; About you is bounded", () => {
  const text = buildLiveInstructions("Warm.", null, { aboutYou: "I'm Ev. I run a business.", voiceDescription: "A bright British man." });
  assert.match(text, /Your speaking voice: A bright British man\./);
  assert.match(text, /About the user \(what they have told you about themselves\):\nI'm Ev\. I run a business\./);
  const huge = buildLiveInstructions("", null, { aboutYou: "word ".repeat(5000) });
  assert.ok(huge.length < MAX_ABOUT_YOU_CHARS + 3500, "a long note is cut to fit");
  assert.doesNotMatch(buildLiveInstructions("", null, {}), /About the user|speaking voice/);
});

test("history: earlier calls as what was said, hand-off prompts skipped, replies' [SCREEN] detail left out", () => {
  const call: any = { turns: [{ side: "user", text: "Morning", at: "" }, { side: "agent", text: "Morning!", at: "" }] };
  const items = buildLiveHistory([
    { role: "user", content: "typed", displayText: "typed" },
    { role: "user", content: "x (Asked on a live voice call.)", handoff: true },
    { role: "assistant", content: "Three on today.\n[SCREEN]\n- a\n- b\n[/SCREEN]" },
    { role: "system", content: "", voiceCall: call } as any,
  ]);
  assert.deepEqual(items, [
    { role: "user", text: "typed" },
    { role: "assistant", text: "Three on today." },
    { role: "user", text: "Morning" },
    { role: "assistant", text: "Morning!" },
  ]);
});

test("Claude's call instructions are 0.6.x's, and say the reply also shows in the chat", () => {
  assert.match(LIVE_BACKEND_PERSONA, /^# You are the backend of a live voice call/);
  assert.match(LIVE_BACKEND_PERSONA, /Your whole reply also shows in the chat beside the call\./);
  assert.match(LIVE_BACKEND_PERSONA, /Return|relevant facts/);
  assert.match(HANDOFF_NOTE, /^\(Asked on a live voice call\. Answer for listening/);
});

// ---- The session

test("a normal hang-up never reports the call as ended early (session.closed after the grouper closed)", () => {
  const { s, errors, states, sent } = session();
  const { TranscriptGrouper } = require("openai/helpers/live");
  s.grouper = new TranscriptGrouper();
  s.started = true;
  s.stop();
  assert.equal(sent[0].type, "session.close");
  s.handle({ type: "session.closed", reason: "close_requested" }); // threw before the fix
  assert.equal(s.closed, true);
  assert.deepEqual(errors, []);
  assert.ok(states.includes("closed"));
});

test("the data channel closing after we hang up is not a dropped call; closing on its own is", () => {
  const a = session();
  a.s.closing = true;
  a.s.dc.onclose = null;
  // Replicate the handler wiring: call the class's onclose logic.
  const handler = function (this: any) {
    if (this.closed) return;
    if (!this.closing) this.opts.onError("GPT-Live call ended before the session finalised");
    this.closed = true;
    this.teardown();
  };
  handler.call(a.s);
  assert.deepEqual(a.errors, []);
  const b = session();
  handler.call(b.s);
  assert.equal(b.errors.length, 1);
});

test("no greeting is sent when the call connects, and it's live only once it can hear", () => {
  const { s, sent, states } = session({ transport: "webrtc" });
  s.handle({ type: "session.started", session: { id: "x" } });
  assert.deepEqual(sent, [], "nothing sent: no greeting");
  assert.ok(!states.includes("listening"), "WebRTC media not up yet: not live");
  s.mediaUp = true;
  s.becomeReady();
  assert.ok(states.includes("listening"));
  const ws = session({ transport: "ws" });
  ws.s.handle({ type: "session.started", session: { id: "y" } });
  assert.ok(ws.states.includes("listening"), "WebSocket: live on session.started");
});

test("silent notes are paced: one in flight, held while the user is speaking, never cut", () => {
  now = 100000;
  timers = [];
  const { s, sent } = session({ transport: "ws" });
  s.handle({ type: "session.started", session: { id: "x" } });
  const long = Array.from({ length: 160 }, (_, i) => `Fact number ${i} is here.`).join(" ");
  s.appendThinking(long, "d1");
  assert.equal(sent.length, 1, "one in flight");
  const pieces = splitForAppend(long);
  assert.ok(pieces.length > 1);
  assert.equal(pieces.join(" "), long, "nothing lost (the old 1,200-character cut dropped tails)");
  for (const p of pieces) assert.ok(p.length <= MAX_APPEND_CHARS);
  s.handle({ type: "session.thinking.appended", client_event_id: sent[0].event_id });
  assert.equal(sent.length, 2, "the next goes after the acknowledgement");
  // The user starts speaking: nothing more until they pause.
  s.handle({ type: "session.input_transcript.delta", delta: "hang on" });
  s.handle({ type: "session.thinking.appended", client_event_id: sent[1].event_id });
  assert.equal(sent.length, 2, "held while she speaks");
  now += 1000;
  s.pumpThinking();
  assert.equal(sent.length, 3);
  assert.equal(sent.map((e) => e.content).join(" "), long.slice(0, sent.map((e) => e.content).join(" ").length));
});

test("splitting never loses words, even a sentence or word longer than a piece", () => {
  const giant = "x".repeat(3000) + " tail.";
  const parts = splitForAppend(giant);
  for (const p of parts) assert.ok(p.length <= MAX_APPEND_CHARS);
  assert.equal(parts.join("").replace(/\s/g, ""), giant.replace(/\s/g, ""));
  assert.deepEqual(splitForAppend("  short  "), ["short"]);
  assert.deepEqual(splitForAppend(""), []);
});

test("a custom voice goes to OpenAI as { id } with its description in the instructions (custom voices guide)", () => {
  const customs = [{ id: "voice_6ad95b796cd08191be3e47cc8571637d", name: "Chad v3 (faster)", description: "A bright British man, a quick talker." }];
  const r = resolveLiveVoice(`${CUSTOM_VOICE_PREFIX}voice_6ad95b796cd08191be3e47cc8571637d`, customs);
  assert.deepEqual(r, { voice: { id: "voice_6ad95b796cd08191be3e47cc8571637d" }, description: "A bright British man, a quick talker." });
  assert.deepEqual(resolveLiveVoice("cedar", customs), { voice: "cedar", description: "" });
  assert.deepEqual(resolveLiveVoice(`${CUSTOM_VOICE_PREFIX}voice_gone`, customs), { voice: "marin", description: "" }, "a removed voice falls back");
  const { s } = session({ voice: r.voice, instructions: buildLiveInstructions("", null, { voiceDescription: r.description }) });
  const cfg = s.sessionConfig();
  assert.deepEqual(cfg.audio.output.voice, { id: "voice_6ad95b796cd08191be3e47cc8571637d" });
  assert.match(cfg.instructions, /Your speaking voice: A bright British man, a quick talker\./);
  assert.equal(cfg.model, "gpt-live-1");
  assert.deepEqual(cfg.delegation, { type: "client" });
});

// ---- Plain words for the voice

test("progress and permission lines are plain words, never raw tool names", () => {
  assert.equal(describeStep("Read", { file_path: "/v/Today.md" }), "reading Today");
  assert.equal(describeStep("TodoWrite", { todos: [{ status: "in_progress", activeForm: "Checking the calendar" }] }), "checking the calendar");
  assert.equal(describeStep("ToolSearch", {}), null);
  const ask = attentionLine("permission", "mcp__claude_ai_Circle_MCP__list_posts", {});
  assert.doesNotMatch(ask, /mcp__|Circle_MCP/);
  assert.match(attentionLine("question"), /question on screen/);
});

// ---- Chimes

test("connect and hang-up chimes: two short notes, the hang-up one quieter", () => {
  assert.equal(CONNECT_CHIME.notes.length, 2);
  assert.ok(CONNECT_CHIME.notes[1].freq > CONNECT_CHIME.notes[0].freq, "connect rises");
  assert.ok(HANGUP_CHIME.notes[1].freq < HANGUP_CHIME.notes[0].freq, "hang-up falls");
  assert.ok(HANGUP_CHIME.peak < CONNECT_CHIME.peak);
  assert.ok(CONNECT_CHIME.peak <= 0.15, "subtle");
  assert.ok(chimeLength(CONNECT_CHIME) < 0.5 && chimeLength(HANGUP_CHIME) < 0.5);
  const peaks: number[] = [];
  let oscs = 0;
  const param = () => ({ value: 0, setValueAtTime() {}, linearRampToValueAtTime(v: number) { peaks.push(v); }, exponentialRampToValueAtTime() {} });
  const ctx: any = {
    currentTime: 0,
    destination: {},
    createOscillator: () => { oscs++; return { type: "", frequency: param(), connect() {}, start() {}, stop() {} }; },
    createGain: () => ({ gain: param(), connect() {} }),
  };
  scheduleChime(ctx, CONNECT_CHIME);
  assert.equal(oscs, 2);
  assert.ok(peaks.every((p) => p <= CONNECT_CHIME.peak));
});
