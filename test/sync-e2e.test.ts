// Live sync end to end, over a real WebSocket.
//
// The Mac: the gateway's real socket handling (attachGatewaySocket, what
// gateway-host.ts runs for every phone connection) on a real `ws` server,
// the real session owners, and real ClaudeTransport spawning a process. The
// process is a stand-in for the claude CLI (test/fixtures/fake-claude.mjs)
// that speaks the same stream-json protocol and writes a transcript.
// A desktop panel: an OwnerTransport subscribed to the same owner.
// The phone: the real GatewayClient and GatewayTransport, and the phone's
// real history loader.
// Not run here: React, Obsidian, and the real Claude (see
// scripts/real-claude-sync.mjs for a run against the real CLI).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const home = mkdtempSync(join(tmpdir(), "hyo-e2e-home-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.HYO_MOBILE_SETTINGS = join(home, ".hyo", "mobile-settings.json");

import { WebSocketServer } from "ws";
import { attachGatewaySocket, historyPage } from "../src/gateway-host";
import { ClaudeTransport } from "../src/claude-transport";
import { setSessionOwnerFactory, sessionOwner, findSessionOwner, shutdownSessionOwners, gatewaySessionReset, OwnerTransport, type OwnerSpec } from "../src/session-owner";
import { getProjectDir, hasTranscript, transcriptLineCount } from "../src/session-parser";
import { GatewayClient } from "../src/mobile/gateway-client";
import { GatewayTransport } from "../src/mobile/gateway-transport";
import { loadSessionHistory } from "../src/mobile/session-parser";

const fake = join(process.cwd(), "test", "fixtures", "fake-claude.mjs");
chmodSync(fake, 0o755);

async function waitFor(what: string, pred: () => boolean, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 15));
  }
  assert.fail(`timed out waiting for: ${what}`);
}

const textOf = (events: any[]) =>
  events
    .filter((e) => e.type === "stream_event")
    .map((e) => e.event?.delta?.text || "")
    .join("");

test("laptop and phone share one conversation live, over a real socket", async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "hyo-e2e-cwd-"));
  const vault = mkdtempSync(join(tmpdir(), "hyo-e2e-vault-"));
  process.env.FAKE_PROJECT_DIR = getProjectDir(cwd);
  const spawned: OwnerSpec[] = [];
  setSessionOwnerFactory({
    make: (spec, on) => {
      spawned.push(spec);
      return new ClaudeTransport({
        ...spec,
        sessionId: spec.sessionId || undefined,
        resume: !!spec.sessionId && hasTranscript(spec.cwd, spec.sessionId),
        ...on,
      });
    },
    transcriptLines: (c, sid) => transcriptLineCount(c, sid),
    graceMs: 300,
  });
  const config: any = {
    port: 0,
    vault,
    cwd,
    getCwd: () => cwd,
    cliPath: fake,
    defaultAgent: "",
    defaultModel: "claude-opus-5-5",
    getLiveVoice: () => ({ engine: "elevenlabs", openAiApiKey: "", voice: "marin", personality: "" }),
    onConnectUrl: () => {},
    onStatus: () => {},
    updateClaude: async () => ({ ok: false }),
  };
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((r) => server.once("listening", () => r()));
  const sockets = new Set<any>();
  server.on("connection", (ws) => {
    sockets.add(ws);
    ws.on("close", () => sockets.delete(ws));
    attachGatewaySocket(ws as any, { config: () => config, env: () => process.env });
  });
  const url = `ws://127.0.0.1:${(server.address() as any).port}`;
  const client = GatewayClient.get(url);
  t.after(() => {
    client.destroy();
    gatewaySessionReset();
    shutdownSessionOwners();
    setSessionOwnerFactory(null);
    server.close();
  });
  await waitFor("the phone connects", () => client.getStatus() === "connected");

  // The laptop starts a new conversation (its id minted at the first message).
  const sid = "e2e-0000-4000-8000-000000000001";
  const owner = sessionOwner(cwd, sid)!;
  const laptop: any[] = [];
  const desk = new OwnerTransport(owner, () => ({ cliPath: fake, cwd, model: "claude-opus-5-5", permissionMode: "default", agent: "", sessionId: sid }), {
    onMessage: (e) => laptop.push(e),
    onError: () => {},
    onClose: () => {},
  });
  desk.spawn();

  // The phone opens it: history (empty so far), then it hears it live.
  const phone: any[] = [];
  const phoneClosed: any[] = [];
  const pt = new GatewayTransport({ gatewayUrl: url, tabId: "phone-1", sessionId: sid, onMessage: (e) => phone.push(e), onError: () => {}, onClose: (c) => phoneClosed.push(c) });
  pt.spawn();
  const empty = await loadSessionHistory(url, sid, { tabId: pt.wireId });
  assert.deepEqual(empty.messages, []);
  await waitFor("the phone is subscribed", () => owner.subscribers === 2);

  // 1. A message from the laptop: the phone sees it and the reply streaming.
  desk.sendUserMessage("hello from the laptop", { qid: "q-l1" });
  await waitFor("the phone gets the laptop's reply", () => phone.some((e) => e.type === "result"));
  assert.deepEqual(phone.find((e) => e.type === "hyo_user_message"), { type: "hyo_user_message", qid: "q-l1", text: "hello from the laptop" });
  assert.equal(textOf(phone), "Echo: hello from the laptop");
  assert.equal(spawned.length, 1);

  // 2. A message from the phone: the laptop sees it and the reply.
  laptop.length = 0;
  phone.length = 0;
  pt.sendUserMessage("hello from the phone", true, { qid: "q-p1" });
  await waitFor("the laptop gets the phone's reply", () => laptop.some((e) => e.type === "result"));
  assert.equal(laptop.find((e) => e.type === "hyo_user_message").text, "hello from the phone");
  assert.equal(textOf(laptop), "Echo: hello from the phone");
  assert.equal(spawned.length, 1, "still one process: the phone joined the laptop's");

  // 3. Turns are held: the phone sends while the laptop's turn runs.
  laptop.length = 0;
  phone.length = 0;
  desk.sendUserMessage("slow one from the laptop", { qid: "q-l2" });
  await waitFor("the laptop's turn is under way", () => phone.some((e) => e.type === "stream_event"));
  pt.sendUserMessage("second, from the phone", true, { qid: "q-p2" });
  await waitFor("both see it queued", () => laptop.some((e) => e.type === "hyo_queued") && phone.some((e) => e.type === "hyo_queued"));
  await waitFor("both turns finish", () => laptop.filter((e) => e.type === "result").length === 2);
  const order = laptop.filter((e) => e.type === "hyo_user_message").map((e) => e.qid);
  assert.deepEqual(order, ["q-l2", "q-p2"], "the second waits for the first");
  const firstResult = laptop.findIndex((e) => e.type === "result");
  const secondStart = laptop.findIndex((e) => e.type === "hyo_user_message" && e.qid === "q-p2");
  assert.ok(secondStart > firstResult, "and never interleaves with it");

  // 4. A permission answered on the phone resolves on the laptop too.
  laptop.length = 0;
  phone.length = 0;
  desk.sendUserMessage("please ask first", { qid: "q-l3" });
  await waitFor("both see the permission card", () => laptop.some((e) => e.type === "control_request") && phone.some((e) => e.type === "control_request"));
  const reqId = phone.find((e) => e.type === "control_request").request_id;
  pt.sendPermissionResponse(reqId, "allow", "Bash");
  await waitFor("the laptop's card closes", () => laptop.some((e) => e.type === "hyo_permission_answered" && e.requestId === reqId));
  // The laptop answering late changes nothing (it was answered once).
  desk.sendPermissionResponse(reqId, "deny");
  await waitFor("the turn finishes", () => laptop.some((e) => e.type === "result"));
  assert.match(textOf(laptop) + JSON.stringify(laptop.filter((e) => e.type === "assistant")), /Permission: allow/);

  // 5. A late joiner gets history plus the turn under way, then carries on live.
  laptop.length = 0;
  desk.sendUserMessage("slow and long from the laptop", { qid: "q-l4" });
  await waitFor("the turn is streaming", () => laptop.filter((e) => e.type === "stream_event").length >= 2);
  const late: any[] = [];
  const pt2 = new GatewayTransport({ gatewayUrl: url, tabId: "phone-2", sessionId: sid, onMessage: (e) => late.push(e), onError: () => {}, onClose: () => {} });
  pt2.spawn();
  const hist = await loadSessionHistory(url, sid, { tabId: pt2.wireId });
  const histText = JSON.stringify(hist.messages);
  assert.ok(histText.includes("hello from the laptop") && histText.includes("Echo: hello from the phone"), "history so far");
  assert.ok(!histText.includes("slow and long"), "stops where the turn under way began");
  await waitFor("the late joiner is caught up", () => late.some((e) => e.type === "hyo_replay"));
  const replay = late.find((e) => e.type === "hyo_replay");
  assert.equal(replay.turn.text, "slow and long from the laptop");
  await waitFor("and hears the rest live", () => late.some((e) => e.type === "result"));
  const seen = textOf(replay.turn.events) + textOf(late);
  assert.equal(seen, "Echo: slow and long from the laptop", "every part of the reply exactly once");

  // 6. Closing on one device never kills the turn the other is watching.
  laptop.length = 0;
  desk.sendUserMessage("slow, and the phone closes it", { qid: "q-l5" });
  await waitFor("streaming", () => laptop.some((e) => e.type === "stream_event"));
  pt.stop();
  pt2.stop();
  await waitFor("the laptop's turn still finishes", () => laptop.some((e) => e.type === "result"), 10000);
  await waitFor("the phone's tabs let go", () => owner.subscribers === 1);

  // 7. Nobody watching, nothing running: let go, process and all.
  desk.stop();
  await waitFor("the owner is let go", () => findSessionOwner(cwd, sid) === null, 3000);
  assert.equal(owner.running, false, "no process left behind");

  // 8. The transcript on disk has every turn, once each.
  const all = await loadSessionHistory(url, sid);
  const users = all.messages.filter((m: any) => m.role === "user").map((m: any) => m.content);
  assert.deepEqual(users, [
    "hello from the laptop",
    "hello from the phone",
    "slow one from the laptop",
    "second, from the phone",
    "please ask first",
    "slow and long from the laptop",
    "slow, and the phone closes it",
  ]);
});

test("a long conversation reaches the phone a page at a time, newest first", async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "hyo-e2e-long-"));
  const dir = getProjectDir(cwd);
  mkdirSync(dir, { recursive: true });
  const lines: string[] = [];
  // About Ev's real case: hundreds of lines, megabytes, big tool output.
  for (let i = 0; i < 360; i++) {
    lines.push(JSON.stringify({ type: "user", message: { role: "user", content: `Question ${i}` } }));
    lines.push(
      JSON.stringify({
        type: "assistant",
        message: { id: `m${i}`, role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: `Answer ${i}` }, { type: "tool_use", id: `t${i}`, name: "Read", input: { file_path: "/x" } }] },
      })
    );
    lines.push(JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: `t${i}`, content: "x".repeat(16000) }] } }));
  }
  writeFileSync(join(dir, "long.jsonl"), lines.join("\n") + "\n");

  const page = historyPage(cwd, "long");
  assert.ok(page.offset > 0, "not everything at once");
  assert.equal(page.total, 720);
  assert.equal(page.messages.at(-1)!.content, "Answer 359", "newest first");
  assert.ok(JSON.stringify(page.messages).length < 400_000, "a bounded page");
  assert.match(page.messages.at(-1)!.toolCalls![0].result!, /shortened for your phone/);

  // Over the wire, and the page before it.
  const config: any = { vault: cwd, cwd, getCwd: () => cwd, cliPath: fake, defaultAgent: "", defaultModel: "m", getLiveVoice: () => ({}), onConnectUrl: () => {}, onStatus: () => {}, updateClaude: async () => ({ ok: false }) };
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((r) => server.once("listening", () => r()));
  server.on("connection", (ws) => attachGatewaySocket(ws as any, { config: () => config, env: () => process.env }));
  const url = `ws://127.0.0.1:${(server.address() as any).port}`;
  const client = GatewayClient.get(url);
  t.after(() => {
    client.destroy();
    server.close();
  });
  let biggest = 0;
  const first = await loadSessionHistory(url, "long");
  assert.equal(first.offset, page.offset);
  biggest = Math.max(biggest, JSON.stringify(first).length);
  const older = await loadSessionHistory(url, "long", { before: first.offset });
  assert.equal(older.offset + older.messages.length, first.offset, "the page just before, no gap or overlap");
  // Together the two pages read straight on: nothing repeated, nothing skipped.
  const joined = [...older.messages, ...first.messages].map((m: any) => String(m.content));
  assert.equal(new Set(joined).size, joined.length);
  const nums = joined.map((c) => Number(c.replace(/\D+/g, "")));
  assert.ok(nums.every((x, i) => i === 0 || x - nums[i - 1] <= 1 && x >= nums[i - 1]));
  biggest = Math.max(biggest, JSON.stringify(older).length);
  assert.ok(biggest < 500_000, `each message on the wire stays small (largest ${biggest} bytes, the whole file is ${lines.join("\n").length})`);
});

test("opening a conversation can never hang: no answer means a plain error", async (t) => {
  // A Mac that's connected but never answers.
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((r) => server.once("listening", () => r()));
  server.on("connection", () => {});
  const url = `ws://127.0.0.1:${(server.address() as any).port}`;
  const client = GatewayClient.get(url);
  t.after(() => {
    client.destroy();
    server.close();
  });
  await waitFor("connected", () => client.getStatus() === "connected");
  const started = Date.now();
  await assert.rejects(client.getHistory("whatever", { timeoutMs: 300 }), /didn't send it within 30 seconds|Can't reach your Mac/);
  assert.ok(Date.now() - started < 2000);
  // Not connected at all: says that instead.
  server.close();
  for (const c of server.clients) c.terminate();
  await waitFor("the phone notices the Mac went away", () => client.getStatus() !== "connected");
  await assert.rejects(client.getHistory("whatever", { timeoutMs: 200 }), /Can't reach your Mac right now/);
});
