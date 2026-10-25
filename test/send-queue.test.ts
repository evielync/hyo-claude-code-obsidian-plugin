import test from "node:test";
import assert from "node:assert/strict";
import { addOutgoing, startQueued, nextQueued, lastReplyIndex } from "../src/send-queue";
import { startCall, placeAtHangUp, insertCallLine, type VoiceCallRecord } from "../src/voice/voice-call";

type M = { role: string; content: string; streaming?: boolean; queuedId?: string; voiceCall?: VoiceCallRecord };
const user = (t: string): M => ({ role: "user", content: t });
const slot = (): M => ({ role: "assistant", content: "", streaming: true });

// Replays the session manager: send while busy queues; replies stream into
// the last reply slot; a finished turn sends the next queued message.
function sim() {
  let msgs: M[] = [];
  let busy = false;
  let q = 0;
  const queue: string[] = [];
  return {
    send(t: string) {
      if (busy) {
        const id = `q${++q}`;
        queue.push(id);
        msgs = addOutgoing(msgs, user(t), slot(), true, id);
      } else {
        msgs = addOutgoing(msgs, user(t), slot(), false, "");
        busy = true;
      }
    },
    stream(text: string) {
      const i = lastReplyIndex(msgs);
      msgs = msgs.map((m, j) => (j === i ? { ...m, content: m.content + text } : m));
    },
    finish() {
      const i = lastReplyIndex(msgs);
      msgs = msgs.map((m, j) => (j === i ? { ...m, streaming: false } : m));
      busy = false;
      const next = queue.shift();
      if (next) {
        msgs = startQueued(msgs, next, slot());
        busy = true;
      }
    },
    get msgs() {
      return msgs;
    },
  };
}

test("Ev's second test: hand-offs sent while Claude was still answering keep every request and reply, in order", () => {
  const s = sim();
  s.send("Check the community");
  s.stream("Nothing needs you.");
  s.send("Give me an overview"); // arrives while the first is still streaming
  s.stream(" Nobody is waiting on a reply.");
  s.send("Why can't you just read it"); // and another
  s.finish(); // first turn ends → second goes
  assert.equal(nextQueued(s.msgs)?.content, "Why can't you just read it");
  s.stream("The overview.");
  s.finish(); // → third goes
  s.stream("Here are all six threads.");
  s.finish();
  const call = placeAtHangUp(startCall("gpt-live", 0, 0), s.msgs);
  const out = insertCallLine(s.msgs, { role: "system", content: "", voiceCall: call } as M & { voiceCall: VoiceCallRecord });
  assert.deepEqual(
    out.map((m) => (m.voiceCall ? "LINE" : `${m.role}: ${m.content}`)),
    [
      "user: Check the community",
      "assistant: Nothing needs you. Nobody is waiting on a reply.",
      "user: Give me an overview",
      "assistant: The overview.",
      "user: Why can't you just read it",
      "assistant: Here are all six threads.",
      "LINE",
    ]
  );
  assert.ok(out.every((m) => !m.queuedId && !m.streaming));
});

test("a queued message shows at once, before its reply slot exists", () => {
  const s = sim();
  s.send("one");
  s.send("two");
  assert.deepEqual(s.msgs.map((m) => m.content), ["one", "", "two"]);
  assert.equal(lastReplyIndex(s.msgs), 1, "the running reply is still the one being written");
});
