// The real session managers, desktop and phone, sharing conversations live.
//
// Both useSessionManager hooks run here (with a tiny React that runs a hook
// without a DOM, test/stubs/mini-react.ts): the desktop's against the real
// session owners and shared open list, the phone's against the gateway's
// real socket handling over a real WebSocket. Claude is the stand-in CLI
// (test/fixtures/fake-claude.mjs) spawned through the real ClaudeTransport.
// What this checks is what each device's chat ends up showing.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const home = mkdtempSync(join(tmpdir(), "hyo-hooks-home-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.HYO_MOBILE_SETTINGS = join(home, ".hyo", "mobile-settings.json");
const store = new Map<string, string>();
(globalThis as any).window = {
  localStorage: {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
  },
  setTimeout,
  clearTimeout,
};

import { WebSocketServer } from "ws";
import { mountHook } from "./stubs/mini-react";
import { useSessionManager as useDesk } from "../src/hooks/useSessionManager";
import { useSessionManager as usePhone } from "../src/mobile/hooks/useSessionManager";
import { attachGatewaySocket } from "../src/gateway-host";
import { ClaudeTransport } from "../src/claude-transport";
import { setSessionOwnerFactory, shutdownSessionOwners, gatewaySessionReset } from "../src/session-owner";
import { OpenConversationsStore, setOpenConversationsFactory, type OpenEntry } from "../src/open-conversations";
import { getProjectDir, hasTranscript, transcriptLineCount, listPinned } from "../src/session-parser";
import { GatewayClient } from "../src/mobile/gateway-client";

const fake = join(process.cwd(), "test", "fixtures", "fake-claude.mjs");
chmodSync(fake, 0o755);

async function waitFor(what: string, pred: () => boolean, ms = 10000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 15));
  }
  assert.fail(`timed out waiting for: ${what}`);
}

const said = (tab: any) => (tab?.messages || []).filter((m: any) => m.role === "user").map((m: any) => (m.displayText ?? m.content) + (m.queuedId ? " [queued]" : ""));
const replies = (tab: any) => (tab?.messages || []).filter((m: any) => m.role === "assistant" && !m.streaming).map((m: any) => m.content);

test("the desktop and phone session managers show the same conversation, live", async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "hyo-hooks-cwd-"));
  process.env.FAKE_PROJECT_DIR = getProjectDir(cwd);
  setSessionOwnerFactory({
    make: (spec, on) => new ClaudeTransport({ ...spec, sessionId: spec.sessionId || undefined, resume: !!spec.sessionId && hasTranscript(spec.cwd, spec.sessionId), ...on }),
    transcriptLines: (c, sid) => transcriptLineCount(c, sid),
    graceMs: 300,
  });
  let saved: OpenEntry[] | null = [];
  setOpenConversationsFactory(() => new OpenConversationsStore({ load: () => saved, save: (e) => (saved = e), seed: () => [] }));
  const config: any = { vault: cwd, cwd, getCwd: () => cwd, cliPath: fake, defaultAgent: "", defaultModel: "claude-opus-5-5", getLiveVoice: () => ({}), onConnectUrl: () => {}, onStatus: () => {}, updateClaude: async () => ({ ok: false }) };
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((r) => server.once("listening", () => r()));
  server.on("connection", (ws) => attachGatewaySocket(ws as any, { config: () => config, env: () => process.env }));
  const url = `ws://127.0.0.1:${(server.address() as any).port}`;

  const deskOpts = { cliPath: fake, cwd, model: "claude-opus-5-5", effort: "medium", permissionMode: "default", defaultAgent: "", autoGenerateTitles: false, mainChat: false };
  const desk = mountHook(useDesk as any, deskOpts) as any;
  const phone = mountHook(usePhone as any, { gatewayUrl: url, model: "claude-sonnet-5-5", agent: "", askFirst: true, mainChat: false }) as any;
  t.after(() => {
    desk.unmount();
    phone.unmount();
    GatewayClient.get(url).destroy();
    gatewaySessionReset();
    shutdownSessionOwners();
    setSessionOwnerFactory(null);
    setOpenConversationsFactory(null);
    server.close();
  });
  const D = () => desk.result();
  const P = () => phone.result();
  await waitFor("the phone connects", () => GatewayClient.get(url).getStatus() === "connected");

  // 1. A new conversation on the laptop opens on the phone, history and reply included.
  D().sendMessage("hello from the laptop");
  await waitFor("the laptop's reply", () => replies(D().tabs.at(-1)).includes("Echo: hello from the laptop"));
  const sid = D().tabs.at(-1).cliSessionId;
  assert.ok(sid, "the new conversation got its id at the first message");
  const pTab = () => P().tabs.find((x: any) => x.cliSessionId === sid);
  await waitFor("the phone has it open with the reply", () => replies(pTab()).includes("Echo: hello from the laptop"));
  assert.deepEqual(said(pTab()), ["hello from the laptop"]);
  assert.equal(pTab().loading, false, "not left loading");

  // 2. The phone sends: the laptop shows it and the reply.
  P().switchTab(pTab().id);
  await phone.flush();
  P().sendMessage("hello from the phone");
  const dTab = () => D().tabs.find((x: any) => x.cliSessionId === sid);
  await waitFor("the laptop shows the phone's message and reply", () => replies(dTab()).includes("Echo: hello from the phone"));
  assert.deepEqual(said(dTab()), ["hello from the laptop", "hello from the phone"]);
  await waitFor("the phone's own view", () => replies(pTab()).includes("Echo: hello from the phone"));
  assert.deepEqual(said(pTab()), ["hello from the laptop", "hello from the phone"], "its own message once, not twice");

  // 3. Held turns: shown queued on both while the first runs, then in order.
  D().switchTab(dTab().id);
  await desk.flush();
  D().sendMessage("slow one from the laptop");
  await waitFor("the phone sees the slow turn start", () => said(pTab()).includes("slow one from the laptop"));
  P().sendMessage("second, from the phone");
  await waitFor("queued on the laptop", () => said(dTab()).includes("second, from the phone [queued]"));
  await waitFor("queued on the phone", () => said(pTab()).includes("second, from the phone [queued]"));
  await waitFor("both turns done on the laptop", () => replies(dTab()).includes("Echo: second, from the phone"));
  await waitFor("both turns done on the phone", () => replies(pTab()).includes("Echo: second, from the phone"));
  const order = ["hello from the laptop", "hello from the phone", "slow one from the laptop", "second, from the phone"];
  assert.deepEqual(said(dTab()), order);
  assert.deepEqual(said(pTab()), order);
  assert.deepEqual(replies(dTab()), replies(pTab()), "the same replies on both, in the same places");

  // 4. A permission answered on the phone closes on the laptop.
  D().sendMessage("please ask first");
  const card = (tab: any) => (tab?.messages || []).flatMap((m: any) => m.permissionRequests || []).find((r: any) => r.toolName === "Bash");
  await waitFor("the card shows on both", () => !!card(dTab()) && !!card(pTab()));
  P().sendPermissionResponse(card(pTab()).requestId, "allow");
  await waitFor("answered on the laptop too", () => card(dTab())?.resolved === "allowed");
  await waitFor("the turn finishes", () => replies(dTab()).some((r: string) => r.includes("Echo: please ask first")));

  // 5. A second panel opened mid-turn: history so far, then the turn, exactly once.
  D().sendMessage("slow and long from the laptop");
  await waitFor("streaming on the phone", () => said(pTab()).includes("slow and long from the laptop"));
  const desk2 = mountHook(useDesk as any, deskOpts) as any;
  const d2Tab = () => desk2.result().tabs.find((x: any) => x.cliSessionId === sid);
  await waitFor("the second panel has it, finished", () => replies(d2Tab()).includes("Echo: slow and long from the laptop"), 15000);
  assert.deepEqual(said(d2Tab()), [...order, "please ask first", "slow and long from the laptop"]);
  assert.equal(replies(d2Tab()).filter((r: string) => r === "Echo: slow and long from the laptop").length, 1, "the turn once, not twice");
  desk2.unmount();

  // 6. Closed on the laptop while the phone has unsent text: stays until the box is empty.
  await waitFor("idle", () => !pTab().generating && !dTab().generating);
  P().setDraft(pTab().id, "something I haven't sent");
  D().closeTab(dTab().id);
  await waitFor("the laptop closed it", () => !dTab());
  await new Promise((r) => setTimeout(r, 200));
  await phone.flush();
  assert.ok(pTab(), "the phone keeps it while there's text in the box");
  assert.equal(P().activeTabId, pTab().id, "and stays on it");
  assert.equal(P().activeClosedElsewhere, true, "with the note saying why");
  P().setDraft(pTab().id, "");
  await waitFor("the close goes ahead once the box is empty", () => !pTab());
});

test("the phone never sits on 'Loading conversation…': a Mac that doesn't answer ends in a plain error", async (t) => {
  // A Mac that tells the phone a conversation is open, then never sends its history.
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((r) => server.once("listening", () => r()));
  const asked: string[] = [];
  server.on("connection", (ws) => {
    ws.on("message", (d) => {
      const m = JSON.parse(d.toString());
      if (m.type === "open_list") ws.send(JSON.stringify({ type: "open_list", entries: [{ id: "slow-convo", title: "A long one", peek: "Last line", lastActive: 1 }], sync: m.requestId }));
      if (m.type === "get_history") asked.push(m.sessionId);
    });
  });
  const url = `ws://127.0.0.1:${(server.address() as any).port}`;
  const phone = mountHook(usePhone as any, { gatewayUrl: url, model: "claude-sonnet-5-5", agent: "", askFirst: true, mainChat: false, historyTimeoutMs: 300 }) as any;
  t.after(() => {
    phone.unmount();
    GatewayClient.get(url).destroy();
    server.close();
  });
  const tab = () => phone.result().tabs.find((x: any) => x.cliSessionId === "slow-convo");
  await waitFor("the conversation opens from the Mac's list", () => !!tab());
  await waitFor("its history was asked for", () => asked.includes("slow-convo"), 3000);
  await waitFor("loading ends with a reason", () => !tab().loading && !!tab().loadError, 3000);
  assert.match(tab().loadError, /didn't send it/);
  assert.equal(phone.result().openHints["slow-convo"].peek, "Last line", "its Open row still has the Mac's last line");
  // Try again asks again.
  asked.length = 0;
  phone.result().retryLoad(tab().id);
  await waitFor("asked again", () => asked.includes("slow-convo"), 3000);
});

test("every composer control on the phone does what it does on the desktop, for the conversation in view", async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "hyo-hooks-mode-"));
  process.env.FAKE_PROJECT_DIR = getProjectDir(cwd);
  const spawned: any[] = [];
  setSessionOwnerFactory({
    make: (spec, on) => {
      spawned.push(spec);
      return new ClaudeTransport({ ...spec, sessionId: spec.sessionId || undefined, resume: !!spec.sessionId && hasTranscript(spec.cwd, spec.sessionId), ...on });
    },
    transcriptLines: (c, sid) => transcriptLineCount(c, sid),
    graceMs: 300,
  });
  let saved: OpenEntry[] | null = [];
  setOpenConversationsFactory(() => new OpenConversationsStore({ load: () => saved, save: (e) => (saved = e), seed: () => [], pins: () => listPinned(cwd) }));
  const config: any = { vault: cwd, cwd, getCwd: () => cwd, cliPath: fake, defaultAgent: "", defaultModel: "claude-opus-5-5", getLiveVoice: () => ({}), onConnectUrl: () => {}, onStatus: () => {}, updateClaude: async () => ({ ok: false }) };
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((r) => server.once("listening", () => r()));
  server.on("connection", (ws) => attachGatewaySocket(ws as any, { config: () => config, env: () => process.env }));
  const url = `ws://127.0.0.1:${(server.address() as any).port}`;
  // The laptop starts conversations in Auto-edit; the phone's own default is Ask first.
  const desk = mountHook(useDesk as any, { cliPath: fake, cwd, model: "claude-opus-5-5", effort: "medium", permissionMode: "acceptEdits", defaultAgent: "", autoGenerateTitles: false, mainChat: false }) as any;
  const phone = mountHook(usePhone as any, { gatewayUrl: url, model: "claude-sonnet-5-5", agent: "", askFirst: true, mainChat: false }) as any;
  t.after(() => {
    desk.unmount();
    phone.unmount();
    GatewayClient.get(url).destroy();
    gatewaySessionReset();
    shutdownSessionOwners();
    setSessionOwnerFactory(null);
    setOpenConversationsFactory(null);
    server.close();
  });
  const D = () => desk.result();
  const P = () => phone.result();
  await waitFor("the phone connects", () => GatewayClient.get(url).getStatus() === "connected");

  D().sendMessage("started on the laptop in auto-edit");
  await waitFor("reply", () => replies(D().tabs.at(-1)).includes("Echo: started on the laptop in auto-edit"));
  const sid = D().tabs.at(-1).cliSessionId;
  const pTab = () => P().tabs.find((x: any) => x.cliSessionId === sid);
  const dTab = () => D().tabs.find((x: any) => x.cliSessionId === sid);
  await waitFor("open on the phone", () => !!pTab() && !pTab().loading);
  P().switchTab(pTab().id);
  await phone.flush();
  await waitFor("the phone says Auto-edit", () => P().activePermissionMode === "acceptEdits");
  assert.equal(P().activeModel, "claude-opus-5-5", "and the model it really runs on");

  // Sending from the phone (whose default is Ask first) doesn't change it.
  P().sendMessage("from the phone");
  await waitFor("reply", () => replies(dTab()).includes("Echo: from the phone"));
  assert.equal(dTab().permissionMode, "acceptEdits");
  assert.equal(P().activePermissionMode, "acceptEdits");

  // Changed on the phone: the laptop shows it, Claude switched in place.
  P().setTabPermissionMode("manual");
  await waitFor("the laptop shows Ask first", () => dTab().permissionMode === "manual");
  // Changed on the laptop to one Claude can only start in: a fresh process, same conversation.
  D().switchTab(dTab().id);
  await desk.flush();
  D().setTabPermissionMode("bypassPermissions");
  await waitFor("the phone shows Never ask", () => P().activePermissionMode === "bypassPermissions");
  D().sendMessage("after the change");
  await waitFor("reply", () => replies(pTab()).includes("Echo: after the change"));
  assert.equal(P().activePermissionMode, "bypassPermissions");
  assert.deepEqual(said(dTab()), ["started on the laptop in auto-edit", "from the phone", "after the change"], "the same conversation throughout");

  // The model, picked on the phone: the laptop shows it and the next turn runs on it.
  P().setTabModel("claude-haiku-5-5");
  await waitFor("the laptop shows the phone's model", () => dTab().model === "claude-haiku-5-5");
  assert.equal(P().activeModel, "claude-haiku-5-5");
  const before = spawned.length;
  D().sendMessage("on the new model");
  await waitFor("reply", () => replies(pTab()).includes("Echo: on the new model"));
  assert.equal(spawned.length, before + 1, "a fresh process for the new model");
  assert.equal(spawned.at(-1)!.model, "claude-haiku-5-5");
  assert.equal(spawned.at(-1)!.sessionId, sid, "carrying on the same conversation");
  // And picked on the laptop: the phone shows it.
  D().setTabModel("claude-opus-5-5");
  await waitFor("the phone shows the laptop's model", () => P().activeModel === "claude-opus-5-5");

  // Effort, picked on the phone: the laptop shows it and the next process has it.
  P().setTabEffort("high");
  await waitFor("the laptop shows the phone's effort", () => dTab().effort === "high");
  D().sendMessage("thinking harder");
  await waitFor("reply", () => replies(pTab()).includes("Echo: thinking harder"));
  assert.equal(spawned.at(-1)!.effort, "high");
  assert.equal(spawned.at(-1)!.model, "claude-opus-5-5");

  // The agent, picked on the phone: as on the desktop, a new conversation with it in this tab.
  assert.equal(P().setTabAgent("researcher"), true);
  await phone.flush();
  assert.equal(P().activeTabHasSession, false);
  P().sendMessage("hello, researcher");
  await waitFor("the new conversation's reply", () => replies(P().tabs.find((x: any) => x.id === P().activeTabId)).includes("Echo: hello, researcher"));
  assert.equal(spawned.at(-1)!.agent, "researcher");
  assert.notEqual(spawned.at(-1)!.sessionId, sid);
});

test("unpinning closes the conversation on both devices, unless it's the one in view", async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "hyo-hooks-pin-"));
  process.env.FAKE_PROJECT_DIR = getProjectDir(cwd);
  setSessionOwnerFactory({
    make: (spec, on) => new ClaudeTransport({ ...spec, sessionId: spec.sessionId || undefined, resume: !!spec.sessionId && hasTranscript(spec.cwd, spec.sessionId), ...on }),
    transcriptLines: (c, sid) => transcriptLineCount(c, sid),
    graceMs: 300,
  });
  let saved: OpenEntry[] | null = [];
  setOpenConversationsFactory(() => new OpenConversationsStore({ load: () => saved, save: (e) => (saved = e), seed: () => [], pins: () => listPinned(cwd) }));
  const config: any = { vault: cwd, cwd, getCwd: () => cwd, cliPath: fake, defaultAgent: "", defaultModel: "claude-opus-5-5", getLiveVoice: () => ({}), onConnectUrl: () => {}, onStatus: () => {}, updateClaude: async () => ({ ok: false }) };
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((r) => server.once("listening", () => r()));
  server.on("connection", (ws) => attachGatewaySocket(ws as any, { config: () => config, env: () => process.env }));
  const url = `ws://127.0.0.1:${(server.address() as any).port}`;
  const desk = mountHook(useDesk as any, { cliPath: fake, cwd, model: "claude-opus-5-5", effort: "medium", permissionMode: "manual", defaultAgent: "", autoGenerateTitles: false, mainChat: false }) as any;
  const phone = mountHook(usePhone as any, { gatewayUrl: url, model: "claude-sonnet-5-5", agent: "", askFirst: true, mainChat: false }) as any;
  t.after(() => {
    desk.unmount();
    phone.unmount();
    GatewayClient.get(url).destroy();
    gatewaySessionReset();
    shutdownSessionOwners();
    setSessionOwnerFactory(null);
    setOpenConversationsFactory(null);
    server.close();
  });
  const D = () => desk.result();
  const P = () => phone.result();
  await waitFor("the phone connects", () => GatewayClient.get(url).getStatus() === "connected");

  // Two conversations from the laptop, both pinned.
  D().sendMessage("first");
  await waitFor("reply", () => replies(D().tabs.at(-1)).includes("Echo: first"));
  const a = D().tabs.at(-1).cliSessionId;
  D().newTab();
  await desk.flush();
  D().sendMessage("second");
  await waitFor("reply", () => replies(D().tabs.at(-1)).includes("Echo: second"));
  const b = D().tabs.at(-1).cliSessionId;
  D().setTaskMeta(a, { pinned: true });
  D().setTaskMeta(b, { pinned: true });
  const pinnedOnPhone = (sid: string) => !!P().pinnedSessionIds?.has(sid);
  await waitFor("pinned on the phone", () => pinnedOnPhone(a) && pinnedOnPhone(b));
  const has = (r: any, sid: string) => r.tabs.some((x: any) => x.cliSessionId === sid);
  await waitFor("both open on the phone", () => has(P(), a) && has(P(), b));

  // The laptop is looking at b. Unpinning a (not in view) closes it everywhere.
  D().setTaskMeta(a, { pinned: false });
  await waitFor("closed on the laptop", () => !has(D(), a));
  await waitFor("closed on the phone", () => !has(P(), a));
  // Unpinning b, the one in view on the laptop: it stays open, as an ordinary row, on both.
  D().setTaskMeta(b, { pinned: false });
  await waitFor("unpinned on the phone", () => !pinnedOnPhone(b));
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(has(D(), b), "still open on the laptop");
  assert.equal(D().tabs.find((x: any) => x.id === D().activeTabId).cliSessionId, b, "and still in view");
  assert.ok(has(P(), b), "and open on the phone as an ordinary row");

  // Unpinned on the phone, which isn't looking at it: closed on both.
  D().setTaskMeta(b, { pinned: true });
  await waitFor("pinned again on the phone", () => pinnedOnPhone(b));
  const other = P().tabs.find((x: any) => x.cliSessionId !== b);
  P().switchTab(other.id);
  await phone.flush();
  P().setTaskMeta(b, { pinned: false });
  await waitFor("closed on the phone", () => !has(P(), b));
  await waitFor("closed on the laptop too, even though it's in view there", () => !has(D(), b));
});
