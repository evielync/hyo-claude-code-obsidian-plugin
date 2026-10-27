import test from "node:test";
import assert from "node:assert/strict";
import {
  LiveCall,
  NOTE_STARTED,
  NOTE_QUEUED,
  NOTE_SAME_ERRAND,
  NOTE_ANSWER_TO_YOU,
  NOTE_NOTHING_HEARD,
  NOTE_ALLOWED,
  SAY_STILL_WORKING,
  STILL_WORKING_MS,
  PROGRESS_GAP_MS,
  TRANSCRIPT_GRACE_MS,
} from "../src/voice/live-call";
import type { VoiceCallRecord } from "../src/voice/voice-call";

// A controllable clock for window timers and performance.now().
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
function advance(ms: number) {
  const end = now + ms;
  for (;;) {
    timers.sort((a, b) => a.at - b.at);
    const t = timers[0];
    if (!t || t.at > end) break;
    timers.shift();
    now = t.at;
    t.fn();
  }
  now = end;
}

// A fake GPT-Live session: records what Hyo sends the voice, and lets the
// test play the voice's side (turns, delegations, a dropped line).
class FakeSession {
  sent: Array<{ kind: "say" | "think"; text: string; id: string | null }> = [];
  stopped = false;
  openUserText = "";
  constructor(public o: any) {}
  async start() {
    this.o.onState("listening");
  }
  appendCommentary(text: string, id: string | null) {
    this.sent.push({ kind: "say", text, id });
  }
  appendThinking(text: string, id: string | null = null) {
    this.sent.push({ kind: "think", text, id });
  }
  setMuted() {}
  stop() {
    this.stopped = true;
    this.o.onState("closed");
  }
}

function makeCall() {
  now = 0;
  timers = [];
  let session!: FakeSession;
  const jobs: Array<{ prompt: string; said: string }> = [];
  const ended: Array<{ record: VoiceCallRecord | null; reason: string }> = [];
  const errors: string[] = [];
  let lives = 0;
  const call = new LiveCall({
    transports: ["webrtc"],
    after: 4,
    session: { apiKey: "", voice: "", instructions: "", history: [] },
    onHandoff: (prompt, said) => jobs.push({ prompt, said }),
    onUi: () => {},
    onLive: () => lives++,
    onEnded: (record, reason) => ended.push({ record, reason }),
    onError: (m) => errors.push(m),
    createSession: (o) => (session = new FakeSession(o)) as any,
  });
  return {
    call,
    get s() {
      return session;
    },
    jobs,
    ended,
    errors,
    get lives() {
      return lives;
    },
  };
}

test("the call is live (chime) once, when the session can hear", async () => {
  const c = makeCall();
  await c.call.start();
  assert.equal(c.lives, 1);
  c.s.o.onState("speaking");
  c.s.o.onState("listening");
  assert.equal(c.lives, 1, "no second chime");
});

test("a hand-off: Claude gets the whole ask, the voice gets a silent 'started' note, then the spoken part of the reply", async () => {
  const c = makeCall();
  await c.call.start();
  c.s.o.onTurn("user", "What's on today?");
  c.s.o.onTurn("agent", "Let me see.");
  c.s.o.onDelegation("d1", "");
  assert.equal(c.jobs.length, 1);
  assert.equal(c.jobs[0].said, "What's on today?");
  assert.match(c.jobs[0].prompt, /What's on today\?\n\n\(Asked on a live voice call\./);
  assert.deepEqual(c.s.sent, [{ kind: "think", text: NOTE_STARTED, id: "d1" }]);
  c.s.sent = [];
  c.call.finishReply("Five on today; the check-in prep comes first.\n\n- Check-in prep\n- Script the short");
  const said = "Five on today; the check-in prep comes first. (The rest is in the chat.)";
  assert.deepEqual(c.s.sent, [{ kind: "say", text: said, id: "d1" }], "one spoken result, no list");
  assert.equal(c.call.working, false);
  assert.equal(c.call.callRecord.handoffs[0].answer, said);
});

test("Ev's fourth call: her whole rambling question goes, including what she's still saying; the next job carries only what's new", async () => {
  const c = makeCall();
  await c.call.start();
  c.s.o.onTurn("user", "What's in the pool of tasks this week that is not, um, in today,");
  c.s.o.onDelegation("d1", "What our priorities are");
  assert.equal(c.jobs[0].said, "What's in the pool of tasks this week that is not, um, in today, What our priorities are");
  // The open fragment closes into a longer turn: only the new words count next time.
  c.s.o.onTurn("user", "What our priorities are for the launch");
  c.call.finishReply("Three in the pool.");
  c.s.o.onTurn("user", "And move the newsletter to Friday.");
  c.s.o.onDelegation("d2", "");
  assert.equal(c.jobs.length, 2);
  assert.equal(c.jobs[1].said, "for the launch And move the newsletter to Friday.");
  assert.doesNotMatch(c.jobs[1].prompt, /pool of tasks/, "nothing repeated to Claude");
});

test("one job per ask: a repeat delegation with nothing new said starts nothing", async () => {
  const c = makeCall();
  await c.call.start();
  c.s.o.onTurn("user", "What have I got on?");
  c.s.o.onDelegation("d1", "");
  c.s.o.onDelegation("d2", "");
  advance(TRANSCRIPT_GRACE_MS + 10);
  assert.equal(c.jobs.length, 1);
  assert.deepEqual(c.s.sent.at(-1), { kind: "think", text: NOTE_SAME_ERRAND, id: "d2" });
  // The same words again while it runs: still one job.
  c.s.o.onTurn("user", "What have I got on?");
  c.s.o.onDelegation("d3", "");
  assert.equal(c.jobs.length, 1);
  c.call.finishReply("Three things.");
  assert.equal(c.s.sent.filter((x) => x.kind === "say").length, 1, "one spoken result");
});

test("the transcript trailing the hand-off: Hyo waits a moment for it rather than asking her to repeat", async () => {
  const c = makeCall();
  await c.call.start();
  c.s.o.onDelegation("d1", "");
  assert.equal(c.jobs.length, 0);
  c.s.openUserText = "Check my calendar";
  advance(TRANSCRIPT_GRACE_MS);
  assert.equal(c.jobs.length, 1);
  assert.equal(c.jobs[0].said, "Check my calendar");
  // With nothing heard at all, the voice is told to ask (0.6.x).
  const d = makeCall();
  await d.call.start();
  d.s.o.onDelegation("x", "");
  advance(TRANSCRIPT_GRACE_MS);
  assert.deepEqual(d.s.sent, [{ kind: "think", text: NOTE_NOTHING_HEARD, id: "x" }]);
  assert.equal(d.jobs.length, 0);
});

test("Ev's 00:25 call: 'Done' after allowing a permission is an answer to the voice, not a new job", async () => {
  const c = makeCall();
  await c.call.start();
  c.s.o.onTurn("user", "Check the community.");
  c.s.o.onDelegation("d1", "");
  c.call.permissionAnswered(true);
  assert.deepEqual(c.s.sent.at(-1), { kind: "think", text: NOTE_ALLOWED, id: "d1" }, "told quietly");
  c.s.o.onTurn("user", "Done.");
  c.s.o.onDelegation("d2", "");
  assert.equal(c.jobs.length, 1);
  assert.deepEqual(c.s.sent.at(-1), { kind: "think", text: NOTE_ANSWER_TO_YOU, id: "d2" });
  c.call.finishReply("Nothing in the community needs you.");
  assert.deepEqual(c.s.sent.at(-1), { kind: "say", text: "Nothing in the community needs you.", id: "d1" });
  // "Yes" to the voice's offer once nothing runs is a job, with the offer for context.
  c.s.o.onTurn("agent", "Want me to draft a welcome post?");
  c.s.o.onTurn("user", "Yes.");
  c.s.o.onDelegation("d3", "");
  assert.equal(c.jobs.length, 2);
  assert.match(c.jobs[1].prompt, /You \(voice\): Want me to draft a welcome post\?/, "Claude sees what she said yes to");
});

test("replies never overwrite each other: a hand-off while Claude answers waits, and the earlier answer is kept silent", async () => {
  const c = makeCall();
  await c.call.start();
  c.s.o.onTurn("user", "Check the first thing.");
  c.s.o.onDelegation("d1", "");
  c.s.o.onTurn("user", "And check the second thing.");
  c.s.o.onDelegation("d2", "");
  assert.equal(c.jobs.length, 2);
  assert.deepEqual(c.s.sent.at(-1), { kind: "think", text: NOTE_QUEUED, id: "d2" });
  c.s.sent = [];
  c.call.finishReply("First answer.");
  assert.deepEqual(c.s.sent, [{ kind: "think", text: "Earlier result, now superseded: First answer.", id: "d1" }]);
  c.call.finishReply("Second answer.");
  assert.deepEqual(c.s.sent.at(-1), { kind: "say", text: "Second answer.", id: "d2" });
  assert.deepEqual(c.call.callRecord.handoffs.map((h) => h.answer), ["First answer.", "Second answer."]);
});

test("progress: short silent notes, at most one per gap, the latest step winning", async () => {
  const c = makeCall();
  await c.call.start();
  now = 10000;
  c.s.o.onTurn("user", "Pull my tasks.");
  c.s.o.onDelegation("d1", "");
  c.s.sent = [];
  c.call.step("reading Today");
  c.call.step('searching for "due"');
  c.call.step("checking the calendar");
  assert.deepEqual(c.s.sent, [{ kind: "think", text: "The backend agent is reading Today. No result yet.", id: "d1" }]);
  advance(PROGRESS_GAP_MS);
  assert.deepEqual(c.s.sent.at(-1), { kind: "think", text: "The backend agent is checking the calendar. No result yet.", id: "d1" });
  assert.equal(c.s.sent.length, 2);
  assert.ok(c.s.sent.every((x) => x.kind === "think"), "never spoken");
});

test("a long job gets one spoken 'still working' at 25 seconds, and none once it's answered", async () => {
  const c = makeCall();
  await c.call.start();
  c.s.o.onTurn("user", "Research the launch.");
  c.s.o.onDelegation("d1", "");
  advance(STILL_WORKING_MS - 1);
  assert.equal(c.s.sent.filter((x) => x.kind === "say").length, 0);
  advance(1);
  assert.deepEqual(c.s.sent.at(-1), { kind: "say", text: SAY_STILL_WORKING, id: "d1" });
  advance(STILL_WORKING_MS * 3);
  assert.equal(c.s.sent.filter((x) => x.text === SAY_STILL_WORKING).length, 1, "once");
  const d = makeCall();
  await d.call.start();
  d.s.o.onTurn("user", "Quick one.");
  d.s.o.onDelegation("q", "");
  d.call.finishReply("Done it.");
  advance(STILL_WORKING_MS * 2);
  assert.equal(d.s.sent.filter((x) => x.text === SAY_STILL_WORKING).length, 0);
});

test("a reply to something typed during the call: the voice knows it, silently", async () => {
  const c = makeCall();
  await c.call.start();
  c.call.finishReply("Moved the meeting to Friday.");
  assert.equal(c.s.sent.length, 1);
  assert.equal(c.s.sent[0].kind, "think");
  assert.match(c.s.sent[0].text, /Moved the meeting to Friday/);
});

test("hanging up mid-job: the record keeps the job as finishing in the chat, the session closes, no error", async () => {
  const c = makeCall();
  await c.call.start();
  c.s.o.onTurn("user", "Draft the newsletter.");
  c.s.o.onDelegation("d1", "");
  c.call.hangUp();
  assert.equal(c.s.stopped, true);
  assert.equal(c.ended.length, 1);
  assert.equal(c.ended[0].reason, "hung-up");
  const rec = c.ended[0].record!;
  assert.equal(rec.handoffs[0].afterCall, true);
  assert.equal(rec.turns[0].text, "Draft the newsletter.");
  assert.deepEqual(c.errors, []);
  // Claude's reply arriving after the call never goes to the closed session.
  const before = c.s.sent.length;
  c.call.finishReply("Here's the draft.");
  assert.equal(c.s.sent.length, before);
  advance(STILL_WORKING_MS * 2);
  assert.equal(c.s.sent.length, before, "no timers fire after hang-up");
});

test("a dropped line ends the call as disconnected; a call with nothing said keeps no record", async () => {
  const c = makeCall();
  await c.call.start();
  c.s.o.onState("closed");
  assert.equal(c.ended[0].reason, "disconnected");
  assert.equal(c.ended[0].record, null);
});

test("nothing Hyo gives the voice for a reply is more than one append", async () => {
  const c = makeCall();
  await c.call.start();
  c.s.o.onTurn("user", "Check the community.");
  c.s.o.onDelegation("d1", "");
  const threads = Array.from({ length: 12 }, (_, i) => `${i + 1}. **Thread ${i}**: ${"members discussed it at length. ".repeat(10)}`).join("\n");
  c.call.finishReply(`The community has been busy.\n\n${threads}`);
  const says = c.s.sent.filter((x) => x.kind === "say");
  assert.equal(says.length, 1);
  assert.ok(says[0].text.length <= 1200, `${says[0].text.length} chars`);
  assert.equal(c.s.sent.length, 2, "the started note and one spoken result: no burst");
});
