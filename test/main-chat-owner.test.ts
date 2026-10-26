import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  MainChatOwner,
  MainChatTransport,
  gatewayMainChat,
  gatewayClientGone,
  lockHeldByOther,
  fileLock,
  displayText,
  MAIN_CHAT_WIRE_ID,
  type OwnerSpec,
  type ProcLike,
} from "../src/main-chat-owner";
import { withMainChatReminder } from "../src/main-chat";

// A stand-in Claude process: records what it's sent; the test plays its stream.
function fakes() {
  const procs: { spec: OwnerSpec; sent: any[]; stopped: boolean; emit: (e: any) => void; close: (c: number | null) => void; proc: ProcLike }[] = [];
  const make = (spec: OwnerSpec, on: any) => {
    const rec: any = { spec, sent: [], stopped: false };
    rec.emit = (e: any) => on.onMessage(e);
    rec.close = (c: number | null) => on.onClose(c);
    rec.proc = {
      spawn() {},
      sendUserMessage(c: any) {
        rec.sent.push(c);
      },
      sendPermissionResponse(id: string, b: string) {
        rec.sent.push({ permission: id, b });
      },
      sendInterrupt() {},
      stop() {
        rec.stopped = true;
      },
      isRunning() {
        return !rec.stopped;
      },
    };
    procs.push(rec);
    return rec.proc;
  };
  return { procs, make };
}

const spec = (extra: Partial<OwnerSpec> = {}): OwnerSpec => ({ cliPath: "claude", cwd: "/vault", model: "claude-opus-5-5", permissionMode: "acceptEdits", agent: "chad", sessionId: "main-1", resume: true, appendSystemPrompt: "MAIN", ...extra });
const listen = () => {
  const events: any[] = [];
  return { events, sub: { onEvent: (e: any) => events.push(e) } };
};
const result = { type: "result", subtype: "success" };

test("the laptop and the phone share one Claude process for the main chat", () => {
  const { procs, make } = fakes();
  const owner = new MainChatOwner(make);
  const laptop = listen();
  const phone = listen();
  const l = owner.subscribe(laptop.sub);
  const p = owner.subscribe(phone.sub);
  owner.send(l, spec(), withMainChatReminder("check my email"));
  procs[0].emit(result);
  owner.send(p, spec(), [{ type: "text", text: "and my calendar" }]);
  assert.equal(procs.length, 1, "one process, whoever sends");
  assert.equal(procs[0].sent.length, 2);
  // Each side hears what the other said, without the hidden reminder.
  assert.deepEqual(phone.events.find((e) => e.type === "hyo_user_message"), { type: "hyo_user_message", text: "check my email" });
  assert.deepEqual(laptop.events.find((e) => e.type === "hyo_user_message"), { type: "hyo_user_message", text: "and my calendar" });
  assert.equal(laptop.events.filter((e) => e.type === "hyo_user_message").length, 1, "never its own message back");
  // Both get the stream.
  assert.ok(laptop.events.includes(result) && phone.events.includes(result));
});

test("a message sent mid-turn waits for the turn, so turns never interleave", () => {
  const { procs, make } = fakes();
  const owner = new MainChatOwner(make);
  const a = owner.subscribe(listen().sub);
  const b = owner.subscribe(listen().sub);
  owner.send(a, spec(), "one");
  owner.send(b, spec(), "two");
  assert.deepEqual(procs[0].sent, ["one"]);
  procs[0].emit(result);
  assert.deepEqual(procs[0].sent, ["one", "two"]);
});

test("leaving never stops the process; only a restart does, and not while work runs", () => {
  const { procs, make } = fakes();
  const owner = new MainChatOwner(make);
  const a = owner.subscribe(listen().sub);
  owner.send(a, spec(), "go");
  owner.detach(a);
  assert.equal(procs[0].stopped, false, "closing the panel or pocketing the phone");
  assert.equal(owner.restart(), false, "mid-turn: refused");
  procs[0].emit({ type: "system", subtype: "task_started", task_id: "t1", description: "Check Gmail" });
  procs[0].emit(result);
  assert.equal(owner.restart(), false, "a background job is running: refused");
  procs[0].emit({ type: "system", subtype: "task_notification", task_id: "t1", status: "completed" });
  assert.equal(owner.restart(), true);
  assert.equal(procs[0].stopped, true);
});

test("a different system prompt (a call starting) swaps the process only when idle", () => {
  const { procs, make } = fakes();
  const owner = new MainChatOwner(make);
  const a = owner.subscribe(listen().sub);
  owner.send(a, spec(), "hi");
  procs[0].emit({ type: "system", subtype: "init", session_id: "main-1" });
  procs[0].emit({ type: "system", subtype: "task_started", task_id: "t1", description: "x" });
  procs[0].emit(result);
  owner.send(a, spec({ appendSystemPrompt: "MAIN+VOICE" }), "on a call now");
  assert.equal(procs.length, 1, "kept while the job runs");
  procs[0].emit({ type: "system", subtype: "task_notification", task_id: "t1", status: "completed" });
  procs[0].emit(result);
  owner.send(a, spec({ appendSystemPrompt: "MAIN+VOICE", sessionId: null }), "now");
  assert.equal(procs.length, 2);
  assert.equal(procs[0].stopped, true);
  assert.equal(procs[1].spec.sessionId, "main-1", "the new process carries on the same conversation");
  assert.equal(procs[1].spec.resume, true);
});

test("someone joining mid-turn learns the jobs running and that a turn is under way", () => {
  const { procs, make } = fakes();
  const owner = new MainChatOwner(make);
  const a = owner.subscribe(listen().sub);
  owner.send(a, spec(), "go");
  procs[0].emit({ type: "system", subtype: "task_started", task_id: "t1", description: "Check Gmail" });
  const late = listen();
  owner.subscribe(late.sub);
  assert.equal(late.events[0].subtype, "background_tasks_changed");
  assert.equal(late.events[0].tasks[0].description, "Check Gmail");
  assert.equal(late.events[1].type, "hyo_busy");
});

test("a permission answered on one side clears the card on the other", () => {
  const { procs, make } = fakes();
  const owner = new MainChatOwner(make);
  const laptop = listen();
  const a = owner.subscribe(laptop.sub);
  const b = owner.subscribe(listen().sub);
  owner.send(a, spec(), "go");
  owner.permission(b, "req-1", "allow");
  assert.deepEqual(procs[0].sent[1], { permission: "req-1", b: "allow" });
  assert.deepEqual(laptop.events.at(-1), { type: "hyo_permission_answered", requestId: "req-1", behavior: "allow" });
});

test("the phone attaches through the gateway instead of starting its own", () => {
  const { procs, make } = fakes();
  const owner = new MainChatOwner(make);
  const laptop = listen();
  const l = owner.subscribe(laptop.sub);
  owner.send(l, spec(), "from the laptop");
  const sent: any[] = [];
  const ws = {};
  const specFor = (m: any) => spec({ appendSystemPrompt: m.appendSystemPrompt });
  // The phone opens: attach, then it hears the laptop's turn.
  assert.equal(gatewayMainChat(owner, { type: "reattach", tabIds: [MAIN_CHAT_WIRE_ID] }, ws, { send: (o) => sent.push(o) }, specFor), false);
  procs[0].emit({ type: "assistant", message: { content: [{ type: "text", text: "On it." }] } });
  assert.ok(sent.some((o) => o.type === "stream" && o.tabId === MAIN_CHAT_WIRE_ID && o.event.type === "assistant"));
  procs[0].emit(result);
  // The phone sends: same process, and the laptop hears it.
  assert.equal(gatewayMainChat(owner, { type: "prompt", tabId: MAIN_CHAT_WIRE_ID, text: "from the phone", appendSystemPrompt: "MAIN" }, ws, { send: (o) => sent.push(o) }, specFor), true);
  assert.equal(procs.length, 1);
  assert.deepEqual(procs[0].sent[1], [{ type: "text", text: "from the phone" }]);
  assert.deepEqual(laptop.events.at(-1), { type: "hyo_user_message", text: "from the phone" });
  // Reattaching again doesn't double the phone's events.
  gatewayMainChat(owner, { type: "reattach", tabIds: [MAIN_CHAT_WIRE_ID] }, ws, { send: (o) => sent.push(o) }, specFor);
  assert.equal(owner.subscribers, 2);
  // The phone's "stop" and its socket closing only detach.
  gatewayMainChat(owner, { type: "stop", tabId: MAIN_CHAT_WIRE_ID }, ws, { send: () => {} }, specFor);
  gatewayClientGone(owner, ws);
  assert.equal(owner.subscribers, 1);
  assert.equal(procs[0].stopped, false);
  // Anything that isn't the main chat goes to the gateway as before.
  assert.equal(gatewayMainChat(owner, { type: "prompt", tabId: "another-tab", text: "x" }, ws, { send: () => {} }, specFor), false);
});

test("two Hyo panels on one Mac drive the same process", () => {
  const { procs, make } = fakes();
  const owner = new MainChatOwner(make);
  const on = () => ({ onMessage: () => {}, onError: () => {}, onClose: () => {} });
  const panel1 = new MainChatTransport(owner, spec(), on());
  const panel2 = new MainChatTransport(owner, spec(), on());
  panel1.spawn();
  panel2.spawn();
  panel1.sendUserMessage("one");
  procs[0].emit(result);
  panel2.sendUserMessage("two");
  assert.equal(procs.length, 1);
  panel1.stop();
  assert.equal(procs[0].stopped, false, "closing one panel leaves the other's chat running");
});

test("another copy of Obsidian on this Mac can't start a second process", () => {
  assert.equal(lockHeldByOther({ pid: 222 }, 111, () => true), true);
  assert.equal(lockHeldByOther({ pid: 222 }, 111, () => false), false, "a stale lock from a crash");
  assert.equal(lockHeldByOther({ pid: 111 }, 111, () => true), false, "our own");
  assert.equal(lockHeldByOther(null, 111, () => true), false);

  const file = join(mkdtempSync(join(tmpdir(), "hyo-lock-")), "main-chat.lock");
  // Another live process (this test runner's parent) holds it.
  writeFileSync(file, JSON.stringify({ pid: process.ppid }));
  const { procs, make } = fakes();
  const owner = new MainChatOwner(make, fileLock(file, process.pid));
  const me = listen();
  const id = owner.subscribe({ ...me.sub, onError: (e: string) => me.events.push({ error: e }) });
  owner.send(id, spec(), "hi");
  assert.equal(procs.length, 0, "refused");
  assert.ok(me.events.some((e) => e.type === "hyo_owner_refused"));
  assert.ok(me.events.some((e) => /already running in another copy of Obsidian/.test(e.error || "")));
  // Once it's ours, it's taken and given back.
  writeFileSync(file, JSON.stringify({ pid: 999999 }));
  owner.send(id, spec(), "hi");
  assert.equal(procs.length, 1);
  assert.ok(existsSync(file));
  procs[0].close(0);
  assert.equal(existsSync(file), false, "released when the process ends");
});

test("what the other side sees of a message: the words, never the hidden reminder", () => {
  assert.equal(displayText(withMainChatReminder("check my email") as string), "check my email");
  assert.equal(displayText(withMainChatReminder([{ type: "text", text: "what's this?" }, { type: "image" }])), "what's this?");
});
