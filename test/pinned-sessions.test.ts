// A pinned conversation is always in the list, however old. Both lists (the
// desktop's listPastSessions and the phone's, from the gateway) load the
// newest 150 conversations; a pin older than that used to be cut before its
// pin was ever read, and vanished.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const home = mkdtempSync(join(tmpdir(), "hyo-home-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.HYO_MOBILE_SETTINGS = join(home, "mobile-settings.json");

import { WebSocketServer } from "ws";
import { attachGatewaySocket } from "../src/gateway-host";
import { getProjectDir, listPastSessions, newestPlusPinned, SESSION_WINDOW } from "../src/session-parser";
import { GatewayClient } from "../src/mobile/gateway-client";

function session(dir: string, id: string, text: string, ageMinutes: number) {
  mkdirSync(dir, { recursive: true });
  const lines = [
    { type: "user", message: { role: "user", content: text }, uuid: "u1" },
    { type: "assistant", message: { id: "m1", role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: `Reply to ${text}. ${"padding ".repeat(80)}` }] }, uuid: "a1" },
  ];
  const file = join(dir, `${id}.jsonl`);
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  const t = new Date(Date.now() - ageMinutes * 60_000);
  utimesSync(file, t, t);
}

// 160 conversations, one a minute, newest first: recent-0 … recent-159. Then
// an old pinned one (ranked 161st), an old unpinned one, and a pin whose
// transcript has gone.
function vaultWithAnOldPin(): string {
  const cwd = mkdtempSync(join(tmpdir(), "hyo-cwd-"));
  const dir = getProjectDir(cwd);
  for (let i = 0; i < 160; i++) session(dir, `recent-${i}`, `conversation ${i}`, i + 1);
  session(dir, "old-pinned", "the Go High Level funnel", 60 * 24 * 14);
  session(dir, "old-unpinned", "something from a fortnight ago", 60 * 24 * 14 + 1);
  writeFileSync(
    join(dir, "session-metadata.json"),
    JSON.stringify({
      "old-pinned": { customTitle: "Momentum Club funnel Go High Level", pinned: true },
      "recent-3": { pinned: true },
      "gone-pinned": { customTitle: "Deleted by Claude Code's clean-up", pinned: true },
    })
  );
  return cwd;
}

test("newestPlusPinned: every pin, plus the newest window of the rest", () => {
  const rows = ["a", "P1", "b", "c", "P2", "d"];
  const isPinned = (r: string) => r.startsWith("P");
  assert.deepEqual(newestPlusPinned(rows, isPinned, 2), ["a", "P1", "b", "P2"], "pins don't use up the window");
  assert.deepEqual(newestPlusPinned(rows, isPinned, 0), ["P1", "P2"]);
  assert.deepEqual(newestPlusPinned(rows, () => false, 3), ["a", "P1", "b"], "no pins: just the newest window");
  assert.equal(SESSION_WINDOW, 150);
});

test("desktop: a pinned conversation older than the newest 150 is still listed", () => {
  const cwd = vaultWithAnOldPin();
  const ids = listPastSessions(cwd).map((s) => s.id);
  const old = listPastSessions(cwd).find((s) => s.id === "old-pinned");
  assert.ok(old, "the old pin is in the list");
  assert.equal(old!.pinned, true);
  assert.equal(old!.title, "Momentum Club funnel Go High Level");
  assert.ok(!ids.includes("old-unpinned"), "an old unpinned one is still cut");
  assert.ok(!ids.includes("gone-pinned"), "a pin with no transcript isn't listed");
  // 150 unpinned (recent-3 is a pin, so the window reaches recent-150) + 2 pins.
  assert.equal(ids.length, 152);
  assert.ok(ids.includes("recent-150") && !ids.includes("recent-151"), "pins don't use up the window");
  assert.equal(ids[ids.length - 1], "old-pinned", "still newest first");
});

test("phone: the gateway's list carries a pinned conversation older than the newest 150", async (t) => {
  const cwd = vaultWithAnOldPin();
  const config: any = {
    port: 0,
    vault: cwd,
    cwd,
    getCwd: () => cwd,
    cliPath: "claude",
    defaultAgent: "",
    defaultModel: "claude-opus-5-5",
    getLiveVoice: () => ({ engine: "elevenlabs", openAiApiKey: "", voice: "marin", personality: "" }),
    onConnectUrl: () => {},
    onStatus: () => {},
    updateClaude: async () => ({ ok: false }),
  };
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((r) => server.once("listening", () => r()));
  server.on("connection", (ws) => attachGatewaySocket(ws as any, { config: () => config, env: () => process.env }));
  const url = `ws://127.0.0.1:${(server.address() as any).port}`;
  const client = GatewayClient.get(url);
  t.after(() => {
    client.destroy();
    server.close();
  });

  const sessions = await client.listSessions();
  const ids = sessions.map((s: any) => s.id);
  const old = sessions.find((s: any) => s.id === "old-pinned");
  assert.ok(old, "the old pin reaches the phone");
  assert.equal(old.pinned, true);
  assert.ok(!ids.includes("old-unpinned"));
  assert.equal(ids.length, 152);
  assert.ok(ids.includes("recent-150") && !ids.includes("recent-151"), "pins don't use up the window");
});
