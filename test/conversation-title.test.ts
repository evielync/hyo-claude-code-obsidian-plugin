// Conversation titles: where the title call runs, which message a conversation
// is named after, and that a title someone typed is never replaced.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, chmodSync, existsSync } from "node:fs";
import { join, delimiter } from "node:path";
import { tmpdir } from "node:os";

const home = mkdtempSync(join(tmpdir(), "hyo-title-home-"));
process.env.HOME = home;
process.env.USERPROFILE = home;

import { titleSpawnOptions, generateConversationTitle } from "../src/title-generator";
import { autoTitleRequest, isAutoTitle, firstSendTitle, pickTitleText } from "../src/conversation-title";
import { listPastSessions, getProjectDir } from "../src/session-parser";

const fake = join(process.cwd(), "test", "fixtures", "fake-claude.mjs");
chmodSync(fake, 0o755);

test("the title call runs in the system temp folder, with PATH joined by the platform's separator", () => {
  const mac = titleSpawnOptions("darwin", { PATH: "/existing/bin" }, "/Users/someone");
  assert.equal(mac.cwd, tmpdir());
  const parts = mac.env.PATH!.split(delimiter);
  assert.ok(parts.includes("/opt/homebrew/bin"));
  assert.ok(parts.includes(join("/Users/someone", ".local", "bin")));
  assert.equal(parts.at(-1), "/existing/bin", "the inherited PATH is kept, last");

  // Windows: no Unix folders and no "/tmp"; the inherited PATH is untouched.
  const win = titleSpawnOptions("win32", { PATH: "C:\\Windows;C:\\Users\\f\\.local\\bin" }, "C:\\Users\\f");
  assert.equal(win.cwd, tmpdir());
  assert.notEqual(win.cwd, "/tmp");
  assert.equal(win.env.PATH, "C:\\Windows;C:\\Users\\f\\.local\\bin");
});

test("the title call really spawns there and comes back with a title", async () => {
  const log = join(home, "title-log.jsonl");
  process.env.FAKE_TITLE_LOG = log;
  try {
    const title = await generateConversationTitle({ cliPath: fake, userMessage: "Plan my week", assistantMessage: "Sure." });
    assert.equal(title, "About: Plan my week");
    const rec = JSON.parse(readFileSync(log, "utf8").trim().split("\n").at(-1)!);
    assert.equal(realpathSync(rec.cwd), realpathSync(tmpdir()));
  } finally {
    delete process.env.FAKE_TITLE_LOG;
  }
});

const u = (content: string) => ({ role: "user", content });
const a = (content: string) => ({ role: "assistant", content });

test('"Hi Norm" then a real question: titled from the question', () => {
  const msgs = [u("Hi Norm"), a("Morning! What's on?"), u("Can you plan my week around the launch?"), a("Here's a plan.")];
  assert.deepEqual(autoTitleRequest("Hi Norm", msgs), {
    userText: "Can you plan my week around the launch?",
    assistantText: "Here's a plan.",
  });
});

test("only a greeting so far: no title yet, wait for the next turn", () => {
  assert.equal(autoTitleRequest("Hi Norm", [u("Hi Norm"), a("Morning!")]), null);
});

test("a long first message keeps working as before", () => {
  const long = "Can you go through my inbox and pull out anything urgent from clients";
  assert.ok(autoTitleRequest(firstSendTitle(long), [u(long), a("On it.")]));
  assert.ok(autoTitleRequest("New conversation", [u(long), a("On it.")]));
});

test("a title typed by hand is left alone", () => {
  const msgs = [u("Hi Norm"), a("Morning!"), u("Plan my week"), a("Done.")];
  assert.equal(autoTitleRequest("Weekly planning", msgs), null);
  assert.equal(isAutoTitle("Weekly planning", msgs), false);
  // A later message's words don't count as Hyo's placeholder either.
  const later = [...msgs, u("And next week too"), a("Sure.")];
  assert.equal(isAutoTitle("And next week too", later), false);
});

test("pickTitleText skips greetings, falls back to one when that's all there is", () => {
  assert.equal(pickTitleText(["Hi Norm", "Plan my week"]), "Plan my week");
  assert.equal(pickTitleText(["hey", "good morning"]), "hey");
  assert.equal(pickTitleText([]), null);
});

function transcript(cwd: string, id: string, userTexts: string[]) {
  const dir = getProjectDir(cwd);
  mkdirSync(dir, { recursive: true });
  const lines: any[] = [];
  userTexts.forEach((t, i) => {
    lines.push({ type: "user", message: { role: "user", content: t }, uuid: `u${i}` });
    lines.push({ type: "assistant", message: { id: `m${i}`, role: "assistant", content: [{ type: "text", text: `Reply ${i}. ${"padding ".repeat(80)}` }] }, uuid: `a${i}` });
  });
  writeFileSync(join(dir, `${id}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

test("History's fallback title skips a greeting opener", () => {
  const cwd = mkdtempSync(join(tmpdir(), "hyo-title-cwd-"));
  transcript(cwd, "greeted", ["Hi Norm", "Can you plan my week around the launch?"]);
  transcript(cwd, "only-hello", ["hello", "hey there"]);
  assert.ok(existsSync(join(getProjectDir(cwd), "greeted.jsonl")));
  const byId = Object.fromEntries(listPastSessions(cwd).map((s) => [s.id, s.title]));
  assert.equal(byId["greeted"], "Can you plan my week around the launch?");
  assert.equal(byId["only-hello"], "hello");
});
