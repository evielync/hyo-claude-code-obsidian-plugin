import test from "node:test";
import assert from "node:assert/strict";
import {
  startCall,
  addTurn,
  addHandoff,
  answerHandoff,
  endCall,
  callHasContent,
  formatCallDuration,
  callsFromLegacyTurns,
  mergeStoredCalls,
  upsertCall,
  threadCalls,
  insertCallLine,
  claudeMessageCount,
  finishedClaudeCount,
  handoffRequestText,
  HANDOFF_MARKER,
  unseenTurnsBlock,
  spokenForVoice,
  handoffTask,
  isJustAcknowledgement,
  aboutYouFromNote,
  SPOKEN_MAX_CHARS,
  takeUnseenTurns,
  callOnlySessions,
  sessionSpawn,
  titleFromCall,
  newSessionId,
  placeAtHangUp,
  callHome,
  HANDOFF_NOTE_TEXT,
  type VoiceCallRecord,
} from "../src/voice/voice-call";
import { LIVE_BACKEND_PERSONA, transformScreenBlocks } from "../src/voice/voice-persona";
import { transformScreenBlocks as transformScreenBlocksPhone } from "../src/mobile/voice/voice-persona";

const T0 = Date.parse("2026-10-22T04:14:00Z");

test("a call records turns, hand-offs, answers, duration and how it ended", () => {
  const c = startCall("gpt-live", 3, T0);
  addTurn(c, "agent", "Afternoon, Ev.", T0 + 1000);
  addTurn(c, "user", "What's on my list today?", T0 + 4000);
  addHandoff(c, "d1", "What's on my list today?", T0 + 5000);
  addHandoff(c, "d2", "And tomorrow?", T0 + 9000);
  const h = answerHandoff(c, "Five tasks today.", T0 + 20000);
  assert.equal(h?.id, "d1");
  endCall(c, "hung-up", T0 + 98000);
  assert.equal(c.durationMs, 98000);
  assert.equal(c.endReason, "hung-up");
  assert.equal(c.after, 3);
  assert.equal(c.turns.length, 2);
  assert.equal(c.handoffs[0].answer, "Five tasks today.");
  assert.equal(c.handoffs[1].afterCall, true, "unfinished hand-off is marked as carried on in the chat");
  assert.equal(formatCallDuration(c.durationMs), "01:38");
  // Ending twice keeps the first ending.
  endCall(c, "disconnected", T0 + 200000);
  assert.equal(c.endReason, "hung-up");
});

test("same-side turns arriving back to back merge; empty turns are dropped", () => {
  const c = startCall("gpt-live", 0, T0);
  addTurn(c, "user", "Pull my", T0);
  addTurn(c, "user", "  tasks  ", T0 + 500);
  addTurn(c, "user", "   ", T0 + 600);
  addTurn(c, "agent", "On it.", T0 + 900);
  assert.deepEqual(c.turns.map((t) => t.text), ["Pull my tasks", "On it."]);
  assert.equal(callHasContent(startCall("gpt-live", 0, T0)), false);
  assert.equal(callHasContent(c), true);
});

test("durations format as mm:ss and h:mm:ss", () => {
  assert.equal(formatCallDuration(0), "00:00");
  assert.equal(formatCallDuration(61_400), "01:01");
  assert.equal(formatCallDuration(3_725_000), "1:02:05");
});

test("old per-turn voiceTurns become calls, split on a ten-minute gap", () => {
  const at = (s: number) => new Date(T0 + s * 1000).toISOString();
  const calls = callsFromLegacyTurns([
    { side: "agent", text: "Hi", at: at(0), after: 2 },
    { side: "user", text: "Tasks?", at: at(5), after: 2 },
    { side: "agent", text: "Five.", at: at(40), after: 4 },
    { side: "agent", text: "Morning.", at: at(3600), after: 6 },
  ]);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].after, 4, "the line sits where the call ended");
  assert.equal(calls[0].turns.length, 3);
  assert.equal(calls[0].durationMs, 40000);
  assert.equal(calls[1].after, 6);
  const merged = mergeStoredCalls([{ ...startCall("gpt-live", 4, T0), id: "x" }], [{ side: "user", text: "a", at: at(0), after: 1 }]);
  assert.deepEqual(merged.map((c) => c.after), [1, 4]);
  assert.equal(calls[0].claudeSaw, 3, "0.6.x turns already went to Claude");
});

test("upsert replaces by id", () => {
  const a = startCall("gpt-live", 0, T0);
  const list = upsertCall([a], { ...a, endReason: "hung-up" });
  assert.equal(list.length, 1);
  assert.equal(list[0].endReason, "hung-up");
});

type M = { role: string; content?: string; streaming?: boolean; voiceCall?: VoiceCallRecord };
const line = (c: VoiceCallRecord): M => ({ role: "system", voiceCall: c });

test("call lines thread in before the Claude message at `after`", () => {
  const claude: M[] = [{ role: "user", content: "a" }, { role: "assistant", content: "b" }, { role: "user", content: "c" }];
  const c0 = { ...startCall("gpt-live", 0, T0), id: "c0" };
  const c2 = { ...startCall("gpt-live", 2, T0 + 1), id: "c2" };
  const c9 = { ...startCall("gpt-live", 9, T0 + 2), id: "c9" };
  const out = threadCalls(claude, [c2, c9, c0], line);
  assert.deepEqual(out.map((m) => m.voiceCall?.id || m.content), ["c0", "a", "b", "c2", "c", "c9"]);
  assert.equal(claudeMessageCount(out), 3);
  const c1 = line({ ...startCall("gpt-live", 1, T0), id: "c1" }) as M & { voiceCall: VoiceCallRecord };
  assert.deepEqual(insertCallLine(out, c1).map((m) => m.voiceCall?.id || m.content), ["c0", "a", "c1", "b", "c2", "c", "c9"]);
});

test("hand-off prompts read back as the spoken request", () => {
  const prompt = `${unseenTurnsBlock([{ side: "user", text: "hi", at: "" }, { side: "agent", text: "hey", at: "" }])}\n\nWhat's on today?\n\n${HANDOFF_MARKER} Lead with a short spoken answer.)`;
  assert.equal(handoffRequestText(prompt), "What's on today?");
  assert.match(unseenTurnsBlock([{ side: "user", text: "hi", at: "" }]), /User: hi/);
  assert.equal(unseenTurnsBlock([]), "");
});

test("the voice gets the opening of Claude's reply; the detail below stays in the chat", () => {
  // A normal chat reply: spoken opening, then a list.
  assert.equal(spokenForVoice("Five on today; the check-in prep comes first.\n\n- CoK check-in prep\n- Script the short"),
    "Five on today; the check-in prep comes first. (The rest is in the chat.)");
  // A list straight under the opening line, no blank line.
  assert.equal(spokenForVoice("Here's where it stands:\n| a | b |\n|---|---|"), "Here's where it stands: (The rest is in the chat.)");
  assert.equal(spokenForVoice("## Today\n- a"), "It's in the chat now.", "only detail: point to it");
  assert.equal(spokenForVoice(""), "Done.");
  assert.equal(spokenForVoice("Moved **three** tasks to [[Tasks/Friday|Friday]]."), "Moved three tasks to Friday.");
  // Replies saved by 0.7.0 calls still carry [SCREEN] blocks: still detail, never spoken.
  assert.equal(spokenForVoice("Five on today.\n[SCREEN]\n- Check-in prep\n[/SCREEN]"), "Five on today. (The rest is in the chat.)");
  assert.equal(spokenForVoice("[SCREEN]\n| a | b |\n[/SCREEN]"), "It's in the chat now.");
  assert.doesNotMatch(spokenForVoice("Here.\n[SCREEN]\nx\n[/SCREEN]\n[/SCREEN]"), /SCREEN/);
});

test("Claude is never asked for [SCREEN] blocks on a GPT-Live call", () => {
  assert.doesNotMatch(HANDOFF_NOTE_TEXT, /SCREEN/);
  assert.doesNotMatch(LIVE_BACKEND_PERSONA, /SCREEN|on screen/i);
});

test("[SCREEN] detail in an old reply shows as normal chat text, never an 'On screen' card (desktop and phone)", () => {
  for (const transform of [transformScreenBlocks, transformScreenBlocksPhone]) {
    const out = transform("Five on today.\n[SCREEN]\n**Due**\n- Check-in prep\n[/SCREEN]");
    assert.doesNotMatch(out, /SCREEN|\[!screen\]|On screen/);
    assert.match(out, /^Five on today\.\n\n\*\*Due\*\*/);
    assert.match(out, /- Check-in prep/);
    assert.equal(transform("No markers here."), "No markers here.");
  }
});

test("a reply longer than a spoken answer becomes one append: the facts up front, never several pieces", () => {
  const long = Array.from({ length: 80 }, (_, i) => `Item ${i} is about something specific.`).join(" ");
  const said = spokenForVoice(long);
  assert.ok(said.length <= SPOKEN_MAX_CHARS, `${said.length} chars`);
  assert.match(said, /^Item 0 is about something specific\./);
  assert.match(said, /\(The rest is in the chat\.\)$/);
});

test("finished Claude messages are counted for where the call line goes", () => {
  const call = { ...startCall("gpt-live", 0, T0), endAfter: 1 };
  const msgs: M[] = [
    line(call),
    { role: "user", content: "Asked on the call" },
    { role: "assistant", content: "Your newsletter draft is ready." },
    { role: "user", content: "typed" },
    { role: "assistant", content: "Still going", streaming: true },
  ];
  assert.equal(finishedClaudeCount(msgs), 3);
});

test("the line goes where the call ended: after the call's work; a reply still running lands after it", () => {
  const msgs: M[] = [
    { role: "user", content: "earlier" },
    { role: "assistant", content: "earlier reply" },
    { role: "user", content: "Asked on the call: check the community" },
    { role: "assistant", content: "Nothing needs you." },
    { role: "user", content: "Asked on the call: draft a reply" },
    { role: "assistant", content: "Drafting…", streaming: true },
  ];
  const call = placeAtHangUp(startCall("gpt-live", 2, T0), msgs);
  assert.equal(call.after, 5);
  const out = insertCallLine(msgs, line(call) as M & { voiceCall: VoiceCallRecord });
  assert.deepEqual(out.map((m) => m.voiceCall ? "LINE" : m.content), [
    "earlier", "earlier reply", "Asked on the call: check the community", "Nothing needs you.",
    "Asked on the call: draft a reply", "LINE", "Drafting…",
  ]);
  // Reopened from disk (no streaming then): same place.
  const reopened = threadCalls(msgs.map((m) => ({ ...m, streaming: false })), [call], line);
  assert.equal(reopened.findIndex((m) => m.voiceCall), 5);
});

test("Claude gets the whole ask since the last hand-off, word for word, with the turns it hasn't seen", () => {
  const turns = [
    { side: "user" as const, text: "Morning.", at: "" },
    { side: "agent" as const, text: "Morning! What's up?", at: "" },
    { side: "user" as const, text: "What's in the pool of tasks this week that is not, um, in today", at: "" },
    { side: "user" as const, text: "and what our priorities are", at: "" },
  ];
  const { prompt, said } = handoffTask(turns, 2, 0, "for the newsletter");
  assert.equal(said, "What's in the pool of tasks this week that is not, um, in today and what our priorities are for the newsletter");
  assert.match(prompt, /User: Morning\./, "the unseen call turns ride along");
  assert.match(prompt, /You \(voice\): Morning! What's up\?/);
  assert.ok(prompt.includes(`\n\n${said}\n\n`), "the request itself, verbatim");
  assert.ok(prompt.endsWith(HANDOFF_NOTE_TEXT), "ends with the hand-off note");
  assert.equal(handoffRequestText(prompt), said, "reads back as the request on reopen");
  // Nothing new since the last job: nothing to send.
  assert.deepEqual(handoffTask(turns, 4, 4, ""), { prompt: "", said: "" });
  // Turns Claude already saw aren't repeated.
  assert.doesNotMatch(handoffTask(turns, 4, 4, "and the calendar").prompt, /Morning/);
});

test("answers to the voice and agreement are recognised; real requests aren't", () => {
  for (const t of ["Done", "done.", "Yes", "yeah go ahead", "I've allowed it", "mhm", "okay, all set", "Thanks"]) assert.equal(isJustAcknowledgement(t), true, t);
  for (const t of ["Yes, and move the newsletter to Friday", "What's on today?", "Done with the check-in, what's next?", ""]) assert.equal(isJustAcknowledgement(t), false, t);
});

test("About you from a note drops its frontmatter", () => {
  assert.equal(aboutYouFromNote("---\ntype: reference\ntags: [me]\n---\nI'm Ev. I run a business.\n"), "I'm Ev. I run a business.");
  assert.equal(aboutYouFromNote("No frontmatter here."), "No frontmatter here.");
});

// ---- Calls in a tab Claude was never used in ----

test("Ev's 22 Oct sequence: new tab, call, hand-off answered, hang-up — saved under the tab's own conversation", () => {
  // The hand-off made Claude start the conversation, so the tab has an id by hang-up.
  const tab = { cliSessionId: "47a7b979-df9e-4228-b5a5-20d96be69fbb", title: "Community check-in" };
  const c = startCall("gpt-live", 0, T0);
  addTurn(c, "agent", "Morning, Ev.", T0 + 1000);
  addTurn(c, "user", "Check the community", T0 + 60000);
  addHandoff(c, "d1", "Check the community", T0 + 62000);
  answerHandoff(c, "Nothing needs you.", T0 + 92000);
  endCall(c, "hung-up", T0 + 129000);
  const msgs: M[] = [
    { role: "user", content: "Check the community" },
    { role: "assistant", content: "Nothing needs you." },
  ];
  placeAtHangUp(c, msgs);
  const home = callHome(tab, c, () => "should-not-be-used");
  assert.deepEqual(home, { sessionId: tab.cliSessionId, minted: false });
  assert.equal(c.after, 2, "line after the request and the answer");
});

test("a call in a brand-new tab gets its own conversation id and a title from what Ev said first", () => {
  const c = startCall("gpt-live", 0, T0);
  addTurn(c, "agent", "Morning, Ev.", T0);
  addTurn(c, "user", "Just testing the new voice features in Hyo today", T0 + 3000);
  endCall(c, "hung-up", T0 + 20000);
  const home = callHome({ cliSessionId: null, title: "New conversation" }, c, () => "11111111-2222-4333-8444-555555555555");
  assert.deepEqual(home, { sessionId: "11111111-2222-4333-8444-555555555555", minted: true, title: "Just testing the new voice features in H..." });
  assert.equal(titleFromCall(startCall("gpt-live", 0, T0)), "Voice chat");
  assert.match(newSessionId(), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test("a call-only conversation shows in history; one Claude has written is listed from its transcript instead", () => {
  const c = startCall("gpt-live", 0, T0);
  addTurn(c, "user", "Remind me what's on Friday", T0 + 1000);
  addTurn(c, "agent", "Two calls and the newsletter.", T0 + 4000);
  endCall(c, "hung-up", T0 + 9000);
  const meta = {
    "call-only": { customTitle: "Remind me what's on Friday", voiceCalls: [c], pinned: true },
    "has-file": { voiceCalls: [c] },
    "no-calls": { customTitle: "x" },
  };
  const rows = callOnlySessions(meta, (id) => id === "has-file");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, "call-only");
  assert.equal(rows[0].title, "Remind me what's on Friday");
  assert.equal(rows[0].lastRole, "assistant");
  assert.equal(rows[0].lastSnippet, "Two calls and the newsletter.");
  assert.equal(rows[0].date, T0 + 9000);
  assert.equal(rows[0].pinned, true);
  // No saved title: the first thing the user said.
  assert.equal(callOnlySessions({ a: { voiceCalls: [c] } }, () => false)[0].title, "Remind me what's on Friday");
});

test("the first typed message starts Claude on that same conversation, and carries the call", () => {
  // Claude hasn't written it yet: --session-id with Hyo's id, not --resume.
  assert.deepEqual(sessionSpawn("abc", true), { sessionId: "abc", resume: false });
  assert.deepEqual(sessionSpawn("abc", false), { sessionId: "abc", resume: true });
  assert.deepEqual(sessionSpawn(null, false), { resume: false });

  const c = startCall("gpt-live", 0, T0);
  addTurn(c, "agent", "Morning, Ev.", T0);
  addTurn(c, "user", "Remind me to call Dani", T0 + 3000);
  endCall(c, "hung-up", T0 + 9000);
  // As reopened from disk: a call line, nothing else.
  const msgs: M[] = [line(JSON.parse(JSON.stringify(c)))];
  const first = takeUnseenTurns(msgs);
  assert.deepEqual(first.turns.map((t) => t.text), ["Morning, Ev.", "Remind me to call Dani"]);
  assert.equal(first.advanced.length, 1);
  assert.equal(first.advanced[0].claudeSaw, 2, "marked seen, to be saved");
  assert.match(unseenTurnsBlock(first.turns), /User: Remind me to call Dani/);
  // The next message doesn't repeat them.
  assert.equal(takeUnseenTurns(msgs).turns.length, 0);
});

test("turns ride along from the call that's on now, then only the new ones", () => {
  const live = startCall("gpt-live", 0, T0);
  addTurn(live, "user", "Hi", T0);
  assert.deepEqual(takeUnseenTurns([], live).turns.map((t) => t.text), ["Hi"]);
  addTurn(live, "agent", "Hey", T0 + 5000);
  assert.deepEqual(takeUnseenTurns([], live).turns.map((t) => t.text), ["Hey"]);
  // ElevenLabs calls never ride along: Claude was the voice.
  const el = startCall("elevenlabs", 0, T0);
  addTurn(el, "user", "x", T0);
  assert.equal(takeUnseenTurns([line(el)]).turns.length, 0);
});
