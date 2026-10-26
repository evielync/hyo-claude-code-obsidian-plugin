// What a chat shows when its conversation is shared live with other views,
// and what happens to the message box when the other device closes it.
import test from "node:test";
import assert from "node:assert/strict";
import { turnStarted, queued, permissionAnswered, replayBase, queueDropped, hasQueued } from "../src/live-sync";
import { reconcileTabs, type OpenEntry } from "../src/open-conversations";
import { buildTaskList } from "../src/mobile/task-state";

const user = (text: string, extra: any = {}) => ({ role: "user", content: text, displayText: text, ...extra });
const reply = (text: string, extra: any = {}) => ({ role: "assistant", content: text, toolCalls: [], orderedBlocks: [], ...extra });

test("someone else's message: shown with a reply slot; this view's own: left as it is", () => {
  const start = [user("hi"), reply("hello")];
  const other = turnStarted(start, { qid: "q9", text: "from the phone" });
  assert.equal(other.kind, "added");
  assert.deepEqual(other.messages.slice(-2).map((m: any) => [m.role, m.content, m.streaming || false]), [
    ["user", "from the phone", false],
    ["assistant", "", true],
  ]);
  const mine = [user("hi", { sendId: "q1" }), reply("", { streaming: true })];
  assert.equal(turnStarted(mine, { qid: "q1", text: "hi" }).kind, "already-shown");
  assert.equal(turnStarted(mine, { qid: "q1", text: "hi" }).messages, mine);
});

test("a queued message: shown waiting on every view, then goes in its place", () => {
  let msgs: any[] = [user("one", { sendId: "q1" }), reply("", { streaming: true })];
  msgs = queued(msgs, { qid: "q2", text: "two" });
  assert.equal(hasQueued(msgs), true);
  assert.equal(msgs.at(-1).queuedId, "q2");
  assert.equal(queued(msgs, { qid: "q2", text: "two" }), msgs, "told twice: no change");
  const started = turnStarted(msgs, { qid: "q2", text: "two" });
  assert.equal(started.kind, "started-queued");
  assert.equal(hasQueued(started.messages), false);
  assert.deepEqual(started.messages.slice(-2).map((m: any) => m.role), ["user", "assistant"]);
});

test("sent here just as a turn started elsewhere: it moves back to waiting", () => {
  // This view sent "mine" thinking nothing was running; the phone's turn got there first.
  let msgs: any[] = [user("mine", { sendId: "qm" }), reply("", { streaming: true })];
  msgs = turnStarted(msgs, { qid: "qp", text: "from the phone" }).messages;
  msgs = queued(msgs, { qid: "qm", text: "mine" });
  assert.deepEqual(msgs.map((m: any) => [m.role, m.content, m.queuedId || ""]), [
    ["user", "from the phone", ""],
    ["assistant", "", ""],
    ["user", "mine", "qm"],
  ]);
});

test("answered on the other device: the permission, the plan and the question close here", () => {
  const msgs: any[] = [
    reply("", {
      permissionRequests: [{ requestId: "p1", toolName: "Bash" }],
      planReview: { requestId: "plan", planContent: "x" },
      askQuestion: { id: "ask", questions: [] },
    }),
  ];
  let out = permissionAnswered(msgs, { requestId: "p1", behavior: "allow" });
  assert.equal(out[0].permissionRequests[0].resolved, "allowed");
  out = permissionAnswered(out, { requestId: "plan", behavior: "deny" });
  assert.equal(out[0].planReview.resolved, "rejected");
  out = permissionAnswered(out, { requestId: "ask", behavior: "allow" });
  assert.equal(out[0].askQuestion, null);
  assert.equal(permissionAnswered(out, { requestId: "nothing", behavior: "allow" }), out);
});

test("catching up on a turn under way rebuilds its reply once", () => {
  // Coming back after the connection dropped: the half-built reply is replaced.
  const shown: any[] = [user("old"), reply("done"), user("write it", { sendId: "q1" }), reply("Draf", { streaming: true })];
  const base = replayBase(shown, { qid: "q1", text: "write it" });
  assert.deepEqual(base.map((m: any) => [m.role, m.content]), [
    ["user", "old"],
    ["assistant", "done"],
    ["user", "write it"],
    ["assistant", ""],
  ]);
  // Opening it fresh: history stopped where the turn began, so the turn's message is added.
  const fresh = replayBase([user("old"), reply("done")], { qid: "q1", text: "write it" });
  assert.deepEqual(fresh.slice(-2).map((m: any) => [m.role, m.content, m.sendId]), [
    ["user", "write it", "q1"],
    ["assistant", "", undefined],
  ]);
  // A turn Claude started itself: a reply of its own, no message.
  const self = replayBase([user("old"), reply("done")], { selfStarted: true });
  assert.equal(self.length, 3);
  assert.equal(self[2].selfStarted, true);
});

test("messages that will never go stop waiting and say so", () => {
  const msgs: any[] = [user("one"), reply("..."), user("two", { queuedId: "q2" })];
  const out = queueDropped(msgs, ["q2"], "stopped");
  assert.equal(hasQueued(out), false);
  assert.match(out.at(-1).content, /Send it again/);
});

test("closed on the other device while text is in the box: it stays until the box is empty", () => {
  interface Tab {
    id: string;
    cliSessionId: string | null;
    title: string;
    isMain?: boolean;
  }
  const tabs: Tab[] = [
    { id: "main", cliSessionId: "MAIN", title: "Main chat", isMain: true },
    { id: "t1", cliSessionId: "a", title: "A" },
  ];
  const drafts = new Set<string>(["t1"]);
  const list: OpenEntry[] = []; // "a" was closed on the Mac
  const mk = (e: OpenEntry): Tab => ({ id: "n-" + e.id, cliSessionId: e.id, title: e.title });
  const blank = (): Tab => ({ id: "b", cliSessionId: null, title: "New conversation" });
  const busy = (t: Tab) => drafts.has(t.id);
  let r = reconcileTabs(tabs, "t1", list, mk, blank, { mainSessionId: "MAIN", busy });
  assert.deepEqual(r.tabs.map((t) => t.id), ["main", "t1"], "kept while the draft is there");
  assert.equal(r.activeTabId, "t1", "and still the one in view");
  drafts.delete("t1");
  r = reconcileTabs(tabs, "t1", list, mk, blank, { mainSessionId: "MAIN", busy });
  assert.deepEqual(r.tabs.map((t) => t.id), ["main"], "the close goes ahead once the box is empty");
  assert.equal(r.activeTabId, "main");
});

test("phone rows show the last line and the real last-active time, not 'just now'", () => {
  const now = Date.parse("2026-10-27T10:00:00Z");
  const tab: any = { id: "t1", cliSessionId: "a", title: "A", messages: [], generating: false };
  const hints = { a: { peek: "The report is in your inbox.", lastActive: Date.parse("2026-10-26T18:30:00Z") } };
  const [row] = buildTaskList([tab], [], {}, now, hints);
  assert.equal(row.peek, "The report is in your inbox.");
  assert.equal(row.lastActive, hints.a.lastActive);
  // Once the conversation is loaded, its own last line wins.
  const loaded = { ...tab, messages: [{ role: "assistant", content: "Newer line" }] };
  assert.equal(buildTaskList([loaded], [], {}, now, hints)[0].peek, "Newer line");
  // A turn here is newer still.
  const active = { ...loaded, lastActivity: now - 1000 };
  assert.equal(buildTaskList([active], [], {}, now, hints)[0].lastActive, now - 1000);
});
