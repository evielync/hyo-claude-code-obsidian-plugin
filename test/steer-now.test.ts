// "Send now" on a waiting message: it goes into the reply under way instead of
// after it (session-owner.ts). The fake process below plays back what the
// Claude CLI was seen doing on 28 Oct 2026 (2.1.280, stream-json in and out,
// --replay-user-messages):
//
//   - a message written mid-reply is held until the reply's next tool call
//     finishes, then echoed back ({type:"user", isReplay:true, uuid}) and
//     taken into the same reply, which ends with one result;
//   - a reply with no tool calls left ends first (result), then Claude answers
//     the held message as its own turn: command_lifecycle "started", then the
//     echo, then the answer and a second result;
//   - two held messages answered that way are taken in together: the first is
//     echoed alone, then one echo carries both under the second's uuid;
//   - an interrupt ends the reply, and the held message still runs next.
import test from "node:test";
import assert from "node:assert/strict";
import { SessionOwner, gatewaySession, gatewaySessionReset, setSessionOwnerFactory, sessionOwner, shutdownSessionOwners, type OwnerSpec, type ProcLike } from "../src/session-owner";
import { queued, steering, steered, turnStarted, replayBase } from "../src/live-sync";
import { startQueued } from "../src/send-queue";
import { parseSessionEntries } from "../src/session-parser";
import { parseSessionLines } from "../src/mobile/session-parser";

function fakes(opts: { steer?: boolean } = {}) {
  const procs: { sent: any[]; uuids: (string | undefined)[]; stopped: boolean; emit: (e: any) => void; close: (c: number | null) => void; proc: ProcLike }[] = [];
  const make = (_spec: OwnerSpec, on: any) => {
    const rec: any = { sent: [], uuids: [], stopped: false };
    rec.emit = (e: any) => on.onMessage(e);
    rec.close = (c: number | null) => on.onClose(c);
    rec.proc = {
      spawn() {},
      sendUserMessage(c: any, o: { uuid?: string } = {}) {
        rec.sent.push(c);
        rec.uuids.push(o.uuid);
      },
      sendPermissionResponse() {},
      sendInterrupt() {
        rec.sent.push({ interrupt: true });
      },
      stop() {
        rec.stopped = true;
      },
      isRunning() {
        return !rec.stopped;
      },
      ...(opts.steer === false ? {} : { canSteer: () => !rec.stopped }),
    };
    procs.push(rec);
    return rec.proc;
  };
  return { procs, make };
}

const spec = (): OwnerSpec => ({ cliPath: "claude", cwd: "/work", model: "claude-opus-5-5", permissionMode: "acceptEdits", sessionId: "s-1" });
const listen = () => {
  const events: any[] = [];
  return { events, sub: { onEvent: (e: any) => events.push(e) } };
};
const result = { type: "result", subtype: "success" };
const echo = (uuid: string, text = "") => ({ type: "user", isReplay: true, uuid, message: { role: "user", content: [{ type: "text", text }] } });
const lifecycle = (uuid: string, state: string) => ({ type: "command_lifecycle", command_uuid: uuid, state });
const toolUse = { type: "assistant", message: { id: "m1", content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] } };
const toolResult = { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "1" }] } };
const words = (text: string) => ({ type: "assistant", message: { id: "m2", content: [{ type: "text", text }] } });
const of = (events: any[], type: string) => events.filter((e) => e.type === type);
const textOf = (c: any) => (typeof c === "string" ? c : c?.[0]?.text);

/** A conversation mid-reply with three messages waiting, seen by the laptop and the phone. */
function midReply(opts: { steer?: boolean } = {}) {
  const { procs, make } = fakes(opts);
  const owner = new SessionOwner(make, { sessionId: "s-1" });
  const laptop = listen();
  const phone = listen();
  const l = owner.subscribe(laptop.sub);
  const p = owner.subscribe(phone.sub);
  owner.send(l, spec(), "count to four, one tool call each", "q0");
  procs[0].emit(echo("ignored-first-echo", "count to four, one tool call each"));
  procs[0].emit(toolUse);
  owner.send(l, spec(), "first waiting", "q1");
  owner.send(p, spec(), "stop counting, say PINEAPPLE", "q2");
  owner.send(l, spec(), "third waiting", "q3");
  return { procs, owner, laptop, phone, l, p };
}

test("Send now: the chosen message leaves the queue, goes to Claude at once, and every view shows it on its way", () => {
  const { procs, owner, laptop, phone } = midReply();
  assert.deepEqual(of(laptop.events, "hyo_queued").map((e) => [e.qid, e.steerable]), [["q1", true], ["q2", true], ["q3", true]]);
  assert.equal(owner.sendNow("q2"), true);
  assert.equal(procs[0].sent.length, 2, "written to the process straight away");
  assert.equal(textOf(procs[0].sent[1]), "stop counting, say PINEAPPLE");
  assert.match(procs[0].uuids[1]!, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, "sent with a uuid Claude echoes back");
  for (const v of [laptop, phone]) assert.deepEqual(v.events.at(-1), { type: "hyo_steering", qid: "q2" });
  // Someone opening it now sees it on its way, ahead of the two still waiting.
  const late = listen();
  owner.subscribe(late.sub);
  const r = late.events.find((e) => e.type === "hyo_replay");
  assert.deepEqual(r.queued.map((q: any) => [q.qid, !!q.steering]), [["q2", true], ["q1", false], ["q3", false]]);
  // A second press (here, or on the other device) does nothing.
  assert.equal(owner.sendNow("q2"), false);
  assert.equal(procs[0].sent.length, 2);
});

test("taken in at the next tool call: shown there on every view, one reply, and never sent again", () => {
  const { procs, owner, laptop, phone } = midReply();
  owner.sendNow("q2");
  const uuid = procs[0].uuids[1]!;
  const before = laptop.events.length;
  procs[0].emit(toolResult);
  procs[0].emit(echo(uuid, "stop counting, say PINEAPPLE"));
  for (const v of [laptop, phone]) {
    assert.ok(!v.events.some((e) => e.type === "user" && e.isReplay), "Claude's echo never reaches a view");
    assert.deepEqual(v.events.at(-1), { type: "hyo_steered", qid: "q2", text: "stop counting, say PINEAPPLE" });
  }
  procs[0].emit(lifecycle(uuid, "started"));
  procs[0].emit(words("PINEAPPLE"));
  assert.equal(of(laptop.events.slice(before), "hyo_steered").length, 1, "told once");
  procs[0].emit(result);
  // The turn ended: the next waiting message goes, the chosen one doesn't go again.
  assert.deepEqual(procs[0].sent.slice(2).map(textOf), ["first waiting"]);
  procs[0].emit(result);
  assert.deepEqual(procs[0].sent.slice(2).map(textOf), ["first waiting", "third waiting"]);
  procs[0].emit(result);
  assert.equal(procs[0].sent.length, 4, "each message went exactly once");
  assert.equal(owner.busy, false);
});

test("a reply with no tool calls left ends first: Claude answers it next, as its own turn, without it being sent twice", () => {
  const { procs, owner, laptop, phone } = midReply();
  owner.sendNow("q2");
  const uuid = procs[0].uuids[1]!;
  // The reply was only writing: it ends without taking the message in.
  procs[0].emit(words("an essay"));
  procs[0].emit(result);
  for (const v of [laptop, phone]) {
    const started = of(v.events, "hyo_user_message").at(-1);
    assert.deepEqual(started, { type: "hyo_user_message", qid: "q2", text: "stop counting, say PINEAPPLE" }, "its turn starts at once");
  }
  assert.equal(procs[0].sent.length, 2, "not written again, and the next waiting message is held back");
  assert.equal(owner.busy, true);
  // Claude starts it (as observed: lifecycle, a fresh init, the echo, the answer, a result).
  procs[0].emit(lifecycle(uuid, "started"));
  procs[0].emit({ type: "system", subtype: "init", session_id: "s-1" });
  procs[0].emit(echo(uuid, "stop counting, say PINEAPPLE"));
  procs[0].emit(words("PINEAPPLE"));
  assert.equal(of(laptop.events, "hyo_steered").length, 0, "it began its own turn; nothing to move");
  procs[0].emit(result);
  assert.deepEqual(procs[0].sent.slice(2).map(textOf), ["first waiting"], "then the queue carries on in order");
});

test("pressed just as the reply ends: whichever lands first wins, and nothing goes twice", () => {
  // The reply's end is handled first: the first waiting message is already on its way.
  const a = midReply();
  a.procs[0].emit(result);
  assert.equal(a.owner.sendNow("q1"), false, "q1 already went");
  assert.deepEqual(a.procs[0].sent.slice(1).map(textOf), ["first waiting"]);
  // The next one can still steer the turn q1 started.
  assert.equal(a.owner.sendNow("q3"), true);
  assert.deepEqual(a.procs[0].sent.slice(1).map(textOf), ["first waiting", "third waiting"]);
  a.procs[0].emit(result);
  // q3's own turn starts (it wasn't taken in), and q2 still waits behind it.
  assert.equal(of(a.laptop.events, "hyo_user_message").at(-1).qid, "q3");
  assert.equal(a.procs[0].sent.length, 3);
  a.procs[0].emit(echo(a.procs[0].uuids[2]!));
  a.procs[0].emit(result);
  assert.deepEqual(a.procs[0].sent.slice(1).map(textOf), ["first waiting", "third waiting", "stop counting, say PINEAPPLE"]);
});

test("two sent now in a reply that's only writing: one turn takes both in, each said once", () => {
  const { procs, owner, laptop } = midReply();
  owner.sendNow("q1");
  owner.sendNow("q3");
  const [u1, u3] = [procs[0].uuids[1]!, procs[0].uuids[2]!];
  procs[0].emit(result);
  assert.equal(of(laptop.events, "hyo_user_message").at(-1).qid, "q1");
  // As observed: the first echoed alone, both start, then one echo for both.
  procs[0].emit(echo(u1));
  procs[0].emit(lifecycle(u1, "started"));
  procs[0].emit(lifecycle(u3, "started"));
  assert.deepEqual(of(laptop.events, "hyo_steered"), [{ type: "hyo_steered", qid: "q3", text: "third waiting" }]);
  procs[0].emit(echo(u3, "first waiting\nthird waiting"));
  procs[0].emit(words("both"));
  procs[0].emit(result);
  assert.equal(of(laptop.events, "hyo_steered").length, 1);
  assert.deepEqual(procs[0].sent.slice(1).map(textOf), ["first waiting", "third waiting", "stop counting, say PINEAPPLE"]);
});

test("the process ends before Claude takes it in: it waits again, first, and goes once to the next process", () => {
  const { procs, owner, laptop } = midReply();
  owner.sendNow("q2");
  // Ended cleanly (a process that crashes within 5 seconds of starting drops
  // what's waiting instead, as it always has, so it isn't restarted in a loop).
  procs[0].close(0);
  const back = of(laptop.events, "hyo_queued").at(-1);
  assert.equal(back.qid, "q2", "shown waiting again");
  assert.equal(procs.length, 2, "a fresh process for what's waiting");
  assert.deepEqual(procs[1].sent.map(textOf), ["stop counting, say PINEAPPLE"], "it goes first, once");
  procs[1].emit(result);
  procs[1].emit(result);
  procs[1].emit(result);
  assert.deepEqual(procs[1].sent.map(textOf), ["stop counting, say PINEAPPLE", "first waiting", "third waiting"]);
});

test("a held message Claude drops is sent again, never lost", () => {
  const { procs, owner, laptop } = midReply();
  owner.sendNow("q2");
  const uuid = procs[0].uuids[1]!;
  procs[0].emit(result);
  assert.equal(of(laptop.events, "hyo_user_message").at(-1).qid, "q2");
  procs[0].emit(lifecycle(uuid, "cancelled"));
  assert.equal(of(laptop.events, "hyo_queued").at(-1).qid, "q2", "back to waiting");
  assert.deepEqual(procs[0].sent.slice(1).map(textOf), ["stop counting, say PINEAPPLE", "stop counting, say PINEAPPLE"], "written again, as a normal turn");
  assert.equal(procs[0].uuids[2], undefined);
});

test("a Claude without --replay-user-messages: no Send now offered, and asking does nothing", () => {
  const { procs, owner, laptop } = midReply({ steer: false });
  assert.deepEqual(of(laptop.events, "hyo_queued").map((e) => e.steerable), [false, false, false]);
  assert.equal(owner.sendNow("q2"), false);
  assert.equal(procs[0].sent.length, 1);
});

test("the echo of an ordinary message never reaches a view", () => {
  const { procs, make } = fakes();
  const owner = new SessionOwner(make, { sessionId: "s-1" });
  const v = listen();
  const id = owner.subscribe(v.sub);
  owner.send(id, spec(), "hello", "q0");
  procs[0].emit(echo("whatever", "hello"));
  procs[0].emit(words("hi"));
  procs[0].emit(result);
  assert.equal(v.events.filter((e) => e.type === "user").length, 0);
  assert.equal(of(v.events, "hyo_user_message").length, 1);
});

test("Send now from the phone goes through the gateway to the Mac's owner", () => {
  const { procs, make } = fakes();
  setSessionOwnerFactory({ make });
  try {
    const owner = sessionOwner("/work", "s-1")!;
    const laptop = listen();
    const l = owner.subscribe(laptop.sub);
    owner.send(l, spec(), "working", "q0");
    const sent: any[] = [];
    const ws = {};
    const sink = { send: (o: any) => sent.push(o) };
    const ctx = { cwd: "/work", mintId: () => "minted", specFor: () => spec() };
    gatewaySession({ type: "prompt", tabId: "phone-tab", sessionId: "s-1", text: "change course", qid: "qp" }, ws, sink, ctx);
    assert.equal(sent.at(-1).event.type, "hyo_queued");
    assert.equal(sent.at(-1).event.steerable, true);
    assert.equal(gatewaySession({ type: "send_now", tabId: "phone-tab", qid: "qp" }, ws, sink, ctx), true);
    assert.deepEqual(procs[0].sent.map(textOf), ["working", "change course"]);
    assert.deepEqual(sent.at(-1), { type: "stream", tabId: "phone-tab", event: { type: "hyo_steering", qid: "qp" } });
    assert.deepEqual(laptop.events.at(-1), { type: "hyo_steering", qid: "qp" });
  } finally {
    gatewaySessionReset();
    shutdownSessionOwners();
    setSessionOwnerFactory(null);
  }
});

// ---- what each view shows ----

const user = (text: string, extra: any = {}) => ({ role: "user", content: text, displayText: text, ...extra });
const reply = (text: string, extra: any = {}) => ({ role: "assistant", content: text, toolCalls: [], orderedBlocks: [], ...extra });

test("view: waiting offers Send now, pressing shows it on its way, taking it in moves it to where the reply is up to", () => {
  let msgs: any[] = [user("count", { sendId: "q0" }), reply("1, 2", { streaming: true })];
  msgs = queued(msgs, { qid: "q1", text: "first waiting", steerable: true });
  msgs = queued(msgs, { qid: "q2", text: "pineapple", steerable: true });
  assert.equal(msgs.at(-1).steerable, true);
  msgs = steering(msgs, "q2");
  assert.equal(msgs.at(-1).steering, true);
  assert.equal(msgs.at(-1).steerable, undefined, "no second button");
  assert.equal(msgs.at(-1).queuedId, "q2", "still waiting until Claude takes it in");
  msgs = steered(msgs, { qid: "q2", text: "pineapple" });
  assert.deepEqual(
    msgs.map((m) => [m.role, m.content, !!m.streaming, m.queuedId || null]),
    [
      ["user", "count", false, null],
      ["assistant", "1, 2", false, null],
      ["user", "pineapple", false, null],
      ["assistant", "", true, null],
      ["user", "first waiting", false, "q1"],
    ]
  );
  assert.equal(msgs[2].steering, undefined);
  assert.equal(msgs[2].sendId, "q2");
});

test("view: a view that opened mid-turn adds it from the text; one that never got going leaves no empty reply", () => {
  const fresh = steered([user("count", { sendId: "q0" }), reply("1", { streaming: true })], { qid: "q2", text: "pineapple" });
  assert.deepEqual(fresh.map((m: any) => [m.role, m.content]), [["user", "count"], ["assistant", "1"], ["user", "pineapple"], ["assistant", ""]]);
  const empty = steered([user("count", { sendId: "q0" }), reply("", { streaming: true }), user("pineapple", { queuedId: "q2", steering: true })], { qid: "q2" });
  assert.deepEqual(empty.map((m: any) => [m.role, m.content]), [["user", "count"], ["user", "pineapple"], ["assistant", ""]]);
});

test("view: its own turn after a reply that only wrote: it goes ahead of anything queued before it", () => {
  let msgs: any[] = [user("essay", { sendId: "q0" }), reply("an essay"), user("first waiting", { queuedId: "q1", sendId: "q1" }), user("pineapple", { queuedId: "q2", sendId: "q2", steering: true })];
  const started = turnStarted(msgs, { qid: "q2", text: "pineapple" });
  assert.equal(started.kind, "started-queued");
  assert.deepEqual(started.messages.map((m: any) => [m.role, m.content, m.queuedId || null, !!m.steering]), [
    ["user", "essay", null, false],
    ["assistant", "an essay", null, false],
    ["user", "pineapple", null, false],
    ["assistant", "", null, false],
    ["user", "first waiting", "q1", false],
  ]);
  // In order, it stays where it was.
  msgs = [reply("x"), user("a", { queuedId: "a" }), user("b", { queuedId: "b" })];
  assert.deepEqual(startQueued(msgs, "a", reply("", { streaming: true }) as any).map((m: any) => m.content), ["x", "a", "", "b"]);
});

test("view: a Send now that never reached Claude waits again, with the button back", () => {
  let msgs: any[] = [reply("1", { streaming: true }), user("pineapple", { queuedId: "q2", sendId: "q2", steering: true })];
  msgs = queued(msgs, { qid: "q2", text: "pineapple", steerable: true });
  assert.equal(msgs.at(-1).steering, undefined);
  assert.equal(msgs.at(-1).steerable, true);
  assert.equal(queued(msgs, { qid: "q2", text: "pineapple", steerable: true }), msgs, "told twice: no change");
});

test("view: catching up mid-turn rebuilds the reply around a message taken in partway", () => {
  // A reconnecting view: its own earlier copy of the turn goes, the replay puts it back once.
  const shown: any[] = [user("count", { sendId: "q0" }), reply("1", { streaming: false }), user("pineapple", { sendId: "q2" }), reply("PINE", { streaming: true })];
  let msgs = replayBase(shown, { qid: "q0", text: "count" });
  assert.deepEqual(msgs.map((m: any) => m.content), ["count", ""]);
  msgs = steered(msgs, { qid: "q2", text: "pineapple" });
  assert.deepEqual(msgs.map((m: any) => [m.role, m.content]), [["user", "count"], ["user", "pineapple"], ["assistant", ""]]);
});

// ---- reopening the conversation ----

// What the CLI wrote for the 28 Oct tool-call test, trimmed to the lines that matter.
const transcript = [
  { type: "user", uuid: "00000000", message: { role: "user", content: [{ type: "text", text: "Run four commands, one at a time" }] } },
  { type: "assistant", message: { id: "m1", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "sleep 3; echo 1" } }] } },
  { type: "queue-operation", operation: "enqueue" },
  { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "1" }] } },
  { type: "attachment", attachment: { type: "queued_command", prompt: [{ type: "text", text: "STEER: say PINEAPPLE" }], source_uuid: "11111111", commandMode: "prompt" } },
  { type: "attachment", attachment: { type: "hook_success", hookName: "UserPromptSubmit", content: "ignored" } },
  { type: "queue-operation", operation: "remove" },
  { type: "assistant", message: { id: "m2", content: [{ type: "text", text: "PINEAPPLE" }] } },
  // A held task notification is Claude's own, never the person's.
  { type: "attachment", attachment: { type: "queued_command", prompt: "<task-notification>done</task-notification>", commandMode: "task-notification" } },
];

for (const [where, parse] of [["desktop", parseSessionEntries], ["phone", parseSessionLines]] as const) {
  test(`${where}: a reopened conversation shows the message where Claude took it in, with the reply split around it`, () => {
    const msgs = parse(transcript as any[]);
    assert.deepEqual(
      msgs.map((m: any) => [m.role, m.content]),
      [
        ["user", "Run four commands, one at a time"],
        ["assistant", ""],
        ["user", "STEER: say PINEAPPLE"],
        ["assistant", "PINEAPPLE"],
      ]
    );
    assert.equal(msgs[1].toolCalls?.[0]?.result, "1");
  });
}
