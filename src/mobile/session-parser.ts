// Desktop read session .jsonl files straight off disk via fs. On mobile
// there's no fs — the gateway server holds ~/.claude and does the file
// lookups (see hyo-gateway.mjs's listSessions/getHistoryLines/
// saveCustomTitle, which mirror what this file used to do locally). This
// module now just RPCs the gateway for the raw data and keeps the exact
// same pure reconstruction logic desktop Hyo used to turn a session's
// jsonl lines into chat messages.

import { GatewayClient } from "./gateway-client";
import { isSelfStartedPrompt, isInjectedContext } from "../reply-stream";
import type { VoiceCallRecord } from "../voice/voice-call";

export interface PastSession {
  id: string;
  title: string;
  date: Date;
  size: number;
  // Role of the last real message + a short peek at it, supplied by the gateway
  // (it holds ~/.claude). Lets the task list show "waiting on response" and a
  // preview for conversations that aren't open as tabs.
  lastRole?: "user" | "assistant" | null;
  lastSnippet?: string;
  // Task state from the shared session metadata (cross-device).
  pinned?: boolean;
  closed?: boolean;
  lastActiveMeta?: string;
  // Began as a voice call; nothing has gone to Claude yet (see desktop).
  callOnly?: boolean;
}

export interface HistoryMessage {
  role: "user" | "assistant";
  content: string;
  displayText?: string;
  attachments?: { type: string; name: string }[];
  thinking?: string;
  toolCalls?: { id: string; name: string; input: any; result: string | null }[];
  orderedBlocks?: { type: "text" | "thinking" | "tool"; content?: string; toolId?: string; turnIndex: number }[];
}

export async function listPastSessions(gatewayUrl: string): Promise<PastSession[]> {
  try {
    const sessions = await GatewayClient.get(gatewayUrl).listSessions();
    return (sessions || []).map((s: any) => ({
      id: s.id,
      title: s.title || "Untitled",
      date: new Date(s.date),
      size: s.size,
      lastRole: s.lastRole ?? null,
      lastSnippet: s.lastSnippet || "",
      pinned: !!s.pinned,
      closed: !!s.closed,
      lastActiveMeta: s.lastActive || undefined,
      callOnly: !!s.callOnly,
    }));
  } catch (e) {
    console.error("[hyo] Failed to list past sessions:", e);
    return [];
  }
}

// Full-text search, run on the gateway. Resolves to {} on failure so the
// history screen shows no extra hits rather than breaking.
export async function searchPastSessions(gatewayUrl: string, query: string): Promise<Record<string, string>> {
  try {
    return await GatewayClient.get(gatewayUrl).searchSessions(query);
  } catch (e) {
    console.error("[hyo] Failed to search past sessions:", e);
    return {};
  }
}

export async function saveCustomTitle(gatewayUrl: string, sessionId: string, title: string): Promise<void> {
  try {
    await GatewayClient.get(gatewayUrl).rename(sessionId, title);
  } catch (e) {
    console.error("[hyo] Failed to save custom title:", e);
  }
}

// Persist pinned/closed to the shared session metadata via the gateway.
export function setTaskMeta(
  gatewayUrl: string,
  sessionId: string,
  patch: { pinned?: boolean; closed?: boolean; lastActive?: string }
): void {
  try {
    GatewayClient.get(gatewayUrl).setTaskMeta(sessionId, patch);
  } catch (e) {
    console.error("[hyo] Failed to save task meta:", e);
  }
}

export interface SessionHistory {
  messages: HistoryMessage[];
  /** The model this conversation was last running on, read from the transcript.
   *  Lets a resumed session continue on its own model instead of a hardcoded
   *  default — resuming must not silently switch the user's model, and forcing
   *  a long conversation onto a different model can overflow its context window
   *  ("Prompt is too long"). Null when the transcript records no model. */
  model: string | null;
  /** The conversation's voice calls, from the shared metadata. */
  voiceCalls: VoiceCallRecord[];
}

export async function loadSessionHistory(gatewayUrl: string, sessionId: string): Promise<SessionHistory> {
  try {
    const { lines, voiceCalls } = await GatewayClient.get(gatewayUrl).getHistory(sessionId);
    return { messages: parseSessionLines(lines), model: extractSessionModel(lines), voiceCalls };
  } catch (e) {
    console.error("[hyo] Failed to load session history:", e);
    return { messages: [], model: null, voiceCalls: [] };
  }
}

/** The model the conversation last ran on — from the most recent assistant
 *  turn that recorded one. Null if none is found. */
export function extractSessionModel(lines: any[]): string | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const model = lines[i]?.message?.model;
    if (typeof model === "string" && model && model !== "<synthetic>") {
      return model;
    }
  }
  return null;
}

// Pure reconstruction — unchanged from desktop Hyo's file-reading version,
// just takes already-parsed jsonl objects (what the gateway's `history`
// message carries) instead of reading and JSON.parse-ing them from disk.
export function parseSessionLines(lines: any[]): HistoryMessage[] {
  const messages: HistoryMessage[] = [];
  const pendingToolResults = new Map<string, string>();

  // Claude started the next turn itself: its reply is a message of its own.
  let replyBreak = false;

  for (const d of lines) {
    if (!d) continue;
    try {
      if (isSelfStartedPrompt(d)) {
        replyBreak = true;
        continue;
      }
      if (isInjectedContext(d)) continue;

      if (d.type === "user") {
        const content = d.message?.content;
        if (!content) continue;

        // Check if this is a tool_result message
        if (Array.isArray(content) && content.some((c: any) => c.type === "tool_result")) {
          for (const c of content) {
            if (c.type === "tool_result" && c.tool_use_id) {
              const result = typeof c.content === "string" ? c.content : JSON.stringify(c.content);
              pendingToolResults.set(c.tool_use_id, result);
            }
          }
          // Wire results to previous assistant's tool calls
          for (let i = messages.length - 1; i >= 0; i--) {
            if (messages[i].role === "assistant" && messages[i].toolCalls?.length) {
              for (const tc of messages[i].toolCalls!) {
                const result = pendingToolResults.get(tc.id);
                if (result !== undefined) tc.result = result;
              }
              break;
            }
          }
          pendingToolResults.clear();
          continue;
        }

        // Regular user message
        let rawText = "";
        const attachments: { type: string; name: string }[] = [];

        if (Array.isArray(content)) {
          rawText = content
            .filter((c: any) => c.type === "text")
            .map((c: any) => c.text || "")
            .join("")
            .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
            .replace(/<ide_[^>]*>[\s\S]*?<\/ide_[^>]*>/g, "")
            .trim();

          for (const c of content) {
            if (c.type === "document" && c.title) {
              attachments.push({ type: "file", name: c.title });
            } else if (c.type === "image") {
              attachments.push({ type: "image", name: "image" });
            }
          }
        } else if (typeof content === "string") {
          rawText = content.trim();
        }

        // New format: <file name="filename.md">content</file>
        // Old format: [File: filename.md]\ncontent
        const xmlFileRegex = /<file\s+name="([^"]+)">[\s\S]*?<\/file>/g;
        const oldFileRegex = /\[File:\s*([^\]]+)\]/g;

        let match;
        while ((match = xmlFileRegex.exec(rawText)) !== null) {
          attachments.push({ type: "file", name: match[1].trim() });
        }
        while ((match = oldFileRegex.exec(rawText)) !== null) {
          attachments.push({ type: "file", name: match[1].trim() });
        }

        let displayText = rawText;
        if (attachments.length > 0) {
          displayText = displayText.replace(/<file\s+name="[^"]+">[\s\S]*?<\/file>/g, "");

          if (displayText.trim().startsWith("[File:")) {
            const withoutMarkers = displayText.replace(/\[File:[^\]]+\]\n/g, "");
            const parts = withoutMarkers.split(/\n\n+/).filter((p) => p.trim());
            displayText = parts.length > 0 ? parts[parts.length - 1].trim() : "";
          } else {
            const firstFileIndex = displayText.indexOf("[File:");
            if (firstFileIndex !== -1) {
              displayText = displayText.substring(0, firstFileIndex).trim();
            }
          }
        }

        if (displayText || attachments.length > 0) {
          messages.push({
            role: "user",
            content: displayText,
            displayText: displayText,
            attachments: attachments.length > 0 ? attachments : undefined,
          });
        }
      }

      if (d.type === "assistant") {
        const content = d.message?.content || [];
        const textParts: string[] = [];
        const thinkingParts: string[] = [];
        const toolCalls: HistoryMessage["toolCalls"] = [];
        const orderedBlocks: HistoryMessage["orderedBlocks"] = [];
        let turnIndex = 0;

        for (const block of content) {
          if (block.type === "text" && block.text) {
            textParts.push(block.text);
            orderedBlocks!.push({ type: "text", content: block.text, turnIndex });
          } else if (block.type === "thinking" && block.thinking) {
            thinkingParts.push(block.thinking);
            orderedBlocks!.push({ type: "thinking", content: block.thinking, turnIndex });
          } else if (block.type === "tool_use") {
            toolCalls!.push({
              id: block.id,
              name: block.name,
              input: block.input,
              result: null,
            });
            orderedBlocks!.push({ type: "tool", toolId: block.id, turnIndex });
          }
        }

        const text = textParts.join("");
        if (text || toolCalls!.length > 0) {
          pushAssistant(messages, {
            role: "assistant",
            content: text,
            thinking: thinkingParts.join(""),
            toolCalls,
            orderedBlocks,
          }, d.message?.id, replyBreak);
          replyBreak = false;
        }
      }
    } catch {
      continue;
    }
  }

  return messages;
}

// Claude writes one line per content block (and one per API turn), so a single
// reply arrives as a string of assistant entries with only tool results
// between them. Fold them into one message, the way the live chat shows it, so
// a run of tool calls reads as one run. turnIndex numbers each API turn, which
// is what the skill-output hiding keys on: entries sharing a message id are
// the same turn.
const lastAssistantId = new WeakMap<object, string | undefined>();
function pushAssistant(messages: HistoryMessage[], entry: HistoryMessage, msgId: string | undefined, newReply = false): void {
  const prev = messages[messages.length - 1];
  if (!prev || prev.role !== "assistant" || newReply) {
    messages.push(entry);
    lastAssistantId.set(entry, msgId);
    return;
  }
  const prevBlocks = prev.orderedBlocks || [];
  const lastTurn = prevBlocks.length ? prevBlocks[prevBlocks.length - 1].turnIndex : 0;
  const sameTurn = !!msgId && msgId === lastAssistantId.get(prev);
  const offset = sameTurn ? lastTurn : lastTurn + 1;
  prev.orderedBlocks = [
    ...prevBlocks,
    ...(entry.orderedBlocks || []).map((b) => ({ ...b, turnIndex: b.turnIndex + offset })),
  ];
  prev.toolCalls = [...(prev.toolCalls || []), ...(entry.toolCalls || [])];
  prev.content = [prev.content, entry.content].filter(Boolean).join("\n\n");
  prev.thinking = [prev.thinking, entry.thinking].filter(Boolean).join("\n\n");
  lastAssistantId.set(prev, msgId);
}

/** Save a finished voice call on the gateway (fire-and-forget). */
export function saveVoiceCall(gatewayUrl: string, sessionId: string, call: VoiceCallRecord, title?: string): void {
  try {
    GatewayClient.get(gatewayUrl).saveVoiceCall(sessionId, call, title);
  } catch (e) {
    console.error("[hyo] Failed to save the voice call:", e);
  }
}
