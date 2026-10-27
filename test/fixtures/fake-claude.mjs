#!/usr/bin/env node
// A stand-in for the `claude` CLI in stream-json mode, for the end-to-end
// sync test. It speaks the same protocol Hyo drives (stream-json in and out,
// control_request / control_response for permissions) and writes a
// transcript the way Claude does: the person's line when the turn starts,
// the reply's line when it's complete. FAKE_PROJECT_DIR says where.
//
// Per message: "ask" in the text asks for permission first; "slow" streams
// slowly (so someone can join mid-turn). The reply is "Echo: <text>".
// "bgjob" starts a background job that asks for permission after the reply
// has finished, and ends once answered; "bgquit" does the same but the job
// ends on its own without an answer.
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.log("Usage: claude [options]\n  --effort <level>");
  process.exit(0);
}
const pick = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
const sessionId = pick("--resume") || pick("--session-id") || randomUUID();
const dir = process.env.FAKE_PROJECT_DIR;
const transcript = dir ? join(dir, `${sessionId}.jsonl`) : null;
if (dir) mkdirSync(dir, { recursive: true });
const write = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const record = (o) => transcript && appendFileSync(transcript, JSON.stringify(o) + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The CLI calls Ask first "default" in what it reports.
const reportMode = (m) => (m === "manual" ? "default" : m);
const launched = pick("--permission-mode") || "manual";
let mode = launched;
write({ type: "system", subtype: "init", session_id: sessionId, model: pick("--model"), cwd: process.cwd(), argv: args, permissionMode: reportMode(mode) });

const pendingAnswers = new Map();
let queue = Promise.resolve();
let n = 0;

async function turn(text) {
  record({ type: "user", message: { role: "user", content: [{ type: "text", text }] }, sessionId, uuid: randomUUID() });
  if (/\bask\b/.test(text)) {
    const request_id = `req-${++n}`;
    write({ type: "control_request", request_id, request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "echo hi" } } });
    const answer = await new Promise((r) => pendingAnswers.set(request_id, r));
    write({ type: "assistant", message: { id: `tool-${n}`, role: "assistant", content: [{ type: "text", text: `Permission: ${answer.behavior}. ` }] } });
  }
  const reply = `Echo: ${text}`;
  const parts = reply.match(/.{1,6}/g) || [reply];
  const delay = /\bslow\b/.test(text) ? 120 : 10;
  for (const p of parts) {
    write({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: p } } });
    await sleep(delay);
  }
  const id = `msg-${++n}`;
  const message = { id, role: "assistant", model: pick("--model") || "claude-opus-5-5", content: [{ type: "text", text: reply }] };
  write({ type: "assistant", message });
  record({ type: "assistant", message, sessionId, uuid: randomUUID() });
  write({ type: "result", subtype: "success", is_error: false, result: reply, session_id: sessionId });
}

// A background job inside this process: it asks after the turn that started
// it has finished, carrying the job's id as agent_id, as Claude Code does.
async function backgroundJob(task_id, quit) {
  await sleep(80);
  const request_id = `req-${++n}`;
  write({ type: "control_request", request_id, request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "gmail search" }, agent_id: task_id } });
  if (quit) await sleep(300);
  else await new Promise((r) => pendingAnswers.set(request_id, r));
  write({ type: "system", subtype: "task_notification", task_id, status: quit ? "failed" : "completed", summary: "done", session_id: sessionId });
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let m;
  try {
    m = JSON.parse(line);
  } catch {
    return;
  }
  if (m.type === "control_request" && m.request?.subtype === "set_permission_mode") {
    const want = m.request.mode;
    if (want === "bypassPermissions" && launched !== "bypassPermissions") {
      write({ type: "control_response", response: { subtype: "error", request_id: m.request_id, error: "Cannot set permission mode to bypassPermissions because the session was not launched with --dangerously-skip-permissions" } });
    } else {
      mode = want;
      write({ type: "control_response", response: { subtype: "success", request_id: m.request_id, response: { mode: reportMode(mode) } } });
      write({ type: "system", subtype: "status", status: null, permissionMode: reportMode(mode), session_id: sessionId });
    }
    return;
  }
  if (m.type === "control_response") {
    const r = m.response?.response;
    pendingAnswers.get(m.response?.request_id)?.(r);
    pendingAnswers.delete(m.response?.request_id);
    return;
  }
  if (m.type === "user") {
    const c = m.message?.content;
    const text = typeof c === "string" ? c : (c || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
    const bg = /\bbg(job|quit)\b/.exec(text);
    if (bg) {
      const task_id = `bg-${++n}`;
      queue = queue.then(() => {
        write({ type: "system", subtype: "task_started", task_id, description: "Check Gmail", subagent_type: "general-purpose", session_id: sessionId });
        return turn(text);
      }).then(() => void backgroundJob(task_id, bg[1] === "quit"));
      return;
    }
    // Claude answers one message at a time.
    queue = queue.then(() => turn(text));
  }
});
rl.on("close", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
