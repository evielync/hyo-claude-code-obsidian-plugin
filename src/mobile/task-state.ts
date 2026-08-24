// Task mode — pure state derivation and list assembly for the History/task view.
//
// A "task" is just a conversation. A live one is a TabSession; a past one is a
// PastSession parsed off disk. Same task at different points in its life, joined
// by cliSessionId. The task list is the union of the two — every conversation,
// whether or not it's currently open as a tab. Everything here is pure and
// side-effect free so it can be unit tested without React or the CLI.
// See hyo-task-mode-build-spec.

import type { TabSession } from "./hooks/useSessionManager";
import type { PastSession } from "./session-parser";
import type { TaskMeta } from "../settings";

// Ev's status model:
//  needs-attention — a question or approval is waiting on you (agent is blocked)
//  needs-response  — the agent messaged, you haven't replied
//  working         — the agent is running right now
//  closed          — you closed it; done, nothing needed either way (stays listed)
//  idle            — quiet conversation, nothing pending, no pill
export type TaskState =
  | "working"
  | "needs-attention"
  | "needs-response"
  | "closed"
  | "idle";

export interface TaskStateInput {
  generating: boolean;
  hasPending: boolean; // a held question / approval / plan
  awaitingMyReply: boolean; // last message was the agent's, unanswered
  closed: boolean;
}

// A held question or approval means the agent is blocked on YOU — that wins
// over "working", because the process is still technically generating while it
// waits for your answer. So needs-attention is checked first.
export function deriveTaskState(input: TaskStateInput): TaskState {
  if (input.hasPending) return "needs-attention";
  if (input.generating) return "working";
  if (input.closed) return "closed";
  if (input.awaitingMyReply) return "needs-response";
  return "idle";
}

// Does this live tab have something explicitly waiting on the user? A held
// AskUserQuestion, a plan awaiting review, or an unanswered permission request.
// Mirrors tabAwaitingInput in ChatTabs so the pill stays in lockstep with the
// blocked prompts on the chat surface.
export function hasPendingAttention(tab: TabSession): boolean {
  for (const m of tab.messages as any[]) {
    if (!m || m.role !== "assistant") continue;
    if (m.permissionRequests?.some((r: any) => !r.resolved)) return true;
    if (m.askQuestion) return true;
    if (m.planReview && !m.planReview.resolved) return true;
  }
  return false;
}

// Is the ball in the user's court? True when the last real message in the
// conversation came from the agent and hasn't been replied to.
function liveAwaitingReply(tab: TabSession): boolean {
  if (tab.generating) return false;
  for (let i = tab.messages.length - 1; i >= 0; i--) {
    const m: any = tab.messages[i];
    if (!m) continue;
    if (m.role === "assistant") return !!(m.content && m.content.trim());
    if (m.role === "user") return false;
  }
  return false;
}

export interface BoardTask {
  key: string; // cliSessionId when known, else the live tab id
  cliSessionId: string | null;
  tabId: string | null; // present when the task has an open tab
  title: string;
  peek: string; // short look at where the conversation is / its last message
  state: TaskState;
  isOpen: boolean; // has a live tab right now
  pinned: boolean;
  closed: boolean;
  lastActive: number; // epoch ms, for recency sort + day grouping
  live: TabSession | null;
  past: PastSession | null;
}

// A one-line peek for a live conversation: a held question, "Working…", or the
// last thing the agent said.
export function derivePeek(tab: TabSession): string {
  for (const m of tab.messages as any[]) {
    if (m?.role === "assistant" && m.askQuestion) {
      const q = m.askQuestion.questions?.[0]?.question || m.askQuestion.question;
      if (q) return oneLine(q);
    }
    if (m?.role === "assistant" && m.planReview && !m.planReview.resolved) {
      return "Plan ready for your review";
    }
  }
  if (tab.generating) return "Working…";
  for (let i = tab.messages.length - 1; i >= 0; i--) {
    const m: any = tab.messages[i];
    if (m?.role === "assistant" && m.content) return oneLine(m.content);
    if (m?.role === "user" && m.content) return oneLine(m.content);
  }
  return "";
}

function oneLine(text: string): string {
  const line = String(text)
    .replace(/[#*`>_]/g, "")
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!line) return "";
  return line.length > 100 ? line.slice(0, 98).trimEnd() + "…" : line;
}

function metaFor(
  tasks: Record<string, TaskMeta>,
  cliSessionId: string | null
): TaskMeta {
  if (!cliSessionId) return {};
  return tasks[cliSessionId] || {};
}

// Assemble the task list: union of live tabs and past sessions, deduped on
// cliSessionId (a task with an open tab must never also appear as a past
// entry). Live state always wins. Sorted pinned-first, then by recency.
export function buildTaskList(
  tabs: TabSession[],
  pastSessions: PastSession[],
  tasks: Record<string, TaskMeta>,
  now: number = Date.now()
): BoardTask[] {
  const byKey = new Map<string, BoardTask>();

  for (const tab of tabs) {
    const meta = metaFor(tasks, tab.cliSessionId);
    const key = tab.cliSessionId || tab.id;
    byKey.set(key, {
      key,
      cliSessionId: tab.cliSessionId,
      tabId: tab.id,
      title: tab.title || meta.title || "Untitled",
      peek: derivePeek(tab),
      state: deriveTaskState({
        generating: tab.generating,
        hasPending: hasPendingAttention(tab),
        awaitingMyReply: liveAwaitingReply(tab),
        closed: !!meta.closed,
      }),
      isOpen: true,
      pinned: !!meta.pinned,
      closed: !!meta.closed,
      lastActive: meta.lastActive ? Date.parse(meta.lastActive) : now,
      live: tab,
      past: null,
    });
  }

  for (const past of pastSessions) {
    if (byKey.has(past.id)) continue; // already live — live wins
    const meta = metaFor(tasks, past.id);
    // If the agent spoke last and you haven't replied, the conversation needs
    // your response — that's the signal, and "mark done" is how you clear it.
    // Most finished chats will read needs-response, which is correct: they're
    // your backlog until you close them.
    const awaitingMyReply = past.lastRole === "assistant";
    byKey.set(past.id, {
      key: past.id,
      cliSessionId: past.id,
      tabId: null,
      title: past.title || meta.title || "Untitled",
      peek: past.lastSnippet || "",
      state: meta.closed
        ? "closed"
        : awaitingMyReply
        ? "needs-response"
        : "idle",
      isOpen: false,
      pinned: !!meta.pinned,
      closed: !!meta.closed,
      lastActive: meta.lastActive
        ? Date.parse(meta.lastActive)
        : past.date instanceof Date
        ? past.date.getTime()
        : Date.parse(String(past.date)),
      live: null,
      past,
    });
  }

  return sortTasks([...byKey.values()]);
}

// Pinned float to the top; then by urgency — blocked-on-you first, actively
// working next, then waiting on a reply, then quiet ones. Recency breaks ties.
// (Day grouping happens downstream, so in practice this orders within a day.)
const STATE_RANK: Record<TaskState, number> = {
  "needs-attention": 0,
  working: 1,
  "needs-response": 2,
  idle: 3,
  closed: 4,
};

export function sortTasks(list: BoardTask[]): BoardTask[] {
  return list.sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    if (STATE_RANK[a.state] !== STATE_RANK[b.state]) return STATE_RANK[a.state] - STATE_RANK[b.state];
    return b.lastActive - a.lastActive;
  });
}

export interface TaskGroup {
  label: string;
  tasks: BoardTask[];
}

// Group for display: a "Pinned" group first (if any), then by day —
// Today, Yesterday, then dates. Order within each group is already recency.
export function groupTasks(list: BoardTask[], now: number = Date.now()): TaskGroup[] {
  const pinned = list.filter((t) => t.pinned);
  const rest = list.filter((t) => !t.pinned);

  const groups: TaskGroup[] = [];
  if (pinned.length) groups.push({ label: "Pinned", tasks: pinned });

  const startOfDay = (ms: number) => {
    const d = new Date(ms);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  };
  const today = startOfDay(now);
  const dayMs = 86400000;

  const byLabel = new Map<string, BoardTask[]>();
  const dayOfLabel = new Map<string, number>();
  for (const t of rest) {
    const day = startOfDay(t.lastActive || now);
    let label: string;
    if (day === today) label = "Today";
    else if (day === today - dayMs) label = "Yesterday";
    else if (day > today - 7 * dayMs)
      label = new Date(t.lastActive).toLocaleDateString(undefined, {
        weekday: "long",
      });
    else label = new Date(t.lastActive).toLocaleDateString();
    if (!byLabel.has(label)) {
      byLabel.set(label, []);
      dayOfLabel.set(label, day);
    }
    byLabel.get(label)!.push(t);
  }
  // Newest day first — explicitly by date, not first-seen order, so urgency
  // sorting within the list can never hoist an older day above Today.
  const order = Array.from(byLabel.keys()).sort((a, b) => (dayOfLabel.get(b) || 0) - (dayOfLabel.get(a) || 0));
  for (const label of order) groups.push({ label, tasks: byLabel.get(label)! });
  return groups;
}
