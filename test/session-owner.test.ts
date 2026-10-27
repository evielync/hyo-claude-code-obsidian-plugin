import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  SessionOwner,
  MainChatOwner,
  OwnerTransport,
  MainChatTransport,
  gatewaySession,
  gatewaySessionGone,
  gatewaySessionReset,
  phoneTabCount,
  setSessionOwnerFactory,
  sessionOwner,
  findSessionOwner,
  mainChatOwner,
  shutdownSessionOwners,
  lockHeldByOther,
  fileLock,
  displayText,
  MAIN_CHAT_WIRE_ID,
  unexpectedExitNotice,
  type OwnerSpec,
  type ProcLike,
} from "../src/session-owner";
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
      sendPermissionResponse(id: string, b: string, _t?: string, input?: any, dest?: string) {
        rec.sent.push({ permission: id, b, ...(input ? { input } : {}), ...(dest ? { dest } : {}) });
      },
      sendInterrupt() {
        rec.sent.push({ interrupt: true });
      },
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

const spec = (extra: Partial<OwnerSpec> = {}): OwnerSpec => ({ cliPath: "claude", cwd: "/work", model: "claude-opus-5-5", permissionMode: "acceptEdits", agent: "chad", sessionId: "s-1", appendSystemPrompt: "MAIN", ...extra });
const listen = () => {
  const events: any[] = [];
  return { events, sub: { onEvent: (e: any) => events.push(e) } };
};
const result = { type: "result", subtype: "success" };
const said = (events: any[]) => events.filter((e) => e.type === "hyo_user_message").map((e) => e.text);
const delta = (text: string) => ({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text } } });

test("two views of a conversation share one process and see each other's messages and the stream", () => {
  const { procs, make } = fakes();
  const owner = new SessionOwner(make, { sessionId: "s-1" });
  const laptop = listen();
  const phone = listen();
  const l = owner.subscribe(laptop.sub);
  const p = owner.subscribe(phone.sub);
  owner.send(l, spec(), "check my email", "q-laptop");
  procs[0].emit(delta("On "));
  procs[0].emit(delta("it."));
  procs[0].emit(result);
  owner.send(p, spec(), [{ type: "text", text: "and my calendar" }], "q-phone");
  assert.equal(procs.length, 1, "one process, whoever sends");
  assert.equal(procs[0].sent.length, 2);
  // Everyone hears every turn start, tagged with the sender's id for it.
  assert.deepEqual(said(phone.events), ["check my email", "and my calendar"]);
  assert.deepEqual(said(laptop.events), ["check my email", "and my calendar"]);
  assert.equal(laptop.events.find((e) => e.type === "hyo_user_message").qid, "q-laptop");
  // Both get the stream as it happens.
  assert.equal(phone.events.filter((e) => e.type === "stream_event").length, 2);
  assert.ok(laptop.events.includes(result) && phone.events.includes(result));
});

test("a message sent mid-turn is held, shown queued on every view, and goes when the turn ends", () => {
  const { procs, make } = fakes();
  const owner = new SessionOwner(make);
  const A = listen();
  const B = listen();
  const a = owner.subscribe(A.sub);
  const b = owner.subscribe(B.sub);
  owner.send(a, spec(), "one", "q1");
  owner.send(b, spec(), "two", "q2");
  assert.deepEqual(procs[0].sent, ["one"], "turns never interleave");
  for (const v of [A, B]) assert.deepEqual(v.events.find((e) => e.type === "hyo_queued"), { type: "hyo_queued", qid: "q2", text: "two", steerable: false });
  procs[0].emit(result);
  assert.deepEqual(procs[0].sent, ["one", "two"]);
  assert.deepEqual(said(A.events), ["one", "two"]);
  assert.equal(A.events.filter((e) => e.type === "hyo_user_message").at(-1).qid, "q2");
});

test("a permission answered on one view resolves it on the other, and is answered only once", () => {
  const { procs, make } = fakes();
  const owner = new SessionOwner(make);
  const laptop = listen();
  const phone = listen();
  const a = owner.subscribe(laptop.sub);
  const b = owner.subscribe(phone.sub);
  owner.send(a, spec(), "go");
  const ask = { type: "control_request", request_id: "req-1", request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "ls" } } };
  procs[0].emit(ask);
  assert.ok(laptop.events.includes(ask) && phone.events.includes(ask), "both show the card");
  assert.equal(owner.permission(b, "req-1", "allow", "Bash", undefined, "session"), true);
  assert.deepEqual(procs[0].sent[1], { permission: "req-1", b: "allow", dest: "session" });
  assert.deepEqual(laptop.events.at(-1), { type: "hyo_permission_answered", requestId: "req-1", behavior: "allow" });
  // The laptop answering too (or auto-approving) doesn't answer twice.
  assert.equal(owner.permission(a, "req-1", "deny"), false);
  assert.equal(procs[0].sent.length, 2);
  // A question answered with its answers goes through the same way.
  procs[0].emit({ type: "control_request", request_id: "q-9", request: { subtype: "can_use_tool", tool_name: "AskUserQuestion", input: { questions: [] } } });
  owner.permission(a, "q-9", "allow", undefined, { questions: [], answers: { x: "y" } });
  assert.deepEqual(phone.events.at(-1), { type: "hyo_permission_answered", requestId: "q-9", behavior: "allow" });
});

test("someone opening the conversation mid-turn gets the turn so far, what's queued and any open question", () => {
  const { procs, make } = fakes();
  let lines = 40;
  const owner = new SessionOwner(make, { sessionId: "s-1", transcriptLines: () => lines });
  const a = owner.subscribe(listen().sub);
  owner.send(a, spec(), "write the report", "q1");
  assert.equal(owner.turnStartLine, 40, "history for a newcomer stops where the turn began");
  lines = 44;
  procs[0].emit({ type: "system", subtype: "task_started", task_id: "t1", description: "Check Gmail" });
  procs[0].emit(delta("Draft"));
  procs[0].emit(delta("ing…"));
  // The complete message replaces its fragments in what's kept.
  procs[0].emit({ type: "assistant", message: { content: [{ type: "text", text: "Drafting…" }] } });
  procs[0].emit({ type: "control_request", request_id: "r1", request: { subtype: "can_use_tool", tool_name: "Write", input: {} } });
  owner.send(a, spec(), "and email it", "q2");
  const late = listen();
  owner.subscribe(late.sub);
  assert.equal(late.events[0].subtype, "background_tasks_changed");
  assert.equal(late.events[0].tasks[0].description, "Check Gmail");
  assert.equal(late.events[1].type, "hyo_session_info", "what the conversation runs with comes first");
  const r = late.events[2];
  assert.equal(r.type, "hyo_replay");
  assert.deepEqual({ qid: r.turn.qid, text: r.turn.text, selfStarted: r.turn.selfStarted }, { qid: "q1", text: "write the report", selfStarted: false });
  assert.deepEqual(
    r.turn.events.map((e: any) => e.type),
    ["system", "assistant", "control_request"],
    "no streamed fragments of a message that's complete"
  );
  assert.deepEqual(r.queued, [{ qid: "q2", text: "and email it", steerable: false }]);
  // Then it carries on live.
  procs[0].emit(result);
  assert.ok(late.events.includes(result));
  assert.equal(owner.turnStartLine, 44, "the queued message's turn is under way, from where the file is now");
});

test("an open question outside a turn (a background agent asking) reaches a newcomer", () => {
  const { procs, make } = fakes();
  const owner = new SessionOwner(make);
  const a = owner.subscribe(listen().sub);
  owner.send(a, spec(), "go");
  procs[0].emit(result);
  const ask = { type: "control_request", request_id: "bg-1", request: { subtype: "can_use_tool", tool_name: "Bash", input: {}, agent_id: "a1" } };
  procs[0].emit(ask);
  const late = listen();
  owner.subscribe(late.sub);
  assert.deepEqual(late.events.find((e) => e.type === "hyo_replay"), { type: "hyo_replay", turn: null, queued: [], asks: [ask] });
});

test("closing on one device never stops the turn the other is watching", () => {
  const { procs, make } = fakes();
  const owner = new SessionOwner(make, { graceMs: 0 });
  const phone = listen();
  const laptop = owner.subscribe(listen().sub);
  owner.subscribe(phone.sub);
  owner.send(laptop, spec(), "long job");
  owner.detach(laptop);
  assert.equal(procs[0].stopped, false);
  procs[0].emit(delta("still going"));
  assert.ok(phone.events.some((e) => e.type === "stream_event"), "the phone keeps hearing it");
});

test("an owner with nobody watching and nothing running is let go, its process with it", async () => {
  const { procs, make } = fakes();
  const released: any[] = [];
  const owner = new SessionOwner(make, { graceMs: 20, onRelease: (o) => released.push(o) });
  const a = owner.subscribe(listen().sub);
  owner.send(a, spec(), "hi");
  owner.detach(a);
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(released.length, 0, "not while the turn runs");
  procs[0].emit({ type: "system", subtype: "task_started", task_id: "t1", description: "x" });
  procs[0].emit(result);
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(released.length, 0, "not while a background job runs");
  procs[0].emit({ type: "system", subtype: "task_notification", task_id: "t1", status: "completed" });
  // Someone coming back within the grace keeps it.
  const b = owner.subscribe(listen().sub);
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(released.length, 0);
  owner.detach(b);
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(released.length, 1);
  assert.equal(procs[0].stopped, true, "no process left behind");
  assert.equal(owner.isReleased, true);
});

test("an idle process is stopped after a quiet spell; the next message resumes in a fresh one", async () => {
  const { procs, make } = fakes();
  const owner = new SessionOwner(make, { sessionId: "s-1", procIdleMs: 20 });
  const a = owner.subscribe(listen().sub);
  owner.send(a, spec(), "hi");
  procs[0].emit({ type: "system", subtype: "init", session_id: "s-1" });
  procs[0].emit(result);
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(procs[0].stopped, true);
  owner.send(a, spec({ sessionId: null }), "again");
  assert.equal(procs.length, 2);
  assert.equal(procs[1].spec.sessionId, "s-1");
});

test("the main chat is never let go, and a restart waits for work to finish", async () => {
  const { procs, make } = fakes();
  const owner = new MainChatOwner(make, undefined, { graceMs: 0, procIdleMs: 1 });
  const a = owner.subscribe(listen().sub);
  owner.send(a, spec(), "go");
  owner.detach(a);
  assert.equal(owner.restart(), false, "mid-turn: refused");
  procs[0].emit({ type: "system", subtype: "task_started", task_id: "t1", description: "Check Gmail" });
  procs[0].emit(result);
  assert.equal(owner.restart(), false, "a background job is running: refused");
  procs[0].emit({ type: "system", subtype: "task_notification", task_id: "t1", status: "completed" });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(owner.isReleased, false);
  assert.equal(procs[0].stopped, false, "the main chat's process isn't stopped for being idle");
  assert.equal(owner.restart(), true);
  assert.equal(procs[0].stopped, true);
});

test("a different system prompt (a call starting) swaps the process only when idle", () => {
  const { procs, make } = fakes();
  const owner = new MainChatOwner(make);
  const a = owner.subscribe(listen().sub);
  owner.send(a, spec({ sessionId: "main-1" }), "hi");
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

test("the phone carries on with the laptop's model and agent", () => {
  const { procs, make } = fakes();
  const owner = new SessionOwner(make, { sessionId: "s-1" });
  const a = owner.subscribe(listen().sub);
  owner.send(a, spec({ model: "claude-opus-5-5", agent: "chad" }), "from the laptop");
  procs[0].emit(result);
  owner.send(a, spec({ model: "claude-sonnet-5-5", agent: "", adopt: true }), "from the phone");
  assert.equal(procs.length, 1, "no swap to the phone's defaults");
});

test("a Claude process that dies on starting doesn't loop on the messages waiting", () => {
  const { procs, make } = fakes();
  const owner = new SessionOwner(make);
  const A = listen();
  const a = owner.subscribe(A.sub);
  owner.send(a, spec(), "one", "q1");
  owner.send(a, spec(), "two", "q2");
  procs[0].close(1);
  assert.equal(procs.length, 1);
  assert.deepEqual(A.events.at(-1), { type: "hyo_queue_dropped", qids: ["q2"], reason: "stopped" });
});

test("the nudge after a compaction carries on the same reply on every view", () => {
  const { procs, make } = fakes();
  const owner = new SessionOwner(make);
  const A = listen();
  const a = owner.subscribe(A.sub);
  owner.send(a, spec(), "go");
  owner.send(a, spec(), "Please continue", undefined, { silent: true });
  assert.equal(A.events.some((e) => e.type === "hyo_queued"), false, "never shown as a waiting message");
  procs[0].emit(result);
  assert.equal(A.events.filter((e) => e.type === "hyo_user_message").at(-1).silent, true);
});

test("one owner per conversation per working directory", () => {
  const { make } = fakes();
  setSessionOwnerFactory({ make, graceMs: 0 });
  try {
    const x = sessionOwner("/work", "s-1")!;
    assert.equal(sessionOwner("/work", "s-1"), x);
    assert.notEqual(sessionOwner("/elsewhere", "s-1"), x, "a different working directory is a different conversation store");
    assert.equal(findSessionOwner("/work", "s-2"), null, "finding never makes one");
    assert.notEqual(mainChatOwner("/work"), x);
    // Let go when idle: the next lookup makes a fresh one.
    const id = x.subscribe(listen().sub);
    x.detach(id);
    assert.equal(findSessionOwner("/work", "s-1"), null);
    assert.notEqual(sessionOwner("/work", "s-1"), x);
  } finally {
    shutdownSessionOwners();
    setSessionOwnerFactory(null);
  }
});

test("the phone's tabs attach to the Mac's owners through the gateway", async () => {
  const { procs, make } = fakes();
  setSessionOwnerFactory({ make });
  try {
    const owner = sessionOwner("/work", "s-1")!;
    const laptop = listen();
    const l = owner.subscribe(laptop.sub);
    owner.send(l, spec(), "from the laptop", "ql");
    const sent: any[] = [];
    const ws = {};
    const sink = { send: (o: any) => sent.push(o) };
    const allowed: string[] = [];
    const ctx = {
      cwd: "/work",
      mintId: () => "minted",
      allowOnPhone: (t: string) => allowed.push(t),
      specFor: (m: any, sid: string | null) => spec({ sessionId: sid, adopt: true, appendSystemPrompt: m.appendSystemPrompt ?? "MAIN" }),
    };
    // The phone opens it: caught up on the laptop's turn, then live.
    gatewaySession({ type: "attach", tabId: "phone-tab", sessionId: "s-1" }, ws, sink, ctx);
    assert.equal(sent[0].type, "stream");
    assert.equal(sent[0].tabId, "phone-tab");
    assert.equal(sent[0].event.type, "hyo_session_info");
    assert.equal(sent[1].event.type, "hyo_replay");
    procs[0].emit(delta("hello"));
    assert.equal(sent.at(-1).event.type, "stream_event");
    // The phone sends mid-turn: queued on the laptop too.
    gatewaySession({ type: "prompt", tabId: "phone-tab", sessionId: "s-1", text: "from the phone", qid: "qp" }, ws, sink, ctx);
    assert.deepEqual(laptop.events.at(-1), { type: "hyo_queued", qid: "qp", text: "from the phone", steerable: false });
    procs[0].emit(result);
    assert.equal(procs.length, 1, "the same process");
    assert.deepEqual(procs[0].sent[1], [{ type: "text", text: "from the phone" }]);
    // "Always allow" on the phone goes on the phone's own list, for this process only.
    procs[0].emit({ type: "control_request", request_id: "r1", request: { subtype: "can_use_tool", tool_name: "Bash", input: {} } });
    gatewaySession({ type: "permission_response", tabId: "phone-tab", requestId: "r1", behavior: "allow_always", toolName: "Bash" }, ws, sink, ctx);
    assert.deepEqual(allowed, ["Bash"]);
    assert.equal(procs[0].sent.at(-1).dest, "session");
    assert.equal(laptop.events.at(-1).type, "hyo_permission_answered");
    // The phone goes away: events wait for it, the turn carries on.
    gatewaySessionGone(ws, 50);
    procs[0].emit(delta("while away"));
    const before = sent.length;
    const ws2 = {};
    gatewaySession({ type: "reattach", tabIds: ["phone-tab", "unknown-tab"] }, ws2, sink, ctx);
    assert.ok(sent.slice(before).some((o) => o.type === "stream" && o.event?.event?.delta?.text === "while away"), "what streamed while away arrives");
    assert.deepEqual(sent.at(-1), { type: "gateway", subtype: "reattached", attached: ["phone-tab"], gone: ["unknown-tab"] });
    // A new conversation from the phone without an id gets one.
    gatewaySession({ type: "prompt", tabId: "phone-new", text: "new one" }, ws2, sink, ctx);
    assert.ok(findSessionOwner("/work", "minted"));
    // Stop only detaches.
    gatewaySession({ type: "stop", tabId: "phone-tab" }, ws2, sink, ctx);
    assert.equal(procs[0].stopped, false);
    assert.equal(owner.subscribers, 1);
    // The main chat by its shared id.
    gatewaySession({ type: "reattach", tabIds: [MAIN_CHAT_WIRE_ID] }, ws2, sink, ctx);
    assert.equal(mainChatOwner("/work")!.subscribers, 1);
    // A phone that never comes back is let go after the grace.
    gatewaySessionGone(ws2, 10);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(phoneTabCount(), 0);
  } finally {
    gatewaySessionReset();
    shutdownSessionOwners();
    setSessionOwnerFactory(null);
  }
});

test("two Hyo panels on one Mac drive the same process", () => {
  const { procs, make } = fakes();
  const owner = new MainChatOwner(make);
  const on = () => ({ onMessage: () => {}, onError: () => {}, onClose: () => {} });
  const panel1 = new MainChatTransport(owner, spec(), on());
  const panel2 = new OwnerTransport(owner, () => spec(), on());
  panel1.spawn();
  panel2.spawn();
  panel1.sendUserMessage("one");
  procs[0].emit(result);
  panel2.sendUserMessage("two");
  assert.equal(procs.length, 1);
  panel1.stop();
  assert.equal(procs[0].stopped, false, "closing one panel leaves the other's chat running");
});

test("another copy of Obsidian on this Mac can't start a second main chat process", () => {
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
  owner.send(id, spec(), "hi", "q1");
  assert.equal(procs.length, 0, "refused");
  assert.ok(me.events.some((e) => e.type === "hyo_owner_refused"));
  assert.ok(me.events.some((e) => /already running in another copy of Obsidian/.test(e.error || "")));
  assert.ok(me.events.some((e) => e.type === "hyo_queue_dropped" && e.qids[0] === "q1"));
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

test("every view shows the permission mode, model and agent the conversation really runs with", () => {
  const { procs, make } = fakes();
  const ids: string[] = [];
  const makeWithMode = (spec: OwnerSpec, on: any) => {
    const p: any = make(spec, on);
    p.setPermissionMode = (m: string) => {
      const id = "mode-" + (ids.length + 1);
      ids.push(id);
      p.lastMode = m;
      return id;
    };
    return p;
  };
  const owner = new SessionOwner(makeWithMode, { sessionId: "s-1" });
  const laptop = listen();
  const a = owner.subscribe(laptop.sub);
  owner.send(a, spec({ permissionMode: "acceptEdits", model: "claude-opus-5-5", agent: "chad" }), "go");
  assert.deepEqual(laptop.events.find((e) => e.type === "hyo_session_info"), { type: "hyo_session_info", permissionMode: "acceptEdits", model: "claude-opus-5-5", agent: "chad" });
  procs[0].emit(result);
  // The phone opens it: told the laptop's mode, model and agent straight away.
  const phone = listen();
  const p = owner.subscribe(phone.sub);
  assert.deepEqual(phone.events[0], { type: "hyo_session_info", permissionMode: "acceptEdits", model: "claude-opus-5-5", agent: "chad" });
  // The phone sending with its own defaults changes nothing: no restart, same mode.
  owner.send(p, spec({ permissionMode: "manual", model: "claude-sonnet-5-5", agent: "", adopt: true }), "from the phone");
  assert.equal(procs.length, 1);
  procs[0].emit(result);
  // Changed on the phone: Claude changes it in place, and both views show it.
  owner.setPermissionMode("manual");
  assert.equal((procs[0].proc as any).lastMode, "manual");
  assert.equal(laptop.events.filter((e) => e.type === "hyo_session_info").at(-1).permissionMode, "manual");
  procs[0].emit({ type: "control_response", response: { subtype: "success", request_id: ids[0], response: { mode: "default" } } });
  procs[0].emit({ type: "system", subtype: "status", permissionMode: "default" });
  assert.equal(owner.info!.permissionMode, "manual", "the CLI reports Ask first as default");
  assert.equal(procs.length, 1, "no restart for a mode Claude can change in place");
  // A mode it can only start in: a fresh process (once idle) launched in it, same conversation.
  owner.setPermissionMode("bypassPermissions");
  procs[0].emit({ type: "control_response", response: { subtype: "error", request_id: ids[1], error: "not launched with --dangerously-skip-permissions" } });
  assert.equal(procs[0].stopped, true);
  owner.send(a, spec({ permissionMode: "manual", sessionId: null }), "now");
  assert.equal(procs[1].spec.permissionMode, "bypassPermissions", "the new process runs in the chosen mode, whoever sends");
  assert.equal(procs[1].spec.sessionId, "s-1");
  assert.equal(phone.events.filter((e) => e.type === "hyo_session_info").at(-1).permissionMode, "bypassPermissions");
});

test("a model picked on any view: the conversation carries on on it in a fresh process, and every view shows it", () => {
  const { procs, make } = fakes();
  const owner = new SessionOwner(make, { sessionId: "s-1" });
  const laptop = listen();
  const a = owner.subscribe(laptop.sub);
  owner.send(a, spec({ model: "claude-opus-5-5" }), "go");
  // Picked mid-turn: shown at once, takes effect once the turn is done.
  owner.setModel("claude-haiku-5-5");
  assert.equal(laptop.events.filter((e) => e.type === "hyo_session_info").at(-1).model, "claude-haiku-5-5");
  assert.equal(procs[0].stopped, false, "never mid-turn");
  procs[0].emit(result);
  assert.equal(procs[0].stopped, true);
  // Whoever sends next (with their own model) gets the conversation's.
  owner.send(a, spec({ model: "claude-opus-5-5", sessionId: null }), "next");
  assert.equal(procs[1].spec.model, "claude-haiku-5-5");
  assert.equal(procs[1].spec.sessionId, "s-1");
});

test("effort picked on any view: the conversation carries on with it in a fresh process, and every view shows it", () => {
  const { procs, make } = fakes();
  const owner = new SessionOwner(make, { sessionId: "s-1" });
  const phone = listen();
  const a = owner.subscribe(listen().sub);
  owner.subscribe(phone.sub);
  owner.send(a, spec({ effort: "medium" }), "go");
  procs[0].emit(result);
  owner.setEffort("high");
  assert.equal(phone.events.filter((e) => e.type === "hyo_session_info").at(-1).effort, "high");
  assert.equal(procs[0].stopped, true, "idle: a fresh process now");
  owner.send(a, spec({ effort: "low", sessionId: null }), "next");
  assert.equal(procs[1].spec.effort, "high");
  assert.equal(procs[1].spec.sessionId, "s-1");
});

// Like a real Claude process: stopping it sends SIGTERM, and it then exits
// with code 143, as on the iPad on 27 Oct.
function sigtermFakes() {
  const f = fakes();
  const make = (spec: OwnerSpec, on: any) => {
    const proc = f.make(spec, on);
    const rec = f.procs.at(-1)!;
    const stop = proc.stop.bind(proc);
    proc.stop = () => {
      stop();
      rec.close(143);
    };
    return proc;
  };
  return { procs: f.procs, make };
}

test("a process Hyo stops or swaps on purpose never shows as a crash on any device; a real crash still does", async () => {
  const { procs, make } = sigtermFakes();
  setSessionOwnerFactory({ make, procIdleMs: 30, graceMs: 0 });
  try {
    const owner = sessionOwner("/work", "s-1")!;
    // The laptop: a panel's transport, and what its view would say.
    const laptopSays: string[] = [];
    let laptopGenerating = false;
    const panel = new OwnerTransport(owner, () => spec(), {
      onMessage: (e: any) => {
        if (e.type === "hyo_user_message") laptopGenerating = true;
        if (e.type === "result") laptopGenerating = false;
      },
      onError: () => {},
      onClose: (code) => {
        const n = unexpectedExitNotice(code, laptopGenerating);
        if (n) laptopSays.push(n);
        laptopGenerating = false;
      },
    });
    panel.spawn();
    // The phone, through the gateway.
    const phone: any[] = [];
    const ctx = { cwd: "/work", mintId: () => "x", specFor: (m: any, sid: string | null) => spec({ sessionId: sid, adopt: true, appendSystemPrompt: m.appendSystemPrompt ?? "MAIN" }) };
    gatewaySession({ type: "attach", tabId: "ipad", sessionId: "s-1" }, {}, { send: (o: any) => phone.push(o) }, ctx);
    const phoneClosed = () => phone.filter((o) => o.subtype === "tab_closed");
    const turn = (text: string) => {
      panel.sendUserMessage(text);
      procs.at(-1)!.emit(result);
    };

    turn("hi");
    // A call starting on the phone swaps Claude's instructions.
    gatewaySession({ type: "prompt", tabId: "ipad", sessionId: "s-1", text: "on a call", appendSystemPrompt: "MAIN+VOICE" }, {}, { send: (o: any) => phone.push(o) }, ctx);
    assert.equal(procs.length, 2, "swapped");
    assert.equal(procs[0].stopped, true);
    procs[1].emit(result);
    // A model change, an effort change, a mode Claude can only start in, a restart.
    owner.setModel("claude-sonnet-5-5");
    assert.equal(procs[1].stopped, true);
    turn("after the model change");
    owner.setEffort("high");
    turn("after the effort change");
    owner.setPermissionMode("bypassPermissions");
    turn("after the mode change");
    assert.equal(owner.restart(), true);
    turn("after a restart");
    // An idle spell.
    const before = procs.length;
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(procs.at(-1)!.stopped, true, "stopped for being idle");
    assert.equal(procs.length, before);
    for (let i = 0; i < procs.length; i++) assert.equal(procs[i].stopped, true, `process ${i} was stopped on purpose`);

    assert.deepEqual(laptopSays, [], "the laptop shows nothing");
    assert.deepEqual(phoneClosed(), [], "the phone is told nothing");

    // A real crash mid-turn still shows, on both.
    panel.sendUserMessage("one more");
    procs.at(-1)!.close(1);
    assert.equal(laptopSays.length, 1);
    assert.match(laptopSays[0], /exited unexpectedly \(code 1\)/);
    assert.deepEqual(phoneClosed().map((o) => o.code), [1]);
    assert.match(unexpectedExitNotice(phoneClosed()[0].code, true)!, /code 1/);
  } finally {
    gatewaySessionReset();
    shutdownSessionOwners();
    setSessionOwnerFactory(null);
  }
});

test("the exit notice: only a non-clean exit mid-turn", () => {
  assert.equal(unexpectedExitNotice(0, true), null);
  assert.equal(unexpectedExitNotice(null, true), null);
  assert.equal(unexpectedExitNotice(1, false), null);
  assert.match(unexpectedExitNotice(1, true)!, /^_Claude process exited unexpectedly \(code 1\)\./);
});
