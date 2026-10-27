import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  MAIN_CHAT_PROMPT,
  MAIN_CHAT_REMINDER,
  appendedPrompt,
  withMainChatReminder,
  withMainChat,
  mainFirst,
  canCloseTab,
  canReorder,
  startupActive,
  mainChatOn,
  MAIN_CHAT_AVAILABLE,
} from "../src/main-chat";
import {
  applyJobEvent,
  jobList,
  jobLine,
  jobAsking,
  jobInitial,
  permissionAskerLine,
  hasRunningJobs,
  IdleGate,
  maySwapProcess,
  type JobMap,
} from "../src/background-jobs";
import { resumeModel, transcriptModel } from "../src/models";
import { extractSessionModel, parseSessionLines } from "../src/mobile/session-parser";
import { parseSessionEntries } from "../src/session-parser";
import { newStreamState, endTurn, startsTurnOfItsOwn, isSidechainEvent } from "../src/reply-stream";

// A real Claude Code 2.1.280 stream (stream-json, Hyo's spawn flags) with two
// background agents running at once, recorded in the chad sandbox: one
// counting files with Bash, one fetching a web page, which asked permission.
const stream: any[] = readFileSync(join(process.cwd(), "test/fixtures/two-background-agents.jsonl"), "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l))
  .filter((e) => !e._sent);

type Tab = { id: string; isMain?: boolean; cliSessionId: string | null; messages: unknown[] };
const tab = (id: string, extra: Partial<Tab> = {}): Tab => ({ id, cliSessionId: null, messages: [], ...extra });

// ---- Setting, pinning, opening ---------------------------------------------

test("main chat on: a pinned tab goes first; off: it stays as an ordinary tab", () => {
  const tabs = [tab("a", { cliSessionId: "s1" }), tab("b", { cliSessionId: "s2" })];
  const on = withMainChat(tabs, true, () => tab("m", { isMain: true }));
  assert.deepEqual(on.map((t) => t.id), ["m", "a", "b"]);
  // Already there: nothing added.
  assert.equal(withMainChat(on, true, () => tab("x", { isMain: true })).length, 3);
  const off = withMainChat(on, false, () => tab("x"));
  assert.deepEqual(off.map((t) => t.id), ["m", "a", "b"], "turning it off closes nothing");
  assert.equal(off.some((t) => t.isMain), false);
  // Off and never on: untouched.
  assert.equal(withMainChat(tabs, false, () => tab("x")), tabs);
});

test("the main chat always sorts first and can't be closed", () => {
  const tabs = [tab("a"), tab("m", { isMain: true }), tab("b")];
  assert.deepEqual(mainFirst(tabs).map((t) => t.id), ["m", "a", "b"]);
  assert.equal(canCloseTab(tabs[1]), false);
  assert.equal(canCloseTab(tabs[0]), true);
  assert.equal(canCloseTab(undefined), false);
});

test("nothing moves the main chat or lands in front of it", () => {
  const tabs = [tab("m", { isMain: true }), tab("a"), tab("b")];
  assert.equal(canReorder(tabs, "m", "b", true), false, "the main chat can't be dragged");
  assert.equal(canReorder(tabs, "b", "m", false), false, "nothing drops before it");
  assert.equal(canReorder(tabs, "b", "m", true), true, "dropping just after it is fine");
  assert.equal(canReorder(tabs, "b", "a", false), true);
});

test("Hyo opens to the main chat when nothing else is open", () => {
  const main = tab("m", { isMain: true, cliSessionId: "main-session" });
  assert.equal(startupActive([main], null), "m");
  // A pristine starter tab doesn't count as something open.
  assert.equal(startupActive([main, tab("blank")], null), "m");
  // Restored tabs: the one that was active last time.
  const restored = [main, tab("a", { cliSessionId: "s1" }), tab("b", { cliSessionId: "s2" })];
  assert.equal(startupActive(restored, "s1"), "a");
  assert.equal(startupActive(restored, "main-session"), "m");
  assert.equal(startupActive(restored, "gone"), "b");
});

// ---- Delegation only in the main chat --------------------------------------

test("only the main chat gets the delegation instructions; voice still adds its persona", () => {
  assert.equal(appendedPrompt(false, undefined), undefined, "an ordinary tab is spawned as before");
  assert.equal(appendedPrompt(false, "VOICE"), "VOICE");
  assert.equal(appendedPrompt(true, undefined), MAIN_CHAT_PROMPT);
  assert.equal(appendedPrompt(true, "VOICE"), `${MAIN_CHAT_PROMPT}\n\nVOICE`);
});

test("the instructions carry the ported Multitask Mode wording, for Claude Code's Agent tool", () => {
  for (const line of [
    "pushes meaningful work to asynchronous agents through your `Agent` tool, with `run_in_background` set to `true`",
    "NEVER await or sleep while waiting for a running subagent to complete.",
    "you MUST end your response IMMEDIATELY",
    "YOU MUST DELEGATE TO AN ASYNCHRONOUS SUBAGENT ANY TIME YOU NEED TO USE ANY TOOLS.",
    "When the task to be completed requires ANY tool calls.",
    "write nothing before the Agent call. Once the Agent tool returns, reply with one short line",
    "Before each foreground tool call, distinguish coordination work from the worker task you already delegated.",
    "SendMessage",
  ]) {
    assert.ok(MAIN_CHAT_PROMPT.includes(line), line);
  }
  assert.ok(MAIN_CHAT_REMINDER.includes("Decide whether to delegate the user request to a background subagent (default action)"));
  assert.ok(MAIN_CHAT_REMINDER.includes("Reserve for requests requiring zero tool calls."));
  // Nothing left that lets one quick tool call run in the chat itself.
  assert.ok(!/one quick tool call|zero or one/i.test(MAIN_CHAT_PROMPT + MAIN_CHAT_REMINDER));
});

test("every main chat message carries the reminder; slash commands go as they are", () => {
  assert.equal(withMainChatReminder("check my email"), `check my email\n\n${MAIN_CHAT_REMINDER}`);
  assert.equal(withMainChatReminder("/compact"), "/compact");
  const blocks = withMainChatReminder([{ type: "text", text: "what's in this?" }, { type: "image" }]) as any[];
  assert.equal(blocks.length, 3);
  assert.equal(blocks[2].text, MAIN_CHAT_REMINDER);
});

test("the reminder never shows when the conversation is reopened, desktop or phone", () => {
  const entries = [
    { type: "user", message: { role: "user", content: [{ type: "text", text: withMainChatReminder("check my personal email for my next chiro appointment") }] } },
    { type: "assistant", message: { id: "m1", content: [{ type: "text", text: "Checking your personal Gmail for the chiro." }] } },
  ];
  for (const msgs of [parseSessionEntries(entries), parseSessionLines(entries)]) {
    assert.equal(msgs[0].content, "check my personal email for my next chiro appointment");
  }
});

// ---- The status line, from the real stream ---------------------------------

test("status lines follow the real stream: two jobs appear, report, and clear", () => {
  let jobs: JobMap = {};
  const seen: string[][] = [];
  let askedBy: string | null = null;
  for (const ev of stream) {
    if (ev.type === "control_request") askedBy = jobAsking(jobs, ev.request)?.title ?? null;
    const next = applyJobEvent(jobs, ev, 1);
    if (next) {
      jobs = next;
      seen.push(jobList(jobs).map(jobLine));
    }
  }
  const counts = seen.map((s) => s.length);
  assert.equal(Math.max(...counts), 2, "both jobs show at once");
  assert.equal(counts[counts.length - 1], 0, "and both are gone at the end");
  const lines = seen.flat();
  assert.ok(lines.includes("Count Projects markdown files"), "a job shows its name until it reports");
  assert.ok(lines.includes("Count markdown files and list three newest"), "then what it's doing, without 'Running'");
  assert.ok(lines.includes("Fetching https://example.com"));
  assert.equal(askedBy, "Fetch example.com and read README", "the permission ask is the web job's");
  assert.equal(hasRunningJobs(jobs), false);
});

test("a job is gone as soon as it finishes, before Claude reports it", () => {
  let jobs: JobMap = {};
  for (const ev of stream) {
    jobs = applyJobEvent(jobs, ev, 1) ?? jobs;
    if (ev.type === "assistant" && !isSidechainEvent(ev) && /Agent 1 is done/.test(JSON.stringify(ev.message.content))) {
      assert.deepEqual(jobList(jobs).map((j) => j.title), ["Fetch example.com and read README"]);
      return;
    }
  }
  assert.fail("the first result never came back");
});

test("each result comes back as its own reply: the stream has three turns", () => {
  const ss = newStreamState();
  let replies = 1; // the reply to her message
  for (const ev of stream) {
    if (ev.type === "result" && !isSidechainEvent(ev)) endTurn(ss, ev);
    else if (startsTurnOfItsOwn(ss, ev)) replies++;
  }
  assert.equal(replies, 3, "her ask, then one reply per finished job");
});

test("a job that was already running when Hyo reconnected still gets a line", () => {
  const jobs = applyJobEvent({}, { type: "system", subtype: "task_progress", task_id: "t1", description: "Searching Gmail for Westpac" }, 1)!;
  assert.equal(jobLine(jobList(jobs)[0]), "Searching Gmail for Westpac");
});

test("the avatar letter comes from the agent type", () => {
  const jobs = applyJobEvent({}, { type: "system", subtype: "task_started", task_id: "t", description: "x", subagent_type: "general-purpose" }, 1)!;
  assert.equal(jobInitial(jobs.t), "G");
});

// ---- Permission labels ------------------------------------------------------

test("a background job's permission card names the job; the chat's own doesn't", () => {
  const jobs = applyJobEvent({}, { type: "system", subtype: "task_started", task_id: "a7687426f01528829", description: "Check personal Gmail for Westpac" }, 1)!;
  const fromJob = { subtype: "can_use_tool", tool_name: "WebFetch", agent_id: "a7687426f01528829" };
  const fromChat = { subtype: "can_use_tool", tool_name: "Bash" };
  assert.equal(permissionAskerLine(jobAsking(jobs, fromJob)!.title), "Background job: Check personal Gmail for Westpac");
  assert.equal(jobAsking(jobs, fromChat), null);
});

// ---- Never stopping the process while jobs run -----------------------------

test("a process swap (call starting) waits while background jobs run", () => {
  const running: JobMap = { t: { id: "t", title: "x", activity: "", agentType: "", startedAt: 1 } };
  assert.equal(maySwapProcess({ running: true, midTurn: false, jobs: running, promptChanged: true }), false);
  assert.equal(maySwapProcess({ running: true, midTurn: true, jobs: {}, promptChanged: true }), false);
  assert.equal(maySwapProcess({ running: true, midTurn: false, jobs: {}, promptChanged: false }), false);
  assert.equal(maySwapProcess({ running: true, midTurn: false, jobs: {}, promptChanged: true }), true);
});

test("a restart (after an update or sign-in) waits for the real jobs to finish", () => {
  const g = new IdleGate();
  let restarted = 0;
  let jobs: JobMap = {};
  let asked = false;
  for (const ev of stream) {
    jobs = applyJobEvent(jobs, ev, 1) ?? jobs;
    g.update(jobs);
    if (!asked && hasRunningJobs(jobs)) {
      asked = true;
      assert.equal(g.whenIdle(() => restarted++), false, "held while jobs run");
    }
    if (hasRunningJobs(jobs)) assert.equal(restarted, 0, "never while a job is running");
  }
  assert.equal(restarted, 1, "runs once the last job is done");
  assert.equal(g.whenIdle(() => restarted++), true, "and straight away when nothing is running");
});

// ---- Long conversations ----------------------------------------------------

test("a reopened conversation keeps its model and the window it grew in", () => {
  // 266K of context on an older long-context model: the transcript records
  // the plain ID, which means 200K; the suffix goes back on.
  assert.equal(resumeModel("claude-opus-4-6", 266_733), "claude-opus-4-6[1m]");
  assert.equal(resumeModel("claude-opus-4-6", 120_000), "claude-opus-4-6");
  // Native 1M models never take the suffix.
  assert.equal(resumeModel("claude-opus-5-5", 507_067), "claude-opus-5-5");
  assert.equal(resumeModel(null, 1), null);
});

test("the phone reads the conversation's own model, never a sub-agent's", () => {
  const lines = [
    { type: "assistant", isSidechain: false, message: { model: "claude-opus-4-6", usage: { input_tokens: 2, cache_read_input_tokens: 250_000 } } },
    // An older CLI wrote sub-agents into the same file, on a smaller model.
    { type: "assistant", isSidechain: true, message: { model: "claude-haiku-4-5", usage: { input_tokens: 9000 } } },
    { type: "assistant", isSidechain: false, message: { model: "<synthetic>" } },
  ];
  assert.deepEqual(transcriptModel(lines), { model: "claude-opus-4-6", contextTokens: 250_002 });
  assert.equal(extractSessionModel(lines), "claude-opus-4-6[1m]");
});

// ---- Held back from this release --------------------------------------------

test("Main chat is off for everyone in this build, and its switch is hidden", () => {
  assert.equal(MAIN_CHAT_AVAILABLE, false);
  const synced = { mainChat: true, mainChatSessionId: "main-from-testing" };
  assert.equal(mainChatOn(synced), false, "off even when synced settings say on");
  assert.deepEqual(synced, { mainChat: true, mainChatSessionId: "main-from-testing" }, "saved settings untouched, so it can come back");
  assert.equal(mainChatOn({}), false);
  // Both apps read it through mainChatOn; the Settings switch only draws when it's available.
  for (const f of ["src/components/HyoApp.tsx", "src/mobile/components/HyoApp.tsx"]) {
    const src = readFileSync(join(process.cwd(), f), "utf8");
    assert.match(src, /mainChat: mainChatOn\(plugin\.settings\)/, f);
    assert.doesNotMatch(src, /mainChat: !!plugin\.settings\.mainChat/, f);
  }
  assert.match(readFileSync(join(process.cwd(), "src/settings.ts"), "utf8"), /if \(MAIN_CHAT_AVAILABLE\) new Setting\(containerEl\)\s*\.setName\("Main chat"\)/);
});
