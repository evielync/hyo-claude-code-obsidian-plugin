import { test } from "node:test";
import assert from "node:assert/strict";
import { dockItems, overallState, statusLine, stepWords, letterFor, toneFor } from "../src/dock-state";

const tab = (over: any = {}): any => ({
  id: "t1", cliSessionId: "s1", title: "Hyo Model Updates", messages: [], generating: false,
  model: "", effort: "", permissionMode: "", agent: "", inputTokens: 0, voiceMode: false, ...over,
});

test("the dock lists open conversations, never a blank one unless it's the one being written", () => {
  const items = dockItems([tab(), tab({ id: "t2", cliSessionId: null, title: "New conversation" })]);
  assert.deepEqual(items.map((i) => i.tabId), ["t1"]);
  const withNew = dockItems([tab(), tab({ id: "t2", cliSessionId: null, title: "New conversation" })], "t2");
  assert.deepEqual(withNew.map((i) => i.tabId), ["t1", "t2"]);
});

test("a waiting approval reads as needing you, and says what for", () => {
  const t = tab({
    generating: true,
    messages: [{ role: "assistant", content: "", permissionRequests: [{ requestId: "r", toolName: "Bash", input: { command: "npm run build", description: "Build the plugin" }, resolved: false }] }],
  });
  const [item] = dockItems([t]);
  assert.equal(item.state, "needs-attention");
  assert.equal(item.status, "Needs your OK: build the plugin");
});

test("a reply being written says the step it's on", () => {
  const t = tab({ generating: true, messages: [{ role: "assistant", content: "", toolCalls: [{ id: "a", name: "Read", input: { file_path: "/v/notes/plan.md" }, result: "ok" }, { id: "b", name: "WebSearch", input: {}, result: null }] }] });
  assert.equal(statusLine(t, "working"), "Searching the web");
});

test("background jobs count as working after the reply ends", () => {
  const t = tab({ jobs: { j: { id: "j", title: "Westpac in Gmail", activity: "Searching Gmail", agentType: "", startedAt: 1 } } });
  const [item] = dockItems([t]);
  assert.equal(item.state, "working");
  assert.equal(item.status, "Background job: Searching Gmail");
});

test("a reply that's landed shows as new while background agents still run", () => {
  const t = tab({ cliSessionId: "s1", jobs: { j: { id: "j", title: "Westpac in Gmail", activity: "Searching Gmail", agentType: "", startedAt: 1 } } });
  const [item] = dockItems([t], null, new Set(["s1"]));
  assert.equal(item.unread, true);
  assert.equal(item.status, "New reply · 1 agent still working");
  assert.equal(overallState([item]), "unread");
  const [writing] = dockItems([{ ...t, generating: true }], null, new Set(["s1"]));
  assert.equal(writing.unread, false, "a reply still being written isn't new yet");
});

test("the handle shows the most urgent state", () => {
  const items: any[] = [{ state: "idle" }, { state: "working" }, { state: "needs-attention" }];
  assert.equal(overallState(items), "needs-attention");
  assert.equal(overallState([{ state: "idle" } as any]), "idle");
});

test("letters, colours and plain words", () => {
  assert.equal(letterFor("“OpenBot” channels"), "O");
  assert.equal(toneFor("abc"), toneFor("abc"));
  assert.equal(stepWords("mcp__claude_ai_Gmail__search_threads", {}), "Using Gmail");
  assert.equal(stepWords("Edit", { file_path: "C:\\vault\\note.md" }), "Editing note.md");
});
