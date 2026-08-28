import { debug } from "./debug";
import { Platform } from "obsidian";
import type { Message, ToolCallData, OrderedBlock } from "./hooks/useChatEngine";
import type { PastSession } from "./session-parser";

const fs: typeof import("fs") = Platform.isMobile ? (undefined as any) : require("fs");
const path: typeof import("path") = Platform.isMobile ? (undefined as any) : require("path");
const os: typeof import("os") = Platform.isMobile ? (undefined as any) : require("os");

/**
 * Reads Codex's own conversation history off disk.
 *
 * Each engine serves its history however it does — Hyo doesn't impose a shared
 * format. Codex writes one "rollout" JSONL per conversation under
 * `~/.codex/sessions/YYYY/MM/DD/`, plus `session_index.jsonl` holding the names
 * shown in its own UI.
 *
 * Reading the files rather than calling `thread/list` is deliberate: listing
 * would otherwise mean starting an app server just to draw the history panel,
 * which takes seconds and spawns every configured MCP server.
 */

function codexHome(): string {
  return process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

function sessionsRoot(): string {
  return path.join(codexHome(), "sessions");
}

/** Names Codex shows for its own threads, latest entry per id winning. */
function loadThreadNames(): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    const file = path.join(codexHome(), "session_index.jsonl");
    if (!fs.existsSync(file)) return out;
    for (const line of fs.readFileSync(file, "utf-8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (entry?.id && entry?.thread_name) out[entry.id] = entry.thread_name;
      } catch {
        continue;
      }
    }
  } catch {
    // No index yet — titles fall back to the first user message.
  }
  return out;
}

function walkRollouts(dir: string, found: string[] = []): string[] {
  let entries: import("fs").Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkRollouts(full, found);
    else if (entry.name.endsWith(".jsonl")) found.push(full);
  }
  return found;
}

/**
 * The first user message of every Codex conversation is the injected AGENTS.md
 * instruction block, and interrupted turns leave a `<turn_aborted>` note. Both
 * are machinery rather than anything the user said, so neither should show in
 * the transcript or be used as a title.
 */
function isSyntheticUserText(text: string): boolean {
  const t = text.trimStart();
  if (t.startsWith("# AGENTS.md instructions")) return true;
  // Codex injects context into the user turn wrapped in a snake_case tag —
  // <turn_aborted>, <recommended_plugins>, <environment_context> and others it
  // adds over time. Matching the convention rather than a fixed list means a
  // new one doesn't show up as a message, or become a conversation's title.
  return /^<[a-z][a-z0-9_]*>/.test(t) || t.startsWith("<permissions instructions>");
}

function textOf(content: any): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((c: any) => c?.text ?? "")
    .join("")
    .trim();
}

interface RolloutHead {
  id: string;
  cwd: string;
  threadSource: string;
  startedAt: string;
}

/** The file's first line, however long it is. */
function readFirstLine(file: string): string | null {
  const CHUNK = 64 * 1024;
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, "r");
    let text = "";
    let offset = 0;
    // Bounded so a corrupt file with no newline can't be read into memory
    // whole. A megabyte is far beyond any real session_meta line.
    while (text.length < 1024 * 1024) {
      const buf = Buffer.alloc(CHUNK);
      const read = fs.readSync(fd, buf, 0, CHUNK, offset);
      if (read <= 0) break;
      offset += read;
      text += buf.subarray(0, read).toString("utf-8");
      const nl = text.indexOf("\n");
      if (nl !== -1) return text.slice(0, nl);
    }
    return text || null;
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // already closed
      }
    }
  }
}

/** Read only as far as the session_meta line — listing shouldn't parse whole files. */
function readHead(file: string): RolloutHead | null {
  try {
    // Rollouts open with session_meta, so only the first line is needed —
    // parsing whole files just to draw a list would mean reading every
    // megabyte of every conversation.
    //
    // That line is far bigger than it looks: it embeds Codex's entire base
    // instructions, which run to tens of kilobytes. Read in chunks until an
    // actual newline turns up rather than assuming any fixed size, or the JSON
    // arrives truncated and every session is silently skipped.
    const firstLine = readFirstLine(file);
    if (!firstLine) return null;
    const entry = JSON.parse(firstLine);
    if (entry?.type !== "session_meta") return null;
    const p = entry.payload || {};
    return {
      id: p.id,
      cwd: p.cwd || "",
      threadSource: p.thread_source || "user",
      startedAt: p.timestamp || entry.timestamp,
    };
  } catch {
    return null;
  }
}

/** First thing the user actually said, for conversations with no stored name. */
function firstUserLine(file: string): string | null {
  try {
    const lines = fs.readFileSync(file, "utf-8").split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      let entry: any;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (entry?.type !== "response_item") continue;
      const p = entry.payload;
      if (p?.type !== "message" || p.role !== "user") continue;
      const text = textOf(p.content);
      if (!text || isSyntheticUserText(text)) continue;
      return text.slice(0, 60);
    }
  } catch {
    // fall through
  }
  return null;
}

/**
 * Conversations Codex has had in this vault, newest first.
 *
 * Subagent threads (Codex's own reviewers and guardians) are excluded — they
 * are internal machinery, not conversations anyone had.
 */
export function listCodexSessions(cwd: string): PastSession[] {
  const names = loadThreadNames();
  const files = walkRollouts(sessionsRoot());
  const sessions: PastSession[] = [];

  for (const file of files) {
    const head = readHead(file);
    if (!head?.id) continue;
    if (head.threadSource !== "user") continue;
    if (head.cwd !== cwd) continue;

    let size = 0;
    let mtime = new Date(head.startedAt || Date.now());
    try {
      const stat = fs.statSync(file);
      size = stat.size;
      mtime = stat.mtime;
    } catch {
      // keep the timestamp from the file itself
    }

    const title = names[head.id] || firstUserLine(file) || "Untitled";
    sessions.push({ id: head.id, title, date: mtime, size });
  }

  sessions.sort((a, b) => b.date.getTime() - a.date.getTime());
  debug("[hyo] Codex sessions in", cwd, "->", sessions.length);
  return sessions;
}

function rolloutFileFor(sessionId: string): string | null {
  return (
    walkRollouts(sessionsRoot()).find((f) => f.includes(sessionId)) ?? null
  );
}

/** Full transcript for a Codex conversation, in Hyo's message shape. */
export function loadCodexSessionHistory(sessionId: string): Message[] {
  const file = rolloutFileFor(sessionId);
  if (!file) return [];

  const messages: Message[] = [];

  // Tool calls are matched to their output by call_id, which can arrive several
  // entries later, so they're tracked as the file is read and attached to the
  // assistant message that issued them.
  let pendingTools: ToolCallData[] = [];
  let pendingBlocks: OrderedBlock[] = [];
  let turnIndex = 0;

  const flushAssistant = (text: string) => {
    const blocks: OrderedBlock[] = [...pendingBlocks];
    if (text) blocks.push({ type: "text", content: text, turnIndex });
    messages.push({
      role: "assistant",
      content: text,
      thinking: "",
      toolCalls: [...pendingTools],
      orderedBlocks: blocks,
      streaming: false,
    });
    pendingTools = [];
    pendingBlocks = [];
    turnIndex = 0;
  };

  let lines: string[];
  try {
    lines = fs.readFileSync(file, "utf-8").split("\n");
  } catch {
    return [];
  }

  for (const line of lines) {
    if (!line.trim()) continue;
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    if (entry.type !== "response_item") continue;

    const p = entry.payload;

    if (p?.type === "message" && p.role === "user") {
      const text = textOf(p.content);
      if (!text || isSyntheticUserText(text)) continue;
      if (pendingTools.length) flushAssistant("");
      messages.push({ role: "user", content: text });
      continue;
    }

    if (p?.type === "message" && p.role === "assistant") {
      flushAssistant(textOf(p.content));
      continue;
    }

    if (p?.type === "function_call") {
      let input: any = {};
      try {
        input = JSON.parse(p.arguments || "{}");
      } catch {
        input = { arguments: p.arguments };
      }
      pendingTools.push({
        id: p.call_id,
        name: p.name || "tool",
        input,
        result: null,
      });
      pendingBlocks.push({ type: "tool", toolId: p.call_id, turnIndex });
      continue;
    }

    if (p?.type === "function_call_output") {
      const tool = pendingTools.find((t) => t.id === p.call_id);
      if (tool) {
        tool.result =
          typeof p.output === "string" ? p.output : JSON.stringify(p.output ?? "");
      }
      continue;
    }
  }

  if (pendingTools.length) flushAssistant("");
  return messages;
}
