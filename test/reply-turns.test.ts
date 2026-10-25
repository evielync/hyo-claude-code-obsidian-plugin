import test from "node:test";
import assert from "node:assert/strict";
import {
  newStreamState,
  processContentBlocks,
  buildSnapshot,
  endTurn,
  startsTurnOfItsOwn,
  openReply,
  isSidechainEvent,
  isSelfStartedPrompt,
  type StreamState,
} from "../src/reply-stream";
import { parseSessionEntries } from "../src/session-parser";
import { parseSessionLines } from "../src/mobile/session-parser";

// Ev, 26 Oct: a background agent finished and Claude replied on its own,
// twice more, with no new message from her. Hyo showed only the last reply;
// the earlier ones were written over, leaving just their "Ran a command" line.

type M = { role: string; content: string; streaming?: boolean; toolCalls?: any[]; orderedBlocks?: any[] };

// Replays the session managers (desktop and phone run the same steps): a send
// adds the person's message, a reply slot and a fresh stream state; content
// streams into the last reply; a result ends the turn.
function chat() {
  let msgs: M[] = [];
  let ss: StreamState = newStreamState();
  const updateLast = (patch: Partial<M>) => {
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === "assistant") {
        msgs = msgs.map((m, j) => (j === i ? { ...m, ...patch } : m));
        return;
      }
    }
  };
  return {
    send(text: string) {
      ss = newStreamState();
      msgs = [...msgs, { role: "user", content: text }, { role: "assistant", content: "", streaming: true }];
    },
    feed(event: any) {
      if (event.type === "system") return;
      if (event.type === "result") {
        if (isSidechainEvent(event)) return;
        endTurn(ss, event);
        updateLast({ streaming: false });
        return;
      }
      if (startsTurnOfItsOwn(ss, event)) {
        msgs = openReply(msgs, { role: "assistant", content: "", streaming: true });
      }
      if ((event.type === "user" || event.type === "assistant") && !isSidechainEvent(event)) {
        processContentBlocks(event.message?.content || [], ss, event.type);
        updateLast(buildSnapshot(ss));
      }
    },
    get msgs() {
      return msgs;
    },
  };
}

// The events as Claude Code 2.1 writes them to stdout (captured from a real
// run): a turn ends on `result`; a background task finishing emits
// task_notification and a fresh init, then the new turn streams like any other.
const assistant = (...content: any[]) => ({ type: "assistant", parent_tool_use_id: null, message: { role: "assistant", content } });
const toolResult = (id: string, text: string) => ({ type: "user", parent_tool_use_id: null, message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: text }] } });
const text = (t: string) => ({ type: "text", text: t });
const thinking = { type: "thinking", thinking: "" };
const bash = (id: string) => ({ type: "tool_use", id, name: "Bash", input: { command: "git status" } });
const result = (extra: any = {}) => ({ type: "result", subtype: "success", ...extra });
const selfStart = [
  { type: "system", subtype: "task_notification", task_id: "a051", status: "completed" },
  { type: "system", subtype: "init", session_id: "s1" },
];

const FIRST = "It's well along. The call screen is done.";
const SECOND = "The build is done, and the quick test calls went well.";
const THIRD = "No change: that was the build's test watcher shutting down.";
const FOURTH = "No change. The build is still ready and waiting on the dictation question.";

function replayEvsSession() {
  const c = chat();
  c.send("Where's the build up to?");
  c.feed({ type: "system", subtype: "init", session_id: "s1" });
  c.feed(assistant(bash("t1")));
  c.feed(toolResult("t1", "voice-gptlive-v2"));
  c.feed(assistant(text(FIRST)));
  c.feed(result());
  // A background agent finishes: Claude runs a command, then reports.
  for (const e of selfStart) c.feed(e);
  c.feed(assistant(thinking));
  c.feed(assistant(bash("t2")));
  c.feed(toolResult("t2", "mobile-dictation-long-recordings"));
  c.feed(assistant(text(SECOND)));
  c.feed(result({ origin: { kind: "task-notification" } }));
  // Two more notifications, each answered with text straight away.
  for (const e of selfStart) c.feed(e);
  c.feed(assistant(thinking));
  c.feed(assistant(text(THIRD)));
  c.feed(result({ origin: { kind: "task-notification" } }));
  for (const e of selfStart) c.feed(e);
  c.feed(assistant(thinking));
  c.feed(assistant(text(FOURTH)));
  c.feed(result({ origin: { kind: "task-notification" } }));
  return c.msgs;
}

test("replies Claude starts on its own each stay in the chat, in order, below the last one", () => {
  const msgs = replayEvsSession();
  assert.deepEqual(
    msgs.map((m) => `${m.role}: ${m.content}`),
    [
      "user: Where's the build up to?",
      `assistant: ${FIRST}`,
      `assistant: ${SECOND}`,
      `assistant: ${THIRD}`,
      `assistant: ${FOURTH}`,
    ]
  );
  // Each reply keeps its own commands, and nothing is left streaming.
  assert.deepEqual(msgs.map((m) => (m.toolCalls || []).map((t) => t.id)), [[], ["t1"], ["t2"], [], []]);
  assert.ok(msgs.every((m) => !m.streaming));
});

test("a sub-agent finishing mid-turn doesn't split the reply", () => {
  const c = chat();
  c.send("Get an agent on it");
  c.feed(assistant({ type: "tool_use", id: "a1", name: "Agent", input: {} }));
  c.feed({ type: "assistant", parent_tool_use_id: "a1", message: { content: [text("agent's own words")] } });
  c.feed(result({ parent_tool_use_id: "a1" }));
  c.feed(toolResult("a1", "report"));
  c.feed(assistant(text("Here's what it found.")));
  c.feed(result());
  assert.deepEqual(c.msgs.map((m) => `${m.role}: ${m.content}`), ["user: Get an agent on it", "assistant: Here's what it found."]);
});

test("the next message Ev sends still gets its reply in its own slot", () => {
  const c = chat();
  c.send("one");
  c.feed(assistant(text("first")));
  c.feed(result());
  for (const e of selfStart) c.feed(e);
  c.feed(assistant(text("on its own")));
  c.feed(result());
  c.send("two");
  c.feed(assistant(text("second")));
  c.feed(result());
  assert.deepEqual(
    c.msgs.map((m) => `${m.role}: ${m.content}`),
    ["user: one", "assistant: first", "assistant: on its own", "user: two", "assistant: second"]
  );
});

// The same conversation as Claude saved it to disk, which is what reopening
// it reads (desktop from the file, the phone through the gateway).
let uid = 0;
const row = (o: any) => ({ uuid: `u${++uid}`, sessionId: "s1", timestamp: "2026-10-25T21:19:49.317Z", ...o });
const human = (t: string) => row({ type: "user", promptSource: "sdk", message: { role: "user", content: [{ type: "text", text: t }] } });
const notification = (legacy = false) =>
  row({
    type: "user",
    ...(legacy ? {} : { origin: { kind: "task-notification" }, promptSource: "system", turnOrigin: "task_notification" }),
    message: { role: "user", content: "<task-notification>\n<task-id>a051</task-id>\n<status>completed</status>\n</task-notification>" },
  });
const said = (id: string, ...content: any[]) => row({ type: "assistant", message: { id, role: "assistant", content } });
const ran = (id: string, out: string) => row({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: out }] } });

function savedSession(legacy = false) {
  return [
    human("Where's the build up to?"),
    said("m1", bash("t1")),
    ran("t1", "voice-gptlive-v2"),
    said("m2", text(FIRST)),
    notification(legacy),
    said("m3", thinking),
    said("m3", bash("t2")),
    ran("t2", "mobile-dictation-long-recordings"),
    said("m4", text(SECOND)),
    notification(legacy),
    said("m5", text(THIRD)),
    notification(legacy),
    said("m6", text(FOURTH)),
    human("What is the dictation question?"),
    said("m7", text("You don't need to answer it any more.")),
  ];
}

test("reopening the conversation shows every reply Claude started on its own, in order (desktop and phone)", () => {
  for (const parse of [parseSessionEntries, parseSessionLines]) {
    for (const legacy of [false, true]) {
      const msgs = parse(savedSession(legacy));
      assert.deepEqual(
        msgs.map((m) => `${m.role}: ${m.content}`),
        [
          "user: Where's the build up to?",
          `assistant: ${FIRST}`,
          `assistant: ${SECOND}`,
          `assistant: ${THIRD}`,
          `assistant: ${FOURTH}`,
          "user: What is the dictation question?",
          "assistant: You don't need to answer it any more.",
        ]
      );
      assert.deepEqual(msgs[2].toolCalls?.map((t) => [t.id, t.result]), [["t2", "mobile-dictation-long-recordings"]]);
    }
  }
});

test("a prompt Claude wrote for itself is never taken for Ev's message", () => {
  assert.equal(isSelfStartedPrompt(notification()), true);
  assert.equal(isSelfStartedPrompt(notification(true)), true);
  assert.equal(isSelfStartedPrompt(row({ type: "user", promptSource: "system", isMeta: true, message: { content: "Another Claude session says..." } })), true);
  assert.equal(isSelfStartedPrompt(human("Is <task-notification> a tag?")), false);
  assert.equal(isSelfStartedPrompt(ran("t1", "<task-notification>")), false);
});
