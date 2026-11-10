// The dock: what each of its icons shows. Pure, so it can be unit tested
// without React, Obsidian or Claude (see test/dock-state.test.ts).
//
// The dock lists the conversations open in Hyo (the shared open list, the
// same one the tabs and the phone show). Each icon carries the conversation's
// first letter, a colour that stays the same for that conversation, a dot for
// its state, and a line saying what it's doing now or what it needs from you.

import type { TabSession } from "./hooks/useSessionManager";
import { deriveTaskState, hasPendingAttention, type TaskState } from "./task-state";
import { jobList } from "./background-jobs";

export type DockTone = 0 | 1 | 2 | 3 | 4;

export interface DockItem {
  tabId: string;
  sessionId: string | null;
  title: string;
  letter: string;
  tone: DockTone;
  state: TaskState;
  /** One line for the hover card: what it's doing now, or what it needs. */
  status: string;
  /** A reply finished that you haven't had on screen yet (read-state.ts). */
  unread: boolean;
}

/** The conversations the dock shows: every open one, plus `extraTabId` (a new chat being written in the pop-up before it has a session). */
export function dockItems(
  tabs: TabSession[],
  extraTabId?: string | null,
  unread: ReadonlySet<string> = new Set()
): DockItem[] {
  return tabs
    .filter((t) => t.isMain || !!t.cliSessionId || t.id === extraTabId)
    .map((t) => {
      const title = t.isMain ? "Main chat" : t.title || "New conversation";
      const jobs = jobList(t.jobs);
      const state = deriveTaskState({
        generating: t.generating || jobs.length > 0,
        hasPending: hasPendingAttention(t),
        closed: false,
      });
      // A reply that's landed shows as new even while background agents are
      // still running: those agents are the "working", the reply is waiting.
      const isUnread =
        state !== "needs-attention" && !t.generating && !!t.cliSessionId && unread.has(t.cliSessionId);
      return {
        tabId: t.id,
        sessionId: t.cliSessionId,
        title,
        letter: letterFor(title),
        tone: toneFor(t.cliSessionId || t.id),
        state,
        status: isUnread ? newReplyLine(jobs.length) : statusLine(t, state),
        unread: isUnread,
      };
    });
}

/** "New reply", plus how many background agents are still running. */
export function newReplyLine(agents: number): string {
  if (agents === 0) return "New reply";
  return `New reply · ${agents === 1 ? "1 agent" : `${agents} agents`} still working`;
}

/** The worst state across the dock, for the tucked-away handle's dot. */
export function overallState(items: DockItem[]): TaskState | "unread" {
  if (items.some((i) => i.state === "needs-attention")) return "needs-attention";
  if (items.some((i) => i.unread)) return "unread";
  if (items.some((i) => i.state === "working")) return "working";
  return "idle";
}

export function letterFor(title: string): string {
  const m = title.match(/[\p{L}\p{N}]/u);
  return m ? m[0].toUpperCase() : "•";
}

/** A colour per conversation that never changes, from its id. */
export function toneFor(id: string): DockTone {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return (Math.abs(h) % 5) as DockTone;
}

export function statusLine(tab: TabSession, state: TaskState = "idle"): string {
  if (state === "needs-attention") {
    for (const m of tab.messages as any[]) {
      if (!m || m.role !== "assistant") continue;
      const req = m.permissionRequests?.find((r: any) => !r.resolved);
      if (req) return `Needs your OK: ${stepWords(req.toolName, req.input).toLowerCase()}`;
      if (m.askQuestion) return "Has a question for you";
      if (m.planReview && !m.planReview.resolved) return "Has a plan for you to review";
    }
    return "Needs you";
  }
  if (state === "working") {
    if (tab.generating) {
      const tool = lastRunningTool(tab);
      return tool ? stepWords(tool.name, tool.input) : "Writing a reply";
    }
    const jobs = jobList(tab.jobs);
    if (jobs.length === 1) return `Background job: ${jobs[0].activity || jobs[0].title}`;
    return `${jobs.length} background jobs running`;
  }
  return "";
}

/** The newest tool call in the reply being written that hasn't come back yet. */
function lastRunningTool(tab: TabSession): { name: string; input: any } | null {
  for (let i = tab.messages.length - 1; i >= 0; i--) {
    const m: any = tab.messages[i];
    if (!m || m.role !== "assistant") continue;
    const calls: any[] = m.toolCalls || [];
    for (let j = calls.length - 1; j >= 0; j--) {
      if (calls[j] && calls[j].result == null) return calls[j];
    }
    return null;
  }
  return null;
}

/** A tool call in plain words: "Reading notes.md", "Searching the web". */
export function stepWords(name: string, input: any): string {
  const file = (p: unknown) => (typeof p === "string" ? p.split(/[\\/]/).pop() || p : "");
  const i = input || {};
  switch (name) {
    case "Read":
      return i.file_path ? `Reading ${file(i.file_path)}` : "Reading a file";
    case "Write":
      return i.file_path ? `Writing ${file(i.file_path)}` : "Writing a file";
    case "Edit":
    case "MultiEdit":
      return i.file_path ? `Editing ${file(i.file_path)}` : "Editing a file";
    case "Bash":
      return i.description ? String(i.description) : "Running a command";
    case "Grep":
    case "Glob":
      return "Searching your files";
    case "WebSearch":
      return "Searching the web";
    case "WebFetch":
      return "Reading a web page";
    case "Agent":
    case "Task":
      return i.description ? `Starting a job: ${i.description}` : "Starting a background job";
    case "Skill":
      return i.skill || i.name ? `Using the ${i.skill || i.name} skill` : "Using a skill";
    case "TodoWrite":
      return "Planning the steps";
    default:
      if (name.startsWith("mcp__")) {
        const server = name.split("__")[1] || "";
        const tidy = server.replace(/^claude_ai_/, "").replace(/_/g, " ");
        return tidy ? `Using ${tidy}` : "Using a connected app";
      }
      return name ? `Using ${name}` : "Working";
  }
}
