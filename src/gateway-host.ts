// Hyo Gateway Host — the desktop end of mobile access.
//
// The phone is a thin client over one WebSocket. Every conversation it has
// open is subscribed (by the phone's tab id) to the Mac's one Claude
// process for that conversation, the same one the desktop panels use
// (session-owner.ts), and its events come back tagged with the tab id.
// Conversations, history, the open list, agents and skills all come from
// the Working directory, which can differ from the vault; the vault only
// names the phone's address.
//
// RPCs (client -> server), all JSON:
//   { type:'list_sessions' }
//   { type:'get_history',  sessionId, requestId?, tabId?, before? }   (a page; tabId subscribes)
//   { type:'attach',       tabId, sessionId }
//   { type:'restart',      tabId }
//   { type:'rename',       sessionId, title }
//   { type:'set_task_meta', sessionId, patch }
//   { type:'prompt',       tabId, text, content?, qid?, sessionId?, askFirst?, agent?, model?, appendSystemPrompt? }
//   { type:'reattach',     tabIds:[...] }
//   { type:'permission_response', tabId, requestId, behavior, toolName?, updatedInput? }
//   { type:'interrupt',    tabId }
//   { type:'stop',         tabId }
//   { type:'generate_title', requestId, userMessage, assistantMessage }
//   { type:'list_agents' }
//   { type:'list_skills' }
//   { type:'open_list', requestId }                 (subscribe + the whole list)
//   { type:'open_add',    id, title, opId }
//   { type:'open_remove', id, opId }
//   { type:'open_rename', id, title, opId }
//   { type:'open_replace', oldId, id, title, opId }
//   { type:'ping' }
// Server -> client:
//   { type:'open_list', entries:[{ id, title, pinned?, peek?, lastActive? }], sync?, ack? }
//   { type:'stream', tabId, event }
//   { type:'sessions', sessions:[...] }
//   { type:'history', sessionId, requestId, paged:true, messages, offset, total, model, voiceCalls }
//   { type:'renamed', sessionId, title }
//   { type:'task_meta_set', sessionId }
//   { type:'title', requestId, title }
//   { type:'agents', agents:[{ name, description }] }
//   { type:'skills', skills:[{ name, description }] }
//   { type:'gateway', subtype, ... }

import { Platform, Notice } from "obsidian";
import { debug } from "./debug";
import { getProjectDir, saveCustomTitle, setTaskMeta, saveVoiceCall, getVoiceCalls, readTranscriptEntries, parseSessionEntries, type HistoryMessage } from "./session-parser";
import { transcriptModel, resumeModel } from "./models";
import { callOnlySessions } from "./voice/voice-call";
import { buildLiveInstructions, readAgentIdentity } from "./voice/gpt-live";
import {
  mainChatOwner,
  findSessionOwner,
  gatewaySession,
  gatewayAttach,
  gatewaySessionGone,
  gatewaySessionReset,
  restartIdleOwners,
  onTurnEnded,
  type GatewaySessionContext,
} from "./session-owner";
import { openConversations, gatewayOpenList, gatewayOpenListGone, gatewayOpenListReset, gatewayOpenListRefresh, type OpenEntry } from "./open-conversations";
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

export interface LiveVoiceConfig {
  engine: string;
  openAiApiKey: string;
  /** Built-in name, or `{ id }` for a custom voice. */
  voice: string | { id: string };
  /** A custom voice's description, for the instructions. */
  voiceDescription?: string;
  personality: string;
  /** Settings → Voice → About you, read fresh for each call (text or the chosen note). */
  getAboutYou?: () => Promise<string>;
}

export interface GatewayHostConfig {
  port?: number;
  vault: string;
  // Where conversations live: the Hyo working directory setting, which can
  // differ from the vault. The vault only names the phone's address.
  cwd?: string;
  // Read at each message, so a change to the Working directory setting
  // reaches the phone without restarting mobile access.
  getCwd?: () => string;
  cliPath: string;
  defaultAgent: string;
  defaultModel: string;
  // Read at call time so a settings change on the desktop applies to the
  // phone's next call. The phone never holds the OpenAI key: the desktop
  // signs each WebRTC call on its behalf (docs: "keep the key on the server").
  getLiveVoice?: () => LiveVoiceConfig;
  // Called with the phone-facing wss:// URL once tailscale serve is up, so the
  // host can write it into the vault's synced settings — the phone then picks
  // it up automatically and needs nothing pasted.
  onConnectUrl?: (url: string) => void;
  // Called whenever the host's visible state changes, so the plugin can show a
  // live "mobile access" indicator instead of leaving the user guessing.
  onStatus?: (status: GatewayStatus) => void;
  // Runs the Claude update on this Mac when the phone asks for it (the
  // phone's "Update Claude" button). Reports progress through onPhase and
  // hands back the Claude path to spawn from now on.
  updateClaude?: (
    required: string,
    onPhase: (message: string) => void
  ) => Promise<{ ok: boolean; error?: string; cliPath?: string }>;
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

// ---- Module-level state (survives across prompts, cleaned up on stop) -----
let wss: WsServer | null = null;
let activeConfig: Required<GatewayHostConfig> | null = null;
let activeEnv: NodeJS.ProcessEnv | null = null;
let offTurnEnded: (() => void) | null = null;
function sendTo(ws: WsSocket | null | undefined, obj: unknown): void {
  try {
    if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
  } catch {
    // socket gone — nothing to do
  }
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
  // Conversations that are only a voice call so far (no transcript yet).
  for (const c of callOnlySessions(meta, (id) => fs.existsSync(path.join(dir, `${id}.jsonl`)))) {
    rows.push({
      id: c.id,
      title: c.title,
      date: c.date,
      size: 0,
      lastRole: c.lastRole,
      lastSnippet: c.lastSnippet,
      pinned: c.pinned,
      closed: c.closed,
      lastActive: c.lastActive || null,
      callOnly: true,
    });
  }
  rows.sort((a, b) => b.date - a.date);
  return rows.slice(0, 150);
}

// Full-text search for the phone's history screen. Same rules as desktop's
// searchSessionText: user/assistant text only, first hit per session, a short
// window around the match. The phone never sees the files, so this runs here.
const SEARCH_MAX_BYTES = 8 * 1024 * 1024;

function searchSessions(cwd: string, query: string): Record<string, string> {
  const needle = String(query || "").trim().toLowerCase();
  const hits: Record<string, string> = {};
  if (!needle) return hits;
  const dir = getProjectDir(cwd);
  if (!fs.existsSync(dir)) return hits;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".jsonl")) continue;
    const full = path.join(dir, f);
    try {
      const st = fs.statSync(full);
      if (st.size < 500) continue;
      const len = Math.min(st.size, SEARCH_MAX_BYTES);
      const fd = fs.openSync(full, "r");
      const buf = Buffer.alloc(len);
      try {
        fs.readSync(fd, buf, 0, len, 0);
      } finally {
        fs.closeSync(fd);
      }
      for (const line of buf.toString("utf8").split("\n")) {
        if (!line.trim() || !line.toLowerCase().includes(needle)) continue;
        let o: any;
        try {
          o = JSON.parse(line);
        } catch {
          continue;
        }
        if (o?.type !== "user" && o?.type !== "assistant") continue;
        const c = o.message?.content;
        const text = (
          typeof c === "string"
            ? c
            : Array.isArray(c)
              ? c
                  .filter((x: any) => x?.type === "text" && typeof x.text === "string")
                  .map((x: any) => x.text)
                  .join("\n")
              : ""
        )
          .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
          .replace(/<file\s+name="[^"]+">[\s\S]*?<\/file>/g, "");
        const flat = text.replace(/[#*`>_]/g, "").replace(/\s+/g, " ");
        const at = flat.toLowerCase().indexOf(needle);
        if (at === -1) continue;
        const start = Math.max(0, at - 40);
        const end = Math.min(flat.length, start + 100);
        hits[f.replace(/\.jsonl$/, "")] =
          (start > 0 ? "…" : "") + flat.slice(start, end).trim() + (end < flat.length ? "…" : "");
        break;
      }
    } catch {
      // unreadable file — skip it
    }
  }
  return hits;
}

// ---- History for the phone, a page at a time --------------------------------
// A long conversation is megabytes of transcript (one of Ev's: 720 lines,
// 6.3 MB); sent as one WebSocket message it can take longer to arrive than
// the phone waits. So the Mac parses the transcript with
// the same parser the desktop uses and sends the newest messages first, a
// bounded page at a time; the phone asks for older pages as it scrolls up.
// Long tool output and thinking are shortened on the way: the phone shows
// them folded, and the full text stays in the transcript.
const PAGE_BYTES = 300_000;
const PAGE_MAX_MESSAGES = 80;
const PHONE_TEXT_MAX = 4000;

function shorten(text: unknown, max: number): unknown {
  if (typeof text !== "string" || text.length <= max) return text;
  return text.slice(0, max) + "\n… (shortened for your phone; the full text is on your Mac)";
}

function shortenInput(input: any): any {
  if (!input || typeof input !== "object") return input;
  let size = 0;
  try {
    size = JSON.stringify(input).length;
  } catch {
    return {};
  }
  if (size <= PHONE_TEXT_MAX * 2) return input;
  const out: any = Array.isArray(input) ? [] : {};
  for (const [k, v] of Object.entries(input)) out[k] = typeof v === "string" ? shorten(v, PHONE_TEXT_MAX) : v;
  return out;
}

/** One message made light enough for the phone. */
export function forPhone(m: HistoryMessage): HistoryMessage {
  return {
    ...m,
    thinking: m.thinking ? (shorten(m.thinking, PHONE_TEXT_MAX * 2) as string) : m.thinking,
    toolCalls: m.toolCalls?.map((t) => ({ ...t, input: shortenInput(t.input), result: shorten(t.result, PHONE_TEXT_MAX) as string | null })),
    orderedBlocks: m.orderedBlocks?.map((b) => (b.type === "thinking" ? { ...b, content: shorten(b.content, PHONE_TEXT_MAX * 2) as string } : b)),
  };
}

export interface HistoryPage {
  messages: HistoryMessage[];
  /** Index of the first message in the whole conversation. */
  offset: number;
  total: number;
  model: string | null;
}

/**
 * The page of a conversation ending before message `before` (the newest
 * page when it's left out), cut where a turn still under way began
 * (`untilLine`), so that turn arrives live instead.
 */
export function historyPage(cwd: string, sessionId: string, opts: { before?: number; untilLine?: number | null; maxBytes?: number } = {}): HistoryPage {
  const entries = readTranscriptEntries(cwd, sessionId, opts.untilLine ?? null);
  const all = parseSessionEntries(entries);
  const { model, contextTokens } = transcriptModel(entries);
  const total = all.length;
  const end = typeof opts.before === "number" ? Math.max(0, Math.min(total, opts.before)) : total;
  const budget = opts.maxBytes ?? PAGE_BYTES;
  const page: HistoryMessage[] = [];
  let bytes = 0;
  let start = end;
  while (start > 0 && page.length < PAGE_MAX_MESSAGES) {
    const m = forPhone(all[start - 1]);
    const size = JSON.stringify(m).length;
    if (page.length > 0 && bytes + size > budget) break;
    page.unshift(m);
    bytes += size;
    start--;
  }
  return { messages: page, offset: start, total, model: resumeModel(model, contextTokens) };
}

/** Where a turn under way began in this conversation's transcript, if one is. */
function turnCut(cwd: string, sessionId: string): number | null {
  const own = findSessionOwner(cwd, sessionId);
  if (own) return own.turnStartLine;
  const main = mainChatOwner(cwd);
  return main && main.sessionId === sessionId ? main.turnStartLine : null;
}

// What an Open row on the phone shows besides the title: the last line and
// when it was last active. Read from the transcript's tail, and kept until
// the file changes.
const peekCache = new Map<string, { mtime: number; size: number; peek: string; lastActive: number }>();

function peekOf(cwd: string, sessionId: string): { peek?: string; lastActive?: number } {
  const file = path.join(getProjectDir(cwd), `${sessionId}.jsonl`);
  try {
    const st = fs.statSync(file);
    const hit = peekCache.get(file);
    if (hit && hit.mtime === st.mtimeMs && hit.size === st.size) return { peek: hit.peek, lastActive: hit.lastActive };
    const lm = lastMessage(file);
    const v = { mtime: st.mtimeMs, size: st.size, peek: lm.snippet, lastActive: Math.round(st.mtimeMs) };
    peekCache.set(file, v);
    if (peekCache.size > 500) peekCache.delete(peekCache.keys().next().value as string);
    return { peek: v.peek, lastActive: v.lastActive };
  } catch {
    return {};
  }
}

function withPeeks(cwd: string, entries: OpenEntry[]): OpenEntry[] {
  return entries.map((e) => ({ ...e, ...peekOf(cwd, e.id) }));
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

// ---- Skill listing (list_skills RPC) ---------------------------------------
// The same three folders desktop's useSkills() scans — ~/.claude/skills, the
// vault's .claude/skills and the vault's skills/ — so the phone's "/" menu
// offers exactly what desktop offers. Claude is spawned with cwd at the vault
// root, so the vault is the project here. Name and description only; the
// phone never needs the skill body.
function listSkillsFromDir(dir: string, seen: Map<string, { name: string; description: string }>): void {
  if (!fs.existsSync(dir)) return;
  let entries: FsType.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const d of entries) {
    if (!d.isDirectory()) continue;
    const skillFile = path.join(dir, d.name, "SKILL.md");
    if (!fs.existsSync(skillFile)) continue;
    let name = d.name;
    let description = "";
    try {
      const fmMatch = fs.readFileSync(skillFile, "utf8").match(/^---\r?\n([\s\S]*?)\r?\n---/);
      if (fmMatch) {
        const nm = fmMatch[1].match(/^name:\s*(.+)$/m);
        if (nm) name = nm[1].trim();
        const dm = fmMatch[1].match(/^description:\s*(.+)$/m);
        if (dm) description = dm[1].trim().replace(/^["']|["']$/g, "");
      }
    } catch {
      // unreadable SKILL.md — keep the folder name
    }
    if (!seen.has(name)) seen.set(name, { name, description });
  }
}

function listSkills(vault: string): Array<{ name: string; description: string }> {
  const seen = new Map<string, { name: string; description: string }>();
  listSkillsFromDir(path.join(os.homedir(), ".claude", "skills"), seen);
  listSkillsFromDir(path.join(vault, ".claude", "skills"), seen);
  listSkillsFromDir(path.join(vault, "skills"), seen);
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

// ---- Tailscale exposure ------------------------------------------------------
// "This computer is the gateway" should be the whole Mac-side setup. Starting the
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

// ---- Mobile startup log ------------------------------------------------------
// Mobile access runs on other people's machines, where the developer console is
// not somewhere anyone is going to look. Every step of startup is written here
// regardless of the debug setting, so a failure leaves evidence that can be read
// back later instead of having to be reproduced.
const MOBILE_LOG_MAX = 512 * 1024;

export function mobileLogPath(): string {
  return path.join(os.homedir(), ".hyo", "mobile.log");
}

function mlog(msg: string): void {
  debug(`[hyo][gateway] ${msg}`);
  try {
    const file = mobileLogPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      if (fs.statSync(file).size > MOBILE_LOG_MAX) fs.writeFileSync(file, "");
    } catch {
      /* no file yet */
    }
    fs.appendFileSync(file, `${new Date().toISOString()} ${msg}\n`);
  } catch {
    /* logging must never break startup */
  }
}

// Live status, pushed to the plugin's status bar indicator via onStatus.
let statusCb: ((s: GatewayStatus) => void) | null = null;
let currentStatus: GatewayStatus = { state: "off", clients: 0 };

function setStatus(patch: Partial<GatewayStatus>): void {
  currentStatus = { ...currentStatus, ...patch };
  if (patch.state) mlog(`status -> ${patch.state}${patch.detail ? ` (${patch.detail})` : ""}`);
  try {
    statusCb?.(currentStatus);
  } catch {
    /* indicator must never break the host */
  }
}

// Anything that goes wrong during startup ends here. The one rule this whole
// file now holds to: mobile access never sits in "starting" without a reason
// attached, because a status that means nothing costs someone their whole day.
function failStartup(detail: string): void {
  setStatus({ state: "error", detail });
  try {
    new Notice(`Hyo mobile access: ${detail}`, 12000);
  } catch {
    /* Notice unavailable */
  }
}
// Where Tailscale puts its CLI on each platform Hyo runs on. Windows ships the
// CLI inside the same install directory as the GUI; the MSI and the Store build
// both land under Program Files, and `ProgramFiles` is consulted first so a
// non-default system drive still resolves.
function tailscaleCandidates(): string[] {
  if (process.platform === "win32") {
    const progFiles = process.env["ProgramFiles"] || "C:\\Program Files";
    const progFilesX86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
    const localAppData = process.env["LOCALAPPDATA"] || "";
    return [
      path.join(progFiles, "Tailscale", "tailscale.exe"),
      path.join(progFilesX86, "Tailscale", "tailscale.exe"),
      path.join(progFiles, "Tailscale IPN", "tailscale.exe"),
      localAppData ? path.join(localAppData, "Tailscale", "tailscale.exe") : "",
    ].filter(Boolean);
  }
  return [
    "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
    "/usr/local/bin/tailscale",
    "/opt/homebrew/bin/tailscale",
    "/usr/bin/tailscale",
    "/usr/local/sbin/tailscale",
  ];
}

function findTailscaleBin(): string | null {
  for (const c of tailscaleCandidates()) {
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

// A tailscale call that never returns used to hang the queue for the life of
// the app, which is what leaves the status bar reading "starting…" forever with
// nothing to go on. Every call now has a deadline and a hung one is reported as
// a failure like any other.
const TS_TIMEOUT_MS = 10_000;

function runTailscale(
  tsBin: string,
  args: string[],
  onDone: (code: number, out: string, err: string) => void,
): void {
  const label = `tailscale ${args.join(" ")}`;
  tsQueue = tsQueue
    .then(
      () =>
        new Promise<void>((release) => {
          const done = (code: number, out: string, err: string) => {
            release();
            mlog(`${label} -> exit ${code}${err ? ` err=${err.trim().split("\n")[0]}` : ""}`);
            try {
              onDone(code, out, err);
            } catch (e: any) {
              // The queue must keep moving, but a throw here also means the
              // startup chain stopped partway. Say so rather than going quiet.
              failStartup(`mobile setup failed after '${label}': ${e?.message || String(e)}`);
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
          let timer: ReturnType<typeof setTimeout> | null = null;
          const settle = (code: number, o: string, e: string) => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            done(code, o, e);
          };
          timer = setTimeout(() => {
            try {
              child.kill();
            } catch {
              /* already gone */
            }
            settle(-1, out, err || `timed out after ${TS_TIMEOUT_MS / 1000}s`);
          }, TS_TIMEOUT_MS);
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
    // Naming the places that were checked turns "it says I don't have it but I
    // do" into something the person can actually act on.
    mlog(`tailscale binary not found; looked in: ${tailscaleCandidates().join(", ")}`);
    failStartup(
      `couldn't find Tailscale on this computer. Looked in: ${tailscaleCandidates().join(", ")}. Install Tailscale and sign in, then turn mobile access off and on again.`,
    );
    return;
  }
  mlog(`using tailscale binary ${tsBin}`);
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
      const reason = err ? err.trim().split("\n")[0] : `exit code ${code}`;
      failStartup(
        `Tailscale couldn't publish the address your phone connects to (${reason}). Check Tailscale is running and signed in, and that HTTPS is enabled for your network.`,
      );
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

/**
 * One phone connection: every message it sends, and what happens when it goes.
 * Exported so tests can run the gateway's real handling over a real socket
 * without Tailscale or the rest of startup.
 */
export interface GatewaySocketContext {
  config: () => Required<GatewayHostConfig> | null;
  env: () => NodeJS.ProcessEnv | null;
  /** Connected-client count changes, for the status bar. */
  onClients?: (delta: number) => void;
}

export function attachGatewaySocket(ws: WsSocket, ctx: GatewaySocketContext): void {
  const cid = Math.random().toString(36).slice(2, 8);
  debug(`[hyo][gateway] [${cid}] connected`);
  ctx.onClients?.(1);
  const send = (obj: unknown) => sendTo(ws, obj);
  const sink = { send, isOpen: () => ws.readyState === ws.OPEN };

  ws.on("message", async (data: Buffer | string) => {
    const cfg = ctx.config();
    const env = ctx.env();
    if (!cfg || !env) return; // host stopped mid-flight
    const cwd = cfg.getCwd() || cfg.cwd;
    let m: any;
    try {
      m = JSON.parse(data.toString());
    } catch {
      return;
    }
    try {
      // Every conversation the phone has open attaches to the Mac's one
      // process for it (session-owner.ts): prompts, answers, stop, reattach.
      const sessionCtx: GatewaySessionContext = {
        cwd,
        mintId: () => randomUUID(),
        allowOnPhone: addMobileAllow,
        specFor: (p, sessionId) => {
          // Ask-first drops the desktop's local settings and loads the
          // phone's own allowlist back on, as the phone's processes always did.
          const ask = p.askFirst !== false;
          if (ask) ensureMobileSettings();
          return {
            cliPath: cfg.cliPath,
            cwd,
            model: p.model || cfg.defaultModel,
            permissionMode: ask ? "default" : "bypassPermissions",
            agent: p.agent || cfg.defaultAgent,
            sessionId,
            appendSystemPrompt: p.appendSystemPrompt,
            adopt: true,
            ...(ask ? { settingSources: "user,project", settingsPath: mobileSettingsPath() } : {}),
          };
        },
      };
      if (gatewaySession(m, ws, sink, sessionCtx)) return;
      // Which conversations are open, shared with the Mac's panels
      // (open-conversations.ts). Pushed to the phone whenever it changes,
      // with each row's last line and when it was last active.
      const openList = openConversations(cwd);
      if (openList && gatewayOpenList(openList, m, ws, sink, (entries) => withPeeks(cwd, entries))) return;
      switch (m.type) {
        case "list_sessions":
          send({ type: "sessions", sessions: listSessions(cwd) });
          break;
        case "get_history": {
          const sessionId = typeof m.sessionId === "string" ? m.sessionId : "";
          const before = typeof m.before === "number" ? m.before : undefined;
          const page = sessionId ? historyPage(cwd, sessionId, { before, untilLine: turnCut(cwd, sessionId) }) : { messages: [], offset: 0, total: 0, model: null };
          send({
            type: "history",
            sessionId,
            requestId: m.requestId,
            paged: true,
            ...page,
            voiceCalls: getVoiceCalls(cwd, sessionId),
          });
          // Opening it: the phone hears the conversation live from here on,
          // starting with any turn under way (history stopped where it began).
          if (typeof m.tabId === "string" && before === undefined && sessionId) {
            gatewayAttach(sessionCtx, m.tabId, sessionId, ws, sink);
          }
          break;
        }
        case "search_sessions":
          send({ type: "search_results", query: m.query, hits: searchSessions(cwd, m.query) });
          break;
        case "rename":
          saveCustomTitle(cwd, m.sessionId, m.title);
          send({ type: "renamed", sessionId: m.sessionId, title: m.title });
          break;
        case "save_voice_call":
          // A call made on the phone, saved where desktop keeps its own.
          if (typeof m.sessionId === "string" && m.call && typeof m.call.id === "string") {
            saveVoiceCall(cwd, m.sessionId, m.call, typeof m.title === "string" ? m.title : undefined);
          }
          send({ type: "voice_call_saved", sessionId: m.sessionId });
          break;
        case "set_task_meta":
          setTaskMeta(cwd, m.sessionId, m.patch || {});
          send({ type: "task_meta_set", sessionId: m.sessionId });
          // A pin puts the conversation in everyone's Open list.
          if (m.patch && "pinned" in m.patch) openConversations(cwd)?.pinsChanged();
          break;
        case "list_agents":
          send({ type: "agents", agents: listAgents(cwd) });
          break;
        case "list_skills":
          send({ type: "skills", skills: listSkills(cwd) });
          break;
        case "generate_title": {
          const title = await generateTitle(cfg.cliPath, env, m.userMessage, m.assistantMessage);
          send({ type: "title", requestId: m.requestId, title });
          break;
        }
        case "live_config": {
          const lv = cfg.getLiveVoice?.();
          send({
            type: "live_config",
            requestId: m.requestId,
            engine: lv?.engine || "elevenlabs",
            voice: typeof lv?.voice === "string" ? lv.voice : lv?.voice ? "custom" : "marin",
          });
          break;
        }
        case "live_sdp": {
          // The phone's WebRTC offer → OpenAI's answer, signed here with the
          // desktop's key. The session (personality, the tab's agent identity,
          // history from the phone) is built here too, so the phone holds
          // nothing secret and follows the desktop's voice settings.
          const lv = cfg.getLiveVoice?.();
          if (!lv || lv.engine !== "gpt-live" || !lv.openAiApiKey) {
            send({
              type: "live_sdp_error",
              requestId: m.requestId,
              message: "Set the desktop's voice engine to GPT-Live and add an OpenAI key in Hyo settings there.",
            });
            break;
          }
          const agent = typeof m.agent === "string" && m.agent ? m.agent : cfg.defaultAgent;
          const history = Array.isArray(m.history) ? m.history.slice(-60) : [];
          // About you goes into the starting instructions, read fresh (capped
          // so a slow read never holds up the call).
          const aboutYou = lv.getAboutYou
            ? await Promise.race([lv.getAboutYou().catch(() => ""), new Promise<string>((r) => setTimeout(() => r(""), 1500))])
            : "";
          const session = {
            model: "gpt-live-1",
            delegation: { type: "client" },
            instructions: buildLiveInstructions(lv.personality, readAgentIdentity(agent), { voiceDescription: lv.voiceDescription, aboutYou }),
            input: history
              .filter((h: any) => h && (h.role === "user" || h.role === "assistant") && typeof h.text === "string" && h.text)
              .map((h: any) => ({
                type: "message",
                role: h.role,
                content: [{ type: h.role === "user" ? "input_text" : "output_text", text: String(h.text).slice(0, 4000) }],
              })),
            audio: { output: { voice: lv.voice || "marin" } },
          };
          void (async () => {
            try {
              const res = await fetch("https://api.openai.com/v1/live/sessions", {
                method: "POST",
                headers: { Authorization: `Bearer ${lv.openAiApiKey}`, "Content-Type": "application/json" },
                body: JSON.stringify({ session, transport: { type: "webrtc", sdp: m.sdp } }),
              });
              const data: any = await res.json().catch(() => ({}));
              if (!res.ok || !data?.transport?.sdp) {
                send({
                  type: "live_sdp_error",
                  requestId: m.requestId,
                  message: data?.error?.message || `OpenAI refused the call (${res.status})`,
                });
                return;
              }
              send({ type: "live_sdp_answer", requestId: m.requestId, sdp: data.transport.sdp, sessionId: data?.session?.id });
            } catch (e: any) {
              send({ type: "live_sdp_error", requestId: m.requestId, message: e?.message || "Couldn't reach OpenAI" });
            }
          })();
          break;
        }
        case "update_claude": {
          // The phone's "Update Claude" button. "started" goes back straight
          // away: a gateway from before this existed ignores the request,
          // and that silence is how the phone knows to fall back.
          const requestId = m.requestId;
          const required = typeof m.required === "string" ? m.required : "";
          send({ type: "claude_update", requestId, phase: "started" });
          void (async () => {
            try {
              const r = await cfg.updateClaude(required, (message) =>
                send({ type: "claude_update", requestId, phase: "progress", message }),
              );
              // Later spawns (the phone's resend) use the updated Claude.
              if (r.ok && r.cliPath) cfg.cliPath = r.cliPath;
              // Every idle conversation's process is still the old Claude:
              // restart them now. A busy one swaps on its next message.
              if (r.ok) restartIdleOwners();
              send({ type: "claude_update", requestId, phase: "done", ok: r.ok, error: r.error });
            } catch (e: any) {
              send({ type: "claude_update", requestId, phase: "done", ok: false, error: e?.message || String(e) });
            }
          })();
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
    ctx.onClients?.(-1);
    // The phone's conversations keep running on the Mac; their events wait
    // a while for it to come back (session-owner.ts).
    gatewaySessionGone(ws);
    gatewayOpenListGone(ws);
    debug(`[hyo][gateway] [${cid}] disconnected`);
  });
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
    cwd: config.cwd || config.vault,
    getCwd: config.getCwd ?? (() => resolved.cwd),
    getLiveVoice:
      config.getLiveVoice ??
      (() => ({ engine: "elevenlabs", openAiApiKey: "", voice: "marin", personality: "" })),
    cliPath: config.cliPath,
    defaultAgent: config.defaultAgent,
    defaultModel: config.defaultModel,
    onConnectUrl: config.onConnectUrl ?? (() => {}),
    onStatus: config.onStatus ?? (() => {}),
    updateClaude:
      config.updateClaude ?? (async () => ({ ok: false, error: "This Mac can't update Claude from here." })),
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
    try {
    mlog(`starting mobile access: platform=${process.platform} vault=${resolved.vault}`);
    // Land on a free port before binding — no "8787 is taken" dead end.
    resolved.port = await findFreePort(resolved.port);

  // Electron apps launched from the Dock or Start menu inherit a minimal PATH,
  // so the usual CLI install locations are prepended. The extra directories are
  // Unix-shaped; on Windows the inherited PATH already covers npm and winget
  // installs, and joining with the wrong separator would corrupt the whole
  // variable, so that platform gets its PATH passed through untouched.
  const env: NodeJS.ProcessEnv = { ...process.env };
  const home = os.homedir();
  env.PATH =
    process.platform === "win32"
      ? process.env.PATH || ""
      : [
          "/usr/local/bin",
          "/opt/homebrew/bin",
          "/opt/homebrew/sbin",
          path.join(home, ".local", "bin"),
          path.join(home, ".npm-global", "bin"),
          "/usr/bin",
          "/bin",
          "/usr/sbin",
          "/sbin",
          process.env.PATH || "",
        ].join(path.delimiter);
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

  // A turn that ends moves an Open row's last line on: the phone hears it.
  offTurnEnded?.();
  offTurnEnded = onTurnEnded(() => gatewayOpenListRefresh());

  server.on("connection", (ws: WsSocket) =>
    attachGatewaySocket(ws, {
      config: () => activeConfig,
      env: () => activeEnv,
      onClients: (d) => setStatus({ clients: Math.max(0, currentStatus.clients + d) }),
    })
  );
    } catch (e: any) {
      // Everything after the first await used to land here as an unhandled
      // rejection, leaving the indicator on "starting" with nothing said.
      failStartup(`mobile access couldn't start: ${e?.message || String(e)}`);
    }
  })();
}

// ---- Self-check --------------------------------------------------------------
// Everything mobile access depends on, checked from inside the plugin and
// reported in plain words. Nobody should have to open a terminal to find out
// why their phone can't reach their computer.

export interface MobileCheck {
  label: string;
  ok: boolean;
  detail: string;
  fix?: string;
}

function probePort(port: number): Promise<boolean> {
  const net = require("net");
  return new Promise((resolve) => {
    const sock = net.connect({ port, host: "127.0.0.1" });
    const done = (live: boolean) => {
      sock.destroy();
      resolve(live);
    };
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
    sock.setTimeout(1500, () => done(false));
  });
}

export async function checkMobileAccess(vaultPath: string, port: number): Promise<MobileCheck[]> {
  const checks: MobileCheck[] = [];
  if (Platform.isMobile) return checks;

  const slug = activeSlug || vaultSlug(vaultPath);
  const livePort = activeConfig?.port ?? port;
  const run = (bin: string, args: string[]) =>
    new Promise<{ code: number; out: string; err: string }>((resolve) =>
      runTailscale(bin, args, (code, out, err) => resolve({ code, out, err })),
    );

  const tsBin = findTailscaleBin();
  checks.push({
    label: "Tailscale is installed",
    ok: !!tsBin,
    detail: tsBin ? `Found at ${tsBin}` : `Not found. Looked in: ${tailscaleCandidates().join(", ")}`,
    fix: tsBin ? undefined : "Install Tailscale from tailscale.com/download, sign in, then run this check again.",
  });
  if (!tsBin) return checks;

  const status = await run(tsBin, ["status", "--json"]);
  let backend = "";
  let dnsName = "";
  try {
    const parsed = JSON.parse(status.out);
    backend = String(parsed?.BackendState || "");
    dnsName = String(parsed?.Self?.DNSName || "").replace(/\.$/, "");
  } catch {
    /* handled by the check below */
  }
  const running = backend === "Running";
  checks.push({
    label: "Tailscale is running and signed in",
    ok: running,
    detail: running
      ? `Connected as ${dnsName || "this computer"}`
      : backend
        ? `Tailscale says: ${backend}`
        : status.err.trim().split("\n")[0] || "Tailscale didn't answer",
    fix: running
      ? undefined
      : "Open Tailscale, sign in, and make sure this computer shows as connected. Then run this check again.",
  });

  const listening = await probePort(livePort);
  checks.push({
    label: "Hyo's gateway is listening",
    ok: listening,
    detail: listening ? `Running on port ${livePort}` : `Nothing is answering on port ${livePort}`,
    fix: listening ? undefined : "Turn mobile access off and on again.",
  });

  const serve = await run(tsBin, ["serve", "status", "--json"]);
  let mountPort: number | null = null;
  try {
    const cfg = JSON.parse(serve.out);
    for (const host of Object.values<any>(cfg?.Web || {})) {
      for (const [p, h] of Object.entries<any>(host?.Handlers || {})) {
        if (p !== `/${slug}`) continue;
        const m = /^http:\/\/127\.0\.0\.1:(\d+)$/.exec(String(h?.Proxy || ""));
        if (m) mountPort = parseInt(m[1], 10);
      }
    }
  } catch {
    /* handled by the check below */
  }
  const mounted = mountPort !== null && mountPort === livePort;
  checks.push({
    label: "Your phone's address is published",
    ok: mounted,
    detail: mounted
      ? `/${slug} points at port ${mountPort}`
      : mountPort !== null
        ? `/${slug} points at port ${mountPort}, but the gateway is on ${livePort}`
        : `No address is published for this vault (/${slug})`,
    fix: mounted
      ? undefined
      : "Turn mobile access off and on again. If it still fails, check that HTTPS is enabled for your network in the Tailscale admin console.",
  });

  if (mounted && dnsName) {
    checks.push({
      label: "Address your phone connects to",
      ok: true,
      detail: `wss://${dnsName}/${slug}`,
    });
  }

  mlog(`self-check: ${checks.map((c) => `${c.ok ? "ok" : "FAIL"} ${c.label}`).join(" | ")}`);
  return checks;
}

/**
 * Stop the gateway host: closes the WebSocketServer and kills every spawned
 * child process. Safe to call even if the host isn't running.
 */
export function stopGatewayHost(): void {
  if (Platform.isMobile) return;

  gatewaySessionReset();
  offTurnEnded?.();
  offTurnEnded = null;
  gatewayOpenListReset();
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
