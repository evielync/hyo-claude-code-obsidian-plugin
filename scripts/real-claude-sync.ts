// Live sync against the REAL claude CLI, in a throwaway folder.
//
// Not part of `npm test` (it uses a Claude account and takes a minute).
// Run it by hand:
//   npx esbuild scripts/real-claude-sync.ts --bundle --platform=node --format=cjs \
//     --alias:obsidian=./test/stubs/obsidian.ts --outfile=/tmp/hyo-real-sync.cjs && node /tmp/hyo-real-sync.cjs
//
// Same wiring as test/sync-e2e.test.ts (the gateway's real socket handling
// on a private port, the session owners, ClaudeTransport, a desktop
// subscriber, the phone's GatewayClient and GatewayTransport), but the
// process is the real `claude`, working in a new temporary folder that is
// not a vault. Prints what it checked; exits non-zero on the first failure.
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

process.env.HYO_MOBILE_SETTINGS = join(mkdtempSync(join(tmpdir(), "hyo-real-settings-")), "mobile-settings.json");

import { WebSocketServer } from "ws";
import { attachGatewaySocket } from "../src/gateway-host";
import { ClaudeTransport } from "../src/claude-transport";
import { setSessionOwnerFactory, sessionOwner, findSessionOwner, shutdownSessionOwners, gatewaySessionReset, OwnerTransport } from "../src/session-owner";
import { hasTranscript, transcriptLineCount } from "../src/session-parser";
import { GatewayClient } from "../src/mobile/gateway-client";
import { GatewayTransport } from "../src/mobile/gateway-transport";
import { loadSessionHistory } from "../src/mobile/session-parser";

const CLI = process.env.CLAUDE_CLI || "claude";
const MODEL = process.env.CLAUDE_MODEL || "haiku";

const log = (m: string) => console.log(`[real-sync] ${m}`);
function check(ok: boolean, what: string): void {
  if (!ok) {
    console.error(`[real-sync] FAILED: ${what}`);
    process.exit(1);
  }
  log(`ok: ${what}`);
}
async function waitFor(what: string, pred: () => boolean, ms = 180_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  check(false, `timed out waiting for: ${what}`);
}
const streamed = (events: any[]) =>
  events
    .filter((e) => e.type === "stream_event" && !e.parent_tool_use_id)
    .map((e) => (e.event?.delta?.type === "text_delta" ? e.event.delta.text : ""))
    .join("");
const finalText = (events: any[]) => {
  const r = [...events].reverse().find((e) => e.type === "result");
  return typeof r?.result === "string" ? r.result : "";
};

async function main() {
  const cwd = mkdtempSync(join(tmpdir(), "hyo-real-claude-"));
  writeFileSync(join(cwd, "README.md"), "A throwaway folder for Hyo's live sync check.\n");
  log(`working in ${cwd} with ${CLI} (${MODEL})`);
  let spawns = 0;
  setSessionOwnerFactory({
    make: (spec, on) => {
      spawns++;
      return new ClaudeTransport({ ...spec, sessionId: spec.sessionId || undefined, resume: !!spec.sessionId && hasTranscript(spec.cwd, spec.sessionId), ...on });
    },
    transcriptLines: (c, sid) => transcriptLineCount(c, sid),
    graceMs: 500,
  });
  const config: any = {
    vault: cwd,
    cwd,
    getCwd: () => cwd,
    cliPath: CLI,
    defaultAgent: "",
    defaultModel: MODEL,
    getLiveVoice: () => ({}),
    onConnectUrl: () => {},
    onStatus: () => {},
    updateClaude: async () => ({ ok: false }),
  };
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((r) => server.once("listening", () => r()));
  server.on("connection", (ws) => attachGatewaySocket(ws as any, { config: () => config, env: () => process.env }));
  const url = `ws://127.0.0.1:${(server.address() as any).port}`;
  const client = GatewayClient.get(url);
  await waitFor("phone connected", () => client.getStatus() === "connected", 5000);

  const sid = randomUUID();
  const owner = sessionOwner(cwd, sid)!;
  const laptop: any[] = [];
  // Only this folder's settings, plus one that makes Claude ask before any
  // shell command, so the permission round trip happens whatever this
  // account's own settings allow.
  const settingsPath = join(cwd, "hyo-check-settings.json");
  writeFileSync(settingsPath, JSON.stringify({ permissions: { ask: ["Bash"] } }));
  const desk = new OwnerTransport(owner, () => ({ cliPath: CLI, cwd, model: MODEL, permissionMode: "default", agent: "", sessionId: sid, settingSources: "project", settingsPath }), {
    onMessage: (e) => laptop.push(e),
    onError: (e) => log(`laptop stderr: ${e.slice(0, 160).replace(/\n/g, " ")}`),
    onClose: (c) => log(`process closed (${c})`),
  });
  desk.spawn();
  const phone: any[] = [];
  const pt = new GatewayTransport({ gatewayUrl: url, tabId: "real-phone-1", sessionId: sid, onMessage: (e) => phone.push(e), onError: () => {}, onClose: () => {} });
  pt.spawn();
  await loadSessionHistory(url, sid, { tabId: pt.wireId });
  await waitFor("phone subscribed", () => owner.subscribers === 2, 5000);

  // 1. Laptop → phone.
  desk.sendUserMessage("Reply with exactly these words and nothing else: laptop ok", { qid: "l1" });
  await waitFor("reply to the laptop's message", () => phone.some((e) => e.type === "result"));
  check(phone.some((e) => e.type === "hyo_user_message" && e.qid === "l1"), "the phone saw the laptop's message");
  check(/laptop ok/i.test(finalText(phone)), `the phone got the reply ("${finalText(phone)}")`);
  check(phone.some((e) => e.type === "stream_event") || phone.some((e) => e.type === "assistant"), "the phone saw it stream in");

  // 2. Phone → laptop, same process.
  laptop.length = 0;
  pt.sendUserMessage("Reply with exactly these words and nothing else: phone ok", true, { qid: "p1" });
  await waitFor("reply to the phone's message", () => laptop.some((e) => e.type === "result"));
  check(laptop.some((e) => e.type === "hyo_user_message" && e.qid === "p1"), "the laptop saw the phone's message");
  check(/phone ok/i.test(finalText(laptop)), `the laptop got the reply ("${finalText(laptop)}")`);
  check(spawns === 1, "one Claude process for both");

  // 3. A turn that takes a while (a command, and a permission if this
  // account asks for one): a message queued behind it, a late joiner caught
  // up mid-turn, and the permission answered on the late joiner's phone.
  // (The CLI sends each message whole, not word by word, so a long-running
  // tool is what keeps a turn open long enough to join it.)
  laptop.length = 0;
  phone.length = 0;
  desk.sendUserMessage("Use the Bash tool to run this exact command: sleep 8 && echo hyo-sync-check . Then tell me what it printed, in one short line.", { qid: "l2" });
  await waitFor("the command is under way", () =>
    laptop.some((e) => e.type === "control_request") ||
    laptop.some((e) => e.type === "assistant" && (e.message?.content || []).some((b: any) => b.type === "tool_use"))
  );
  pt.sendUserMessage("Reply with exactly these words and nothing else: queued ok", true, { qid: "p2" });
  await waitFor("both show the queued message", () => laptop.some((e) => e.type === "hyo_queued") && phone.some((e) => e.type === "hyo_queued"), 10_000);
  const late: any[] = [];
  const pt2 = new GatewayTransport({ gatewayUrl: url, tabId: "real-phone-2", sessionId: sid, onMessage: (e) => late.push(e), onError: () => {}, onClose: () => {} });
  pt2.spawn();
  const hist = await loadSessionHistory(url, sid, { tabId: pt2.wireId });
  const ht = JSON.stringify(hist.messages);
  check(ht.includes("laptop ok") && ht.includes("phone ok"), "the late joiner's history has the earlier turns");
  check(!ht.includes("sleep 8"), "and stops where the turn under way began");
  await waitFor("the late joiner is caught up", () => late.some((e) => e.type === "hyo_replay"), 10_000);
  const replay = late.find((e) => e.type === "hyo_replay");
  check(replay.turn?.qid === "l2" && replay.turn.events.length > 0, `the replay carries the turn so far (${replay.turn?.events.length} events)`);
  check(replay.queued.some((q: any) => q.qid === "p2"), "the replay includes the queued message");
  const ask = replay.turn.events.find((e: any) => e.type === "control_request");
  if (ask) {
    check(laptop.some((e) => e.type === "control_request" && e.request_id === ask.request_id), "the laptop shows the same permission card");
    pt2.sendPermissionResponse(ask.request_id, "allow", ask.request?.tool_name);
    await waitFor("the laptop's card closes", () => laptop.some((e) => e.type === "hyo_permission_answered" && e.requestId === ask.request_id), 10_000);
    check(phone.some((e) => e.type === "hyo_permission_answered" && e.requestId === ask.request_id), "and the first phone tab's");
    check(true, `permission for ${ask.request?.tool_name}, answered on the late joiner, closed everywhere`);
  } else {
    log("note: Claude didn't ask for permission (this account allows the command), so that check was skipped");
  }
  await waitFor("the command's turn ends for the late joiner", () => late.some((e) => e.type === "result"));
  check(/hyo-sync-check/.test(finalText(late)), `the late joiner got the end of the turn ("${finalText(late)}")`);
  await waitFor("the queued message's turn finishes", () => laptop.filter((e) => e.type === "result").length >= 2);
  check(/queued ok/i.test(finalText(laptop)), "the queued message went after the turn before it");
  const starts = laptop.filter((e) => e.type === "hyo_user_message").map((e) => e.qid);
  check(JSON.stringify(starts) === JSON.stringify(["l2", "p2"]), "turns in order, never interleaved");
  check(spawns === 1, "still one Claude process");

  // 5. Closing everywhere lets go of the process.
  pt.stop();
  pt2.stop();
  desk.stop();
  await waitFor("the owner is let go", () => findSessionOwner(cwd, sid) === null, 5000);
  check(!owner.running, "no Claude process left running");

  client.destroy();
  gatewaySessionReset();
  shutdownSessionOwners();
  server.close();
  log("all checks passed against the real claude CLI");
  setTimeout(() => process.exit(0), 300);
}

main().catch((e) => {
  console.error("[real-sync] crashed:", e);
  process.exit(1);
});
