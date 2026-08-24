// Hyo Gateway Host — desktop-only in-plugin port of the standalone
// hyo-gateway.mjs script (~/Dropbox/chad/scripts/hyo-gateway/hyo-gateway.mjs).
//
// Lets the Obsidian plugin host the mobile WebSocket gateway itself instead
// of requiring Ev to run a standalone Node script. Same wire protocol as the
// original script: the phone is a thin client, every request carries a
// `tabId`, and the gateway maps tabId -> a live `claude` subprocess,
// multiplexing its stream-json output back over the socket tagged by tabId.
//
// RPCs (client -> server), all JSON:
//   { type:'list_sessions' }
//   { type:'get_history',  sessionId }
//   { type:'rename',       sessionId, title }
//   { type:'set_task_meta', sessionId, patch }
//   { type:'prompt',       tabId, text, sessionId?, resume?, agent?, model? }
//   { type:'reattach',     tabIds:[...] }
//   { type:'permission_response', tabId, requestId, behavior, toolName?, updatedInput? }
//   { type:'interrupt',    tabId }
//   { type:'stop',         tabId }
//   { type:'generate_title', requestId, userMessage, assistantMessage }
//   { type:'list_agents' }
//   { type:'ping' }
// Server -> client:
//   { type:'stream', tabId, event }
//   { type:'sessions', sessions:[...] }
//   { type:'history', sessionId, lines:[...] }
//   { type:'renamed', sessionId, title }
//   { type:'task_meta_set', sessionId }
//   { type:'title', requestId, title }
//   { type:'agents', agents:[{ name, description }] }
//   { type:'gateway', subtype, ... }

import { Platform, Notice } from "obsidian";
import { debug } from "./debug";
import { getProjectDir, saveCustomTitle, setTaskMeta } from "./session-parser";
import type * as FsType from "fs";
import type * as PathType from "path";
import type * as OsType from "os";
import type { ChildProcess, SpawnOptionsWithoutStdio } from "child_process";
import type { WebSocket as WsSocket, WebSocketServer as WsServer } from "ws";

// Node built-ins are desktop-only; deferred so this module stays safe to
// import on mobile even though startGatewayHost/stopGatewayHost are never
// called there.
const fs: typeof FsType = Platform.isMobile ? (undefined as any) : require("fs");
const path: typeof PathType = Platform.isMobile ? (undefined as any) : require("path");
const os: typeof OsType = Platform.isMobile ? (undefined as any) : require("os");
const spawn: typeof import("child_process").spawn = Platform.isMobile
  ? (undefined as any)
  : require("child_process").spawn;
const randomUUID: typeof import("crypto").randomUUID = Platform.isMobile
  ? (undefined as any)
  : require("crypto").randomUUID;
const WebSocketServer: typeof WsServer = Platform.isMobile
  ? (undefined as any)
  : require("ws").WebSocketServer;

export interface GatewayHostConfig {
  port?: number;
  vault: string;
  cliPath: string;
  defaultAgent: string;
  defaultModel: string;
  // Called with the phone-facing wss:// URL once tailscale serve is up, so the
  // host can write it into the vault's synced settings — the phone then picks
  // it up automatically and needs nothing pasted.
  onConnectUrl?: (url: string) => void;
  // Called whenever the host's visible state changes, so the plugin can show a
  // live "mobile access" indicator instead of leaving the user guessing.
  onStatus?: (status: GatewayStatus) => void;
}

export interface GatewayStatus {
  state: "starting" | "on" | "error" | "off";
  // Present once tailscale serve is up and the phone-facing address is known.
  url?: string;
  // Connected phone clients right now.
  clients: number;
  // One plain-English line for the error state.
  detail?: string;
}

interface TabState {
  proc: ChildProcess;
  buffer: string;
  detach: boolean;
  client: WsSocket | null;
  outbox: unknown[];
  pendingToolInput: Map<string, Record<string, unknown>>;
  graceTimer: ReturnType<typeof setTimeout> | null;
  lastActivity: number;
  // True from a user prompt until the CLI's `result` event. A working tab is
  // never grace-killed on disconnect — pocketing the phone mid-task must not
  // stop the task. The grace window starts when the work finishes instead.
  generating: boolean;
}

interface SpawnTabOptions {
  sessionId?: string;
  resume?: boolean;
  askFirst?: boolean;
  model?: string;
  agent?: string;
  thinkingTokens?: number;
  detach?: boolean;
  appendSystemPrompt?: string;
}

// ---- Module-level state (survives across prompts, cleaned up on stop) -----
let wss: WsServer | null = null;
let sweeper: ReturnType<typeof setInterval> | null = null;
let activeConfig: Required<GatewayHostConfig> | null = null;
let activeEnv: NodeJS.ProcessEnv | null = null;
const tabs = new Map<string, TabState>();

const GRACE_MS = 180000; // 3 min — window for a mobile blip to reconnect
const IDLE_MAX_MS = 1800000; // 30 min — abandoned-tab idle ceiling
const SWEEP_MS = 30000; // idle check cadence
const MAX_OUTBOX = 5000; // cap buffered events / tab

const nowMs = () => Date.now();

function sendTo(ws: WsSocket | null | undefined, obj: unknown): void {
  try {
    if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
  } catch {
    // socket gone — nothing to do
  }
}

function emitToTab(state: TabState, obj: unknown): void {
  if (state.client && state.client.readyState === state.client.OPEN) {
    try {
      state.client.send(JSON.stringify(obj));
      return;
    } catch {
      // fall through to buffering
    }
  }
  if (state.detach) return;
  state.outbox.push(obj);
  if (state.outbox.length > MAX_OUTBOX) {
    state.outbox.splice(0, state.outbox.length - MAX_OUTBOX);
  }
}

function attachClient(state: TabState, ws: WsSocket): void {
  state.client = ws;
  state.lastActivity = nowMs();
  if (state.graceTimer) {
    clearTimeout(state.graceTimer);
    state.graceTimer = null;
  }
  const pending = state.outbox;
  state.outbox = [];
  for (const obj of pending) sendTo(ws, obj);
}

function killTab(tabId: string, why: string): void {
  const state = tabs.get(tabId);
  if (!state) return;
  if (state.graceTimer) {
    clearTimeout(state.graceTimer);
    state.graceTimer = null;
  }
  try {
    if (state.proc && !state.proc.killed) state.proc.kill("SIGTERM");
  } catch {
    // already dead
  }
  tabs.delete(tabId);
  debug(`[hyo][gateway] reap tab=${tabId} (${why})`);
}

// ---- History: read Claude Code's own session files -------------------------
// Directory resolution, titles, and task state all go through session-parser —
// the exact code the desktop history view uses. One encoder, one metadata
// file, so what the phone names or pins is what the desktop shows, and vice
// versa. (The gateway briefly had its own path encoder; it disagreed with the
// CLI's on spaces and `~`, which split the metadata into two stores.)

function loadMetadata(dir: string): Record<string, any> {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, "session-metadata.json"), "utf8"));
  } catch {
    return {};
  }
}

function extractTitle(fullPath: string): string {
  try {
    const fd = fs.openSync(fullPath, "r");
    const buf = Buffer.alloc(16384);
    const bytes = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    for (const line of buf.slice(0, bytes).toString("utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const o = JSON.parse(line);
        if (o.type === "user" && o.message?.content) {
          const c = o.message.content;
          const text =
            typeof c === "string"
              ? c
              : Array.isArray(c)
                ? c
                    .filter((x: any) => x.type === "text")
                    .map((x: any) => x.text)
                    .join(" ")
                : "";
          if (text && !text.startsWith("<")) return text.slice(0, 60);
        }
      } catch {
        // skip malformed line
      }
    }
  } catch {
    // no such file / unreadable
  }
  return "Untitled";
}
void extractTitle; // kept for parity with the source script; listSessions uses firstUserText below

function firstUserText(fullPath: string): string {
  const CHUNK = 65536;
  const MAX_SCAN = 5 * 1024 * 1024;
  let fd: number | undefined;
  try {
    fd = fs.openSync(fullPath, "r");
    const buf = Buffer.alloc(CHUNK);
    let pos = 0;
    let carry = "";
    while (pos < MAX_SCAN) {
      const bytes = fs.readSync(fd, buf, 0, CHUNK, pos);
      if (bytes <= 0) break;
      pos += bytes;
      carry += buf.slice(0, bytes).toString("utf8");
      let nl: number;
      while ((nl = carry.indexOf("\n")) !== -1) {
        const line = carry.slice(0, nl);
        carry = carry.slice(nl + 1);
        if (!line.trim()) continue;
        let o: any;
        try {
          o = JSON.parse(line);
        } catch {
          continue;
        }
        if (o.type !== "user" || !o.message?.content) continue;
        const c = o.message.content;
        const text =
          typeof c === "string"
            ? c
            : Array.isArray(c)
              ? c
                  .filter((x: any) => x.type === "text")
                  .map((x: any) => x.text)
                  .join(" ")
              : "";
        const cleaned = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
        if (cleaned) return cleaned;
      }
    }
  } catch {
    // no such file / unreadable
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // already closed
      }
    }
  }
  return "";
}
const ROUTER_SIG = /capture-router|route this (?:single )?capture|BACKFILL MODE/i;

function snipText(text: string): string {
  const line = String(text)
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
    .replace(/[#*`>_]/g, "")
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!line) return "";
  return line.length > 100 ? line.slice(0, 98).trimEnd() + "…" : line;
}

function lastMessage(fullPath: string): { role: string | null; snippet: string } {
  try {
    const st = fs.statSync(fullPath);
    const len = Math.min(st.size, 16384);
    const fd = fs.openSync(fullPath, "r");
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, st.size - len);
    fs.closeSync(fd);
    const lines = buf
      .toString("utf8")
      .split("\n")
      .filter((l) => l.trim());
    for (let i = lines.length - 1; i >= 0; i--) {
      let o: any;
      try {
        o = JSON.parse(lines[i]);
      } catch {
        continue;
      }
      const c = o?.message?.content;
      const textOf = () =>
        Array.isArray(c)
          ? c.find((x: any) => x.type === "text" && x.text?.trim())?.text || ""
          : typeof c === "string"
            ? c
            : "";
      if (o?.type === "assistant") {
        const t = textOf();
        if (t.trim()) return { role: "assistant", snippet: snipText(t) };
      } else if (o?.type === "user") {
        const isTool = Array.isArray(c) && c.every((x: any) => x.type === "tool_result");
        if (!isTool) {
          const t = textOf().replace(/<file\s+name="[^"]+">[\s\S]*?<\/file>/g, "");
          if (t.trim()) return { role: "user", snippet: snipText(t) };
        }
      }
    }
  } catch {
    // no such file / unreadable
  }
  return { role: null, snippet: "" };
}

function listSessions(cwd: string) {
  const dir = getProjectDir(cwd);
  if (!fs.existsSync(dir)) return [];
  const meta = loadMetadata(dir);
  const rows: any[] = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".jsonl")) continue;
    const full = path.join(dir, f);
    let st: FsType.Stats;
    try {
      st = fs.statSync(full);
    } catch {
      continue;
    }
    if (st.size < 500) continue;
    const id = f.replace(/\.jsonl$/, "");
    const custom = meta[id]?.customTitle || meta[id]?.title;
    const ft = custom ? "" : firstUserText(full);
    if (!custom && ROUTER_SIG.test(ft)) continue;
    const title = custom || (ft && !ft.startsWith("<") ? ft.slice(0, 60) : "Untitled");
    const lm = lastMessage(full);
    const md = meta[id] || {};
    rows.push({
      id,
      title,
      date: st.mtimeMs,
      size: st.size,
      lastRole: lm.role,
      lastSnippet: lm.snippet,
      pinned: !!md.pinned,
      closed: !!md.closed,
      lastActive: md.lastActive || null,
    });
  }
  rows.sort((a, b) => b.date - a.date);
  return rows.slice(0, 150);
}

function getHistoryLines(cwd: string, sessionId: string) {
  const dir = getProjectDir(cwd);
  const full = path.join(dir, `${sessionId}.jsonl`);
  if (!fs.existsSync(full)) return [];
  const out: any[] = [];
  for (const line of fs.readFileSync(full, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // skip malformed line
    }
  }
  return out;
}

// ---- Agent listing (list_agents RPC) ---------------------------------------
// Scans ~/.claude/agents/*.md plus <vault>/.claude/agents/*.md, returning
// name (filename minus .md) + frontmatter `description:` when present.
function parseAgentFile(fullPath: string, name: string): { name: string; description: string } {
  let description = "";
  try {
    const content = fs.readFileSync(fullPath, "utf8");
    const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (fmMatch) {
      const descMatch = fmMatch[1].match(/^description:\s*(.*)$/m);
      if (descMatch) {
        description = descMatch[1].trim().replace(/^["']|["']$/g, "");
      }
    }
  } catch {
    // unreadable file — return name-only entry
  }
  return { name, description };
}

function listAgentsFromDir(dir: string): Array<{ name: string; description: string }> {
  if (!fs.existsSync(dir)) return [];
  const out: Array<{ name: string; description: string }> = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".md")) continue;
    const name = f.replace(/\.md$/, "");
    out.push(parseAgentFile(path.join(dir, f), name));
  }
  return out;
}

function listAgents(vault: string): Array<{ name: string; description: string }> {
  const seen = new Map<string, { name: string; description: string }>();
  const userDir = path.join(os.homedir(), ".claude", "agents");
  const vaultDir = path.join(vault, ".claude", "agents");
  // Vault agents load second so a vault-local override wins over the same-named
  // user-level agent (mirrors how project settings shadow user settings elsewhere).
  for (const a of listAgentsFromDir(userDir)) seen.set(a.name, a);
  for (const a of listAgentsFromDir(vaultDir)) seen.set(a.name, a);
  return Array.from(seen.values()).sort((a, b) => a.name.localeCompare(b.name));
}

// ---- Title generation (one-shot claude, mirrors title-generator.ts) -------
function generateTitle(cliPath: string, env: NodeJS.ProcessEnv, userMessage: string, assistantMessage: string): Promise<string | null> {
  return new Promise((resolve) => {
    const prompt = `Generate a short 3-6 word title (no quotes, no punctuation at the end) for a conversation that starts with this user message:\n\n"${userMessage}"\n\nAssistant replied:\n\n"${(assistantMessage || "").slice(0, 500)}"\n\nRespond with ONLY the title.`;
    let out = "",
      err = "";
    const p = spawn(cliPath, ["--print", prompt, "--model", "haiku"], {
      cwd: os.tmpdir(),
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timer = setTimeout(() => {
      debug("[hyo][gateway] title: timeout, killing");
      try {
        p.kill();
      } catch {
        // already dead
      }
      resolve(null);
    }, 45000);
    p.stdout?.on("data", (c: Buffer) => (out += c.toString()));
    p.stderr?.on("data", (c: Buffer) => (err += c.toString()));
    p.on("close", (code) => {
      clearTimeout(timer);
      const title = out.trim().replace(/^["']|["']$/g, "").slice(0, 60) || null;
      if (!title) debug(`[hyo][gateway] title: empty (code=${code}) stderr=${err.slice(0, 200)}`);
      resolve(title);
    });
    p.on("error", (e: Error) => {
      clearTimeout(timer);
      debug(`[hyo][gateway] title: spawn error ${e.message}`);
      resolve(null);
    });
  });
}

// ---- Tab spawn/write --------------------------------------------------------
function spawnTab(
  tabId: string,
  ws: WsSocket | null,
  config: Required<GatewayHostConfig>,
  env: NodeJS.ProcessEnv,
  opts: SpawnTabOptions = {},
): TabState {
  const { sessionId, resume, askFirst, model, agent, thinkingTokens, detach, appendSystemPrompt } = opts;
  const ask = askFirst !== false;
  const args = [
    "--output-format",
    "stream-json",
    "--input-format",
    "stream-json",
    "--verbose",
    "--model",
    model || config.defaultModel,
    "--max-thinking-tokens",
    thinkingTokens ? String(thinkingTokens) : "31999",
    "--no-chrome",
  ];
  // Only pass --agent when one is actually set. An empty string would become
  // `--agent ""`, which the CLI rejects; leaving it off uses the CLI default.
  const resolvedAgent = agent || config.defaultAgent;
  if (resolvedAgent) args.push("--agent", resolvedAgent);
  if (ask) {
    // Ask-first drops desktop local settings, then loads the phone's own
    // allowlist back on via --settings (non-destructive defaults + anything
    // the user has "Always allow"ed on the device).
    ensureMobileSettings();
    args.push(
      "--permission-mode", "default",
      "--permission-prompt-tool", "stdio",
      "--setting-sources", "user,project",
      "--settings", mobileSettingsPath(),
    );
  } else {
    args.push("--permission-mode", "bypassPermissions");
  }
  if (resume && sessionId) args.push("--resume", sessionId);
  else if (sessionId) args.push("--session-id", sessionId);
  if (appendSystemPrompt) args.push("--append-system-prompt", appendSystemPrompt);

  debug(`[hyo][gateway] spawn tab=${tabId} askFirst=${ask} ${resume ? "resume " + sessionId : "new"}${appendSystemPrompt ? " voice" : ""}`);
  const spawnOpts: SpawnOptionsWithoutStdio = { cwd: config.vault, env, stdio: ["pipe", "pipe", "pipe"] } as any;
  const proc = spawn(config.cliPath, args, spawnOpts);

  const state: TabState = {
    proc,
    buffer: "",
    detach: !!detach,
    client: ws || null,
    outbox: [],
    generating: false,
    pendingToolInput: new Map(),
    graceTimer: null,
    lastActivity: nowMs(),
  };
  tabs.set(tabId, state);

  proc.stdout?.on("data", (chunk: Buffer) => {
    state.lastActivity = nowMs();
    state.buffer += chunk.toString();
    const lines = state.buffer.split("\n");
    state.buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let ev: any;
      try {
        ev = JSON.parse(line);
      } catch {
        continue;
      }
      if (ev.type === "control_request" && ev.request?.subtype === "can_use_tool") {
        state.pendingToolInput.set(ev.request_id, ev.request.input ?? {});
      }
      if (ev.type === "result") {
        state.generating = false;
        // The turn finished with nobody watching: the reply is saved, so the
        // usual disconnect grace starts now rather than mid-work.
        if (!state.client && !state.detach && !state.graceTimer) {
          state.graceTimer = setTimeout(() => killTab(tabId, "grace expired"), GRACE_MS);
        }
      }
      emitToTab(state, { type: "stream", tabId, event: ev });
    }
  });
  proc.stderr?.on("data", (c: Buffer) => {
    const t = c.toString();
    if (!t.includes("[debug]")) debug(`[hyo][gateway] tab=${tabId} stderr: ${t.slice(0, 200)}`);
  });
  proc.on("close", (code) => {
    emitToTab(state, { type: "gateway", subtype: "tab_closed", tabId, code });
    if (state.graceTimer) {
      clearTimeout(state.graceTimer);
      state.graceTimer = null;
    }
    tabs.delete(tabId);
  });
  proc.on("error", (e: Error) => emitToTab(state, { type: "gateway", subtype: "error", tabId, error: e.message }));
  return state;
}

function writeStdin(tabId: string, obj: unknown): void {
  const t = tabs.get(tabId);
  if (t?.proc?.stdin?.writable) {
    t.proc.stdin.write(JSON.stringify(obj) + "\n");
    t.lastActivity = nowMs();
  }
}

// ---- Tailscale exposure ------------------------------------------------------
// "Enable mobile access" should be the whole Mac-side setup. Starting the
// gateway only binds localhost; this also runs `tailscale serve` so the phone
// can actually reach it, and surfaces the exact wss:// URL to paste on the
// phone. Best-effort: if Tailscale isn't installed/running it says so clearly
// instead of silently doing nothing.
//
// Each vault mounts at its own path on the machine's tailnet address
// (wss://<host>/hyo-<vault>), so several vaults can enable mobile access on
// the same Mac without fighting over the one root mount. The mount is removed
// again when the host stops.

// Path slug for this vault's serve mount, e.g. "EV-HQ" -> "hyo-ev-hq".
function vaultSlug(vaultPath: string): string {
  const name = path.basename(vaultPath || "vault");
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `hyo-${slug || "vault"}`;
}

let activeSlug: string | null = null;

// ---- Mobile allowlist --------------------------------------------------------
// Phone sessions in "ask first" mode deliberately drop the desktop's local
// settings (`--setting-sources user,project` in spawnTab). Instead they carry
// their OWN allowlist, loaded via `--settings` — a file the desktop never
// touches. Seeded with tools that are non-destructive by nature (reads,
// search, fetch); "Always allow" on the phone appends to it (addMobileAllow),
// so the list grows on the device without leaking into desktop rules.
const MOBILE_ALLOW_DEFAULTS = [
  // QMD — the context layer. Read-only semantic search over the vault.
  "mcp__qmd__query",
  "mcp__qmd__get",
  "mcp__qmd__multi_get",
  "mcp__qmd__status",
  // Local read/search family — no mutation.
  "Read",
  "Glob",
  "Grep",
  // Web — read-only lookups.
  "WebSearch",
  "WebFetch",
];

function mobileSettingsPath(): string {
  return process.env.HYO_MOBILE_SETTINGS || path.join(os.homedir(), ".hyo", "mobile-settings.json");
}

function readMobileAllow(): string[] {
  try {
    const j = JSON.parse(fs.readFileSync(mobileSettingsPath(), "utf8"));
    return Array.isArray(j?.permissions?.allow) ? j.permissions.allow : [];
  } catch {
    return [];
  }
}

function writeMobileAllow(allow: string[]): void {
  fs.mkdirSync(path.dirname(mobileSettingsPath()), { recursive: true });
  fs.writeFileSync(mobileSettingsPath(), JSON.stringify({ permissions: { allow } }, null, 2));
}

// Ensure the file exists and every default is present, preserving any tools
// the user has since added via "Always allow". Union, not overwrite — so a new
// default reaches existing installs without wiping the device's own picks.
function ensureMobileSettings(): void {
  try {
    writeMobileAllow(Array.from(new Set([...MOBILE_ALLOW_DEFAULTS, ...readMobileAllow()])));
  } catch {
    /* best-effort — a failed write just means ask-first prompts more */
  }
}

// Append one tool to the device allowlist (dedup). Called on "Always allow".
function addMobileAllow(toolName: string): void {
  try {
    const allow = readMobileAllow();
    if (!allow.includes(toolName)) writeMobileAllow([...allow, toolName]);
  } catch {
    /* best-effort */
  }
}

// ---- Gateway discovery -------------------------------------------------------
// Anything on this machine that needs to reach a vault's gateway (the Voice OS
// capture sweeper, future automations) reads its actual port from here instead
// of assuming one. Written when the server binds, removed on stop.
let discoverySlug: string | null = null;

function gatewaysDir(): string {
  return path.join(os.homedir(), ".hyo", "gateways");
}

function writeDiscovery(slug: string, vault: string, port: number): void {
  try {
    fs.mkdirSync(gatewaysDir(), { recursive: true });
    fs.writeFileSync(
      path.join(gatewaysDir(), `${slug}.json`),
      JSON.stringify({ vault, slug, port, pid: process.pid, startedAt: new Date().toISOString() }, null, 2),
    );
    discoverySlug = slug;
  } catch {
    /* best-effort — consumers fall back to their default port */
  }
}

function removeDiscovery(): void {
  if (!discoverySlug) return;
  try {
    fs.unlinkSync(path.join(gatewaysDir(), `${discoverySlug}.json`));
  } catch {
    /* already gone */
  }
  discoverySlug = null;
}

// Live status, pushed to the plugin's status bar indicator via onStatus.
let statusCb: ((s: GatewayStatus) => void) | null = null;
let currentStatus: GatewayStatus = { state: "off", clients: 0 };

function setStatus(patch: Partial<GatewayStatus>): void {
  currentStatus = { ...currentStatus, ...patch };
  try {
    statusCb?.(currentStatus);
  } catch {
    /* indicator must never break the host */
  }
}
function findTailscaleBin(): string | null {
  const candidates = [
    "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
    "/usr/local/bin/tailscale",
    "/opt/homebrew/bin/tailscale",
    "/usr/bin/tailscale",
  ];
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch {
      /* ignore */
    }
  }
  return null;
}

// Runs the tailscale CLI and reports (exitCode, stdout, stderr). On macOS the
// command is routed through `osascript`'s `do shell script`: the App Store
// Tailscale binary, spawned directly from an Electron app, exits 0 while
// actually doing nothing ("The Tailscale GUI failed to start… CLIError
// error 3"), and `do shell script` runs it with the process attribution it
// needs. Elsewhere (open-source CLI on Linux/Windows) a direct spawn is fine.
// Commands are serialised through a queue: a fast toggle (or plugin reload)
// otherwise races the previous mount's `off` against the new mount's add, and
// whichever lands second wins — observed as a spurious "serve failed".
let tsQueue: Promise<void> = Promise.resolve();

function runTailscale(
  tsBin: string,
  args: string[],
  onDone: (code: number, out: string, err: string) => void,
): void {
  tsQueue = tsQueue
    .then(
      () =>
        new Promise<void>((release) => {
          const done = (code: number, out: string, err: string) => {
            release();
            try {
              onDone(code, out, err);
            } catch {
              /* callback errors must not stall the queue */
            }
          };
          let child: ChildProcess;
          try {
            if (process.platform === "darwin") {
              const shellCmd = [tsBin, ...args].map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(" ");
              const script = `do shell script "${shellCmd.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
              child = spawn("/usr/bin/osascript", ["-e", script], { stdio: ["ignore", "pipe", "pipe"] });
            } else {
              child = spawn(tsBin, args, { stdio: ["ignore", "pipe", "pipe"] });
            }
          } catch (e: any) {
            done(-1, "", e?.message || String(e));
            return;
          }
          let out = "";
          let err = "";
          let settled = false;
          const settle = (code: number, o: string, e: string) => {
            if (settled) return;
            settled = true;
            done(code, o, e);
          };
          child.stdout?.on("data", (d: Buffer) => (out += d.toString()));
          child.stderr?.on("data", (d: Buffer) => (err += d.toString()));
          child.on("error", (e: Error) => settle(-1, out, e.message));
          child.on("close", (code: number | null) => {
            // Belt and braces: the App Store binary reports this failure with exit 0.
            if (/GUI failed to start/i.test(out + err)) {
              settle(-1, out, err || out);
            } else {
              settle(code ?? -1, out, err);
            }
          });
        }),
    )
    .catch(() => {
      /* keep the queue alive */
    });
}

function announceConnectUrl(tsBin: string, slug: string, onUrl: (url: string) => void): void {
  runTailscale(tsBin, ["status", "--json"], (code, out) => {
    try {
      const host = String((JSON.parse(out) as any)?.Self?.DNSName || "").replace(/\.$/, "");
      if (host) {
        const url = `wss://${host}/${slug}`;
        setStatus({ state: "on", url });
        // The caller decides whether this is news worth a Notice — it knows
        // the previously stored address. Every-startup pop-ups are noise; the
        // status bar already says mobile access is on.
        onUrl(url); // write into synced settings — phone connects with no paste
        return;
      }
    } catch {
      /* couldn't read hostname — the serve step still ran */
    }
    // Serve is up even though the address couldn't be read — say so rather
    // than leaving the indicator stuck on "starting".
    setStatus({ state: "on" });
  });
}

function setupTailscaleServe(port: number, slug: string, onUrl: (url: string) => void): void {
  const tsBin = findTailscaleBin();
  if (!tsBin) {
    setStatus({ state: "error", detail: "Tailscale isn't installed" });
    try {
      new Notice(
        "Hyo mobile access: Tailscale isn't installed. Install it and sign in, then turn mobile access off and on again.",
        12000,
      );
    } catch {
      /* ignore */
    }
    return;
  }
  // Two robustness layers before the first add:
  //
  // 1. Stale-mount cleanup. A gateway that dies without teardown (hard quit,
  //    crash) leaves its mount behind; if another vault's gateway later lands
  //    on that freed port, the stale mount silently routes one vault's phone
  //    to another vault's gateway. On every start, any hyo-* mount whose
  //    backend port has no listener is removed.
  // 2. Retry. During a plugin update the outgoing version's teardown and the
  //    new version's add run from separate module instances and can collide —
  //    the add loses and mobile access shows "not working" until a manual
  //    toggle. One delayed retry absorbs that (and other transient) failure.
  const attemptAdd = (attempt: number): void => {
    runTailscale(tsBin, ["serve", "--bg", `--set-path=/${slug}`, String(port)], (code, _out, err) => {
      if (code === 0) {
        activeSlug = slug;
        announceConnectUrl(tsBin, slug, onUrl);
        return;
      }
      if (attempt === 0) {
        setTimeout(() => attemptAdd(1), 3500);
        return;
      }
      setStatus({ state: "error", detail: "tailscale serve failed — is Tailscale running with HTTPS enabled?" });
      try {
        new Notice(
          `Hyo mobile access: 'tailscale serve' failed${err ? " — " + err.trim().split("\n")[0] : ""}. Check Tailscale is running and HTTPS is enabled.`,
          12000,
        );
      } catch {
        /* ignore */
      }
    });
  };
  cleanStaleMounts(tsBin, () => attemptAdd(0));
}

// Remove hyo-* serve mounts whose local backend is dead. Probes each mount's
// 127.0.0.1 port: a live gateway (this vault's or another's) accepts and is
// left alone; a refused connection means the gateway is gone and the mount is
// stale. Anything not hyo-prefixed is never touched.
function cleanStaleMounts(tsBin: string, done: () => void): void {
  runTailscale(tsBin, ["serve", "status", "--json"], (code, out) => {
    let mounts: { mountPath: string; port: number }[] = [];
    try {
      if (code === 0) {
        const cfg = JSON.parse(out);
        for (const host of Object.values<any>(cfg?.Web || {})) {
          for (const [p, h] of Object.entries<any>(host?.Handlers || {})) {
            const m = /^http:\/\/127\.0\.0\.1:(\d+)$/.exec(String(h?.Proxy || ""));
            if (m && /^\/hyo-/.test(p)) mounts.push({ mountPath: p, port: parseInt(m[1], 10) });
          }
        }
      }
    } catch {
      /* unparseable status — skip cleanup */
    }
    if (mounts.length === 0) {
      done();
      return;
    }
    const net = require("net");
    let pending = mounts.length;
    const finishOne = () => {
      if (--pending === 0) done();
    };
    for (const { mountPath, port } of mounts) {
      const sock = net.connect({ port, host: "127.0.0.1" });
      let settled = false;
      const settle = (alive: boolean) => {
        if (settled) return;
        settled = true;
        sock.destroy();
        if (alive) finishOne();
        else runTailscale(tsBin, ["serve", `--set-path=${mountPath}`, "off"], finishOne);
      };
      sock.once("connect", () => settle(true));
      sock.once("error", () => settle(false));
      sock.setTimeout(1200, () => settle(true)); // no verdict — leave it alone
    }
  });
}

// Find a free local port, starting at the preferred one and walking up. The
// gateway port is internal (Tailscale fronts it), so the user never has to
// know or care which one we land on — we just avoid whatever's already taken.
async function findFreePort(preferred: number): Promise<number> {
  const net = require("net");
  // Probe by connecting, not binding: bind checks miss cross-family listeners
  // (an IPv6 wildcard bind succeeds while IPv4 loopback is taken, and vice
  // versa), which made us claim ports that other services were already
  // answering on. A live listener accepts the connection; a free port refuses.
  const check = (p: number): Promise<boolean> =>
    new Promise((resolve) => {
      const sock = net.connect({ port: p, host: "127.0.0.1" });
      const done = (free: boolean) => {
        sock.destroy();
        resolve(free);
      };
      sock.once("connect", () => done(false)); // something answered — taken
      sock.once("error", (e: any) => done(e && e.code === "ECONNREFUSED"));
      sock.setTimeout(1500, () => done(false)); // no verdict — assume taken
    });
  for (let p = preferred; p < preferred + 50; p++) {
    if (await check(p)) return p;
  }
  return preferred;
}

// ---- Public API --------------------------------------------------------------

/**
 * Start the gateway host: opens a WebSocketServer on 127.0.0.1 and begins
 * accepting mobile connections. Idempotent — calling this while already
 * running stops the existing instance first and starts clean with the new
 * config.
 */
export function startGatewayHost(config: GatewayHostConfig): void {
  if (Platform.isMobile) return; // desktop-only host; never runs on mobile

  if (wss) {
    stopGatewayHost();
  }

  const resolved: Required<GatewayHostConfig> = {
    port: config.port ?? 8787,
    vault: config.vault,
    cliPath: config.cliPath,
    defaultAgent: config.defaultAgent,
    defaultModel: config.defaultModel,
    onConnectUrl: config.onConnectUrl ?? (() => {}),
    onStatus: config.onStatus ?? (() => {}),
  };
  activeConfig = resolved;
  statusCb = resolved.onStatus;
  currentStatus = { state: "starting", clients: 0 };
  setStatus({});

  // A stale absolute cliPath (wrong default, npm moved, new machine) must not
  // kill every session with a bare "exited (code -2)". If the configured file
  // doesn't exist, fall back to `claude` and let the PATH built below — which
  // covers the usual install locations — resolve it.
  if (resolved.cliPath && resolved.cliPath.includes("/") && !fs.existsSync(resolved.cliPath)) {
    debug(`[hyo][gateway] cliPath ${resolved.cliPath} doesn't exist — falling back to \`claude\` on PATH`);
    resolved.cliPath = "claude";
  }

  void (async () => {
    // Land on a free port before binding — no "8787 is taken" dead end.
    resolved.port = await findFreePort(resolved.port);

  const env: NodeJS.ProcessEnv = { ...process.env };
  const home = os.homedir();
  env.PATH = [
    "/usr/local/bin",
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    `${home}/.npm-global/bin`,
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
    process.env.PATH || "",
  ].join(":");
  activeEnv = env;

  const server = new WebSocketServer({ host: "127.0.0.1", port: resolved.port });
  wss = server;
  server.on("error", (e: any) => {
    const msg =
      e && e.code === "EADDRINUSE"
        ? `Port ${resolved.port} is already in use. Change the gateway port in Hyo settings (Mobile access).`
        : `Gateway error: ${e?.message || e}`;
    setStatus({ state: "error", detail: msg });
    try {
      new Notice(`Hyo mobile access: ${msg}`, 8000);
    } catch {
      /* Notice unavailable */
    }
    debug(`[hyo][gateway] ${msg}`);
  });
  debug(
    `[hyo][gateway] listening on ws://127.0.0.1:${resolved.port} vault=${resolved.vault} agent=${resolved.defaultAgent} model=${resolved.defaultModel}`,
  );

  // Local port discovery for same-machine consumers (capture sweeper etc.).
  writeDiscovery(vaultSlug(resolved.vault), resolved.vault, resolved.port);

  // Expose the gateway over the user's tailnet and tell them the phone URL, so
  // the toggle is the entire Mac-side setup — no Terminal command.
  setupTailscaleServe(resolved.port, vaultSlug(resolved.vault), resolved.onConnectUrl);

  sweeper = setInterval(() => {
    const now = nowMs();
    for (const [tabId, state] of tabs) {
      if (now - state.lastActivity > IDLE_MAX_MS) killTab(tabId, "idle ceiling");
    }
  }, SWEEP_MS);
  if ((sweeper as any).unref) (sweeper as any).unref();

  server.on("connection", (ws: WsSocket) => {
    const cid = Math.random().toString(36).slice(2, 8);
    debug(`[hyo][gateway] [${cid}] connected`);
    setStatus({ clients: currentStatus.clients + 1 });
    const send = (obj: unknown) => sendTo(ws, obj);

    ws.on("message", async (data: Buffer | string) => {
      if (!activeConfig || !activeEnv) return; // host stopped mid-flight
      const cfg = activeConfig;
      const env = activeEnv;
      let m: any;
      try {
        m = JSON.parse(data.toString());
      } catch {
        return;
      }
      try {
        switch (m.type) {
          case "list_sessions":
            send({ type: "sessions", sessions: listSessions(cfg.vault) });
            break;
          case "get_history":
            send({ type: "history", sessionId: m.sessionId, lines: getHistoryLines(cfg.vault, m.sessionId) });
            break;
          case "rename":
            saveCustomTitle(cfg.vault, m.sessionId, m.title);
            send({ type: "renamed", sessionId: m.sessionId, title: m.title });
            break;
          case "set_task_meta":
            setTaskMeta(cfg.vault, m.sessionId, m.patch || {});
            send({ type: "task_meta_set", sessionId: m.sessionId });
            break;
          case "list_agents":
            send({ type: "agents", agents: listAgents(cfg.vault) });
            break;
          case "reattach": {
            const ids: string[] = Array.isArray(m.tabIds) ? m.tabIds : m.tabId ? [m.tabId] : [];
            const attached: string[] = [],
              gone: string[] = [];
            for (const id of ids) {
              const state = tabs.get(id);
              if (state) {
                attachClient(state, ws);
                attached.push(id);
              } else gone.push(id);
            }
            debug(`[hyo][gateway] [${cid}] reattach — ${attached.length} live, ${gone.length} gone`);
            send({ type: "gateway", subtype: "reattached", attached, gone });
            break;
          }
          case "prompt": {
            let state = tabs.get(m.tabId);
            if (!state) {
              // Per-prompt `agent`/`model` override the configured defaults —
              // spawnTab falls back to config.defaultAgent/defaultModel only
              // when the client doesn't send its own value.
              state = spawnTab(m.tabId, ws, cfg, env, {
                sessionId: m.sessionId,
                resume: m.resume,
                askFirst: m.askFirst,
                model: m.model,
                agent: m.agent,
                thinkingTokens: m.thinkingTokens,
                detach: m.detach,
                appendSystemPrompt: m.appendSystemPrompt,
              });
            } else if (state.client !== ws) {
              attachClient(state, ws);
            }
            writeStdin(m.tabId, { type: "user", message: { role: "user", content: [{ type: "text", text: m.text }] } });
            state.generating = true;
            break;
          }
          case "permission_response": {
            const state = tabs.get(m.tabId);
            const originalInput = state?.pendingToolInput.get(m.requestId) ?? {};
            state?.pendingToolInput.delete(m.requestId);
            const withInput = (base: Record<string, unknown>) => ({
              ...base,
              updatedInput: m.updatedInput ?? originalInput,
            });

            let response: Record<string, unknown>;
            if (m.behavior === "deny") {
              response = { behavior: "deny", message: "Denied by user", decisionClassification: "user_reject" };
            } else if (m.behavior === "allow_always" && m.toolName) {
              // Persist to the mobile allowlist (durable across sessions,
              // device-only — never desktop rules). `session` destination
              // makes it take effect immediately in the running process.
              addMobileAllow(m.toolName);
              response = withInput({
                behavior: "allow",
                decisionClassification: "user_permanent",
                updatedPermissions: [
                  { type: "addRules", rules: [{ toolName: m.toolName }], behavior: "allow", destination: "session" },
                ],
              });
            } else {
              response = withInput({ behavior: "allow", decisionClassification: "user_temporary" });
            }
            writeStdin(m.tabId, { type: "control_response", response: { subtype: "success", request_id: m.requestId, response } });
            break;
          }
          case "interrupt":
            writeStdin(m.tabId, { type: "control_request", request_id: randomUUID(), request: { subtype: "interrupt" } });
            break;
          case "stop":
            killTab(m.tabId, "client stop");
            break;
          case "generate_title": {
            const title = await generateTitle(cfg.cliPath, env, m.userMessage, m.assistantMessage);
            send({ type: "title", requestId: m.requestId, title });
            break;
          }
          case "ping":
            send({ type: "gateway", subtype: "pong" });
            break;
        }
      } catch (e: any) {
        debug(`[hyo][gateway] [${cid}] handler error on ${m.type}: ${e.message}`);
        send({ type: "gateway", subtype: "error", error: e.message });
      }
    });

    ws.on("close", () => {
      setStatus({ clients: Math.max(0, currentStatus.clients - 1) });
      let inGrace = 0,
        detached = 0,
        working = 0;
      for (const [tabId, state] of tabs) {
        if (state.client !== ws) continue;
        state.client = null;
        if (state.detach) {
          detached++;
          continue;
        }
        // Mid-task tabs are left running: the disconnect grace only starts
        // once the turn finishes (see the `result` handler). The 30-minute
        // idle ceiling remains the backstop for a run that never finishes.
        if (state.generating) {
          working++;
          continue;
        }
        if (!state.graceTimer) {
          state.graceTimer = setTimeout(() => killTab(tabId, "grace expired"), GRACE_MS);
        }
        inGrace++;
      }
      debug(`[hyo][gateway] [${cid}] disconnected — ${working} still working, ${inGrace} in grace, ${detached} detached`);
    });
  });
  })();
}

/**
 * Stop the gateway host: closes the WebSocketServer and kills every spawned
 * child process. Safe to call even if the host isn't running.
 */
export function stopGatewayHost(): void {
  if (Platform.isMobile) return;

  if (sweeper) {
    clearInterval(sweeper);
    sweeper = null;
  }
  for (const tabId of Array.from(tabs.keys())) {
    killTab(tabId, "gateway host stopped");
  }
  if (wss) {
    try {
      wss.close();
    } catch {
      // already closed
    }
    wss = null;
  }
  // Remove this vault's serve mount so the phone-facing address goes away with
  // the toggle. Other vaults' mounts (and anything else served) are untouched.
  if (activeSlug) {
    const tsBin = findTailscaleBin();
    if (tsBin) {
      runTailscale(tsBin, ["serve", `--set-path=/${activeSlug}`, "off"], () => {
        /* best-effort */
      });
    }
    activeSlug = null;
  }
  removeDiscovery();
  setStatus({ state: "off", clients: 0, url: undefined, detail: undefined });
  statusCb = null;
  activeConfig = null;
  activeEnv = null;
}
