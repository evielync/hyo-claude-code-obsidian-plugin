// The gateway reads conversations from the Working directory, not the vault.
// Ev's "Hyo Test" vault points its Working directory at another folder; the
// phone has to see the same conversations the desktop panels do.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const home = mkdtempSync(join(tmpdir(), "hyo-home-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.HYO_MOBILE_SETTINGS = join(home, "mobile-settings.json");

import { WebSocketServer } from "ws";
import { attachGatewaySocket } from "../src/gateway-host";
import { getProjectDir } from "../src/session-parser";
import { GatewayClient } from "../src/mobile/gateway-client";
import { resolveWorkingDirectory } from "../src/working-directory";

function session(dir: string, id: string, text: string) {
  mkdirSync(dir, { recursive: true });
  const lines = [
    { type: "user", message: { role: "user", content: text }, uuid: "u1" },
    { type: "assistant", message: { id: "m1", role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: `Reply to ${text}. ${"padding ".repeat(80)}` }] }, uuid: "a1" },
  ];
  writeFileSync(join(dir, `${id}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

test("the Working directory setting resolves the same way everywhere", () => {
  assert.equal(resolveWorkingDirectory("", "/v"), "/v");
  assert.equal(resolveWorkingDirectory("~/Dropbox/EV-HQ", "/v", "/Users/ev"), "/Users/ev/Dropbox/EV-HQ");
  assert.equal(resolveWorkingDirectory("  ", "/v"), "/v");
});

test("vault ≠ working directory: the phone sees the working directory's conversations", async (t) => {
  const vault = mkdtempSync(join(tmpdir(), "hyo-vault-"));
  const cwd = mkdtempSync(join(tmpdir(), "hyo-cwd-"));
  session(getProjectDir(cwd), "cwd-session", "from the working directory");
  session(getProjectDir(vault), "vault-session", "from the vault");
  assert.notEqual(getProjectDir(cwd), getProjectDir(vault));

  const config: any = {
    port: 0,
    vault,
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
  assert.deepEqual(
    sessions.map((s: any) => s.id),
    ["cwd-session"],
    "only the working directory's conversation, never the vault's"
  );
  const h = await client.getHistory("cwd-session");
  assert.ok(JSON.stringify(h).includes("from the working directory"));
});
