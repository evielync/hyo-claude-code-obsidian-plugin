// Automatic titles through the real session managers, desktop and phone.
// A conversation opened with "Hi Norm" is named after the first real message,
// not the greeting; a title someone typed is never replaced. The stand-in CLI
// (test/fixtures/fake-claude.mjs) answers a title call with "About: <the user
// message it was asked about>".
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const home = mkdtempSync(join(tmpdir(), "hyo-titles-home-"));
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
import { getProjectDir, hasTranscript, transcriptLineCount } from "../src/session-parser";
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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const replies = (tab: any) => (tab?.messages || []).filter((m: any) => m.role === "assistant" && !m.streaming).map((m: any) => m.content);

test("desktop and phone: a greeting opener gets a real title, a typed one is kept", async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "hyo-titles-cwd-"));
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

  const desk = mountHook(useDesk as any, { cliPath: fake, cwd, model: "claude-opus-5-5", effort: "medium", permissionMode: "default", defaultAgent: "", autoGenerateTitles: true, mainChat: false }) as any;
  const phone = mountHook(usePhone as any, { gatewayUrl: url, model: "claude-sonnet-5-5", agent: "", askFirst: true, mainChat: false, autoGenerateTitles: true }) as any;
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

  // Desktop: "Hi Norm" first. The tab takes the greeting, and keeps it until
  // there's something to name the conversation after.
  D().sendMessage("Hi Norm");
  const dTab = () => D().tabs.at(-1);
  await waitFor("Norm says hello back", () => replies(dTab()).includes("Echo: Hi Norm"));
  await sleep(300);
  assert.equal(dTab().title, "Hi Norm");
  D().sendMessage("Can you plan my week around the launch?");
  await waitFor("titled from the real question", () => dTab().title === "About: Can you plan my week around the launch?");

  // Desktop: a title typed by hand stays, however the conversation goes on.
  D().newTab();
  await desk.flush();
  D().sendMessage("hey");
  const typed = () => D().tabs.at(-1);
  await waitFor("reply to hey", () => replies(typed()).includes("Echo: hey"));
  D().renameTab(typed().id, "Launch prep");
  await desk.flush();
  D().sendMessage("What's left on the launch checklist?");
  await waitFor("reply", () => replies(typed()).includes("Echo: What's left on the launch checklist?"));
  await sleep(600);
  assert.equal(typed().title, "Launch prep");

  // Phone: the same greeting rule through the gateway's title call.
  P().newTab();
  await phone.flush();
  P().sendMessage("Hi Norm");
  const pTab = () => P().tabs.find((x: any) => x.id === P().activeTabId);
  await waitFor("phone: Norm says hello back", () => replies(pTab()).includes("Echo: Hi Norm"));
  await sleep(300);
  assert.equal(pTab().title, "Hi Norm");
  P().sendMessage("Draft the launch email for Thursday");
  await waitFor("phone: titled from the real message", () => pTab().title === "About: Draft the launch email for Thursday", 15000);
});
