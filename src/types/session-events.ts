/**
 * The events a conversation's tab hears, desktop and phone alike: the Claude
 * Code CLI's stream-json lines (passed on as they are), and the `hyo_*`
 * events the conversation's owner adds so every view of it stays in step
 * (session-owner.ts).
 *
 * The lines come in as parsed JSON, so the session managers take them as
 * `unknown` and let them in through `isSessionEvent`, which checks the one
 * thing every handler branches on: a `type` this file describes. Lines of
 * any other type (rate-limit notices and the like) are ones the handlers
 * never acted on, so they stay out.
 */

import { isRecord } from "./session-json";

/**
 * A tool's input: always a JSON object. The fields named here are the ones
 * Hyo shows (a file's name, a command, a search), strings in every Claude
 * Code tool that has them; anything else is read as `unknown`.
 */
export interface ToolInput {
  [field: string]: unknown;
  file_path?: string;
  pattern?: string;
  command?: string;
  description?: string;
  content?: string;
  /** Skill: the skill being used, as `skill` or `name`. */
  skill?: string;
  name?: string;
}

// ---- What the person sends -------------------------------------------------

/** A file sent inline with a message: an image or a PDF. */
export interface Base64Source {
  type: "base64";
  media_type: string;
  data: string;
}

export type UserContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: Base64Source }
  | { type: "document"; source: Base64Source };

/** A message to Claude: plain text, or blocks when files go with it. */
export type UserContent = string | UserContentBlock[];

// ---- Claude Code's stream-json ---------------------------------------------

/** A sub-agent's events carry these. */
interface SidechainMarks {
  isSidechain?: boolean;
  parent_tool_use_id?: string | null;
}

/** One block of a message: text, thinking, a tool call or a tool's result. */
export interface CliContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: ToolInput;
  tool_use_id?: string;
  content?: unknown;
}

export interface CliUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

/** Background jobs, session start, compaction: `subtype` says which. */
export interface CliSystemEvent {
  type: "system";
  subtype?: string;
  session_id?: string;
}

/** Claude asking for permission (or holding a question) until it's answered. */
export interface CliControlRequest {
  type: "control_request";
  request_id?: string;
  request?: {
    subtype?: string;
    tool_name?: string;
    input?: ToolInput;
    /** The background job asking, when it isn't the chat itself. */
    agent_id?: string;
  };
}

/** The turn's end. A sub-agent's own result is marked as a sidechain. */
export interface CliResultEvent extends SidechainMarks {
  type: "result";
  subtype?: string;
  result?: unknown;
  /** Per model: its context window, among other things. */
  modelUsage?: Record<string, { contextWindow?: number }>;
}

/** A whole message: Claude's reply so far, or tool results coming back. */
export interface CliMessageEvent extends SidechainMarks {
  type: "user" | "assistant";
  message?: {
    role?: string;
    content?: string | CliContentBlock[];
    usage?: CliUsage;
  };
  /** Added by Claude Code for the agent to read (a skill's instructions). */
  isMeta?: boolean;
  isSynthetic?: boolean;
}

/** The part of a streamed delta the session managers read. */
export interface CliStreamInner {
  type: string;
  content_block?: { type: string; id?: string; name?: string };
  delta?: {
    type: string;
    text?: string;
    thinking?: string;
    partial_json?: string;
  };
}

/**
 * A streamed piece of the reply. The delta itself is in `event`; older CLIs
 * put its fields on the line directly, so both are read.
 */
export interface CliStreamEvent extends SidechainMarks, Omit<CliStreamInner, "type"> {
  type: "stream_event";
  event?: CliStreamInner;
}

// ---- What the conversation's owner adds ------------------------------------

/** The model, effort, agent and permission mode the conversation's process runs with. */
export interface HyoSessionInfoEvent {
  type: "hyo_session_info";
  permissionMode?: string;
  effort?: string;
  model?: string;
  agent?: string;
}

/** A turn started, from a message sent on any device (`silent`: a nudge to carry on). */
export interface HyoUserMessageEvent {
  type: "hyo_user_message";
  qid?: string;
  text?: string;
  silent?: boolean;
}

/** A message waiting for the turn under way to finish. */
export interface QueuedInfo {
  qid: string;
  text?: string;
  steerable?: boolean;
  steering?: boolean;
}

export interface HyoQueuedEvent extends QueuedInfo {
  type: "hyo_queued";
}

/** "Send now" was pressed for a waiting message. */
export interface HyoSteeringEvent {
  type: "hyo_steering";
  qid: string;
}

/** Claude took a waiting message in, partway through its reply. */
export interface HyoSteeredEvent {
  type: "hyo_steered";
  qid: string;
  text?: string;
}

/** A permission ask was answered, here or elsewhere. */
export interface HyoPermissionAnsweredEvent {
  type: "hyo_permission_answered";
  requestId: string;
  behavior: string;
}

/** The asks Claude is still waiting on. */
export interface HyoAsksOpenEvent {
  type: "hyo_asks_open";
  ids: string[];
  turnOver?: boolean;
}

/** Waiting messages that won't be sent after all. */
export interface HyoQueueDroppedEvent {
  type: "hyo_queue_dropped";
  qids?: string[];
  reason?: string;
}

/** Catching up on a conversation opened mid-turn. */
export interface HyoReplayEvent {
  type: "hyo_replay";
  turn?: {
    qid?: string;
    text?: string;
    selfStarted?: boolean;
    /** The turn's events so far, handled as if they'd just arrived. */
    events?: unknown[];
  } | null;
  queued?: QueuedInfo[];
  /** Asks still open from before this turn (their control_request events). */
  asks?: unknown[];
}

/** The main chat is already running in another copy of Obsidian. */
export interface HyoOwnerRefusedEvent {
  type: "hyo_owner_refused";
}

export type SessionEvent =
  | CliSystemEvent
  | CliControlRequest
  | CliResultEvent
  | CliMessageEvent
  | CliStreamEvent
  | HyoSessionInfoEvent
  | HyoUserMessageEvent
  | HyoQueuedEvent
  | HyoSteeringEvent
  | HyoSteeredEvent
  | HyoPermissionAnsweredEvent
  | HyoAsksOpenEvent
  | HyoQueueDroppedEvent
  | HyoReplayEvent
  | HyoOwnerRefusedEvent;

const EVENT_TYPES: ReadonlySet<string> = new Set<SessionEvent["type"]>([
  "system",
  "control_request",
  "result",
  "user",
  "assistant",
  "stream_event",
  "hyo_session_info",
  "hyo_user_message",
  "hyo_queued",
  "hyo_steering",
  "hyo_steered",
  "hyo_permission_answered",
  "hyo_asks_open",
  "hyo_queue_dropped",
  "hyo_replay",
  "hyo_owner_refused",
]);

/** The line's `type`, if it has one (for logging lines that aren't let in). */
export function eventType(x: unknown): string {
  return isRecord(x) && typeof x.type === "string" ? x.type : "";
}

/** An event of a type the session managers handle. */
export function isSessionEvent(x: unknown): x is SessionEvent {
  return EVENT_TYPES.has(eventType(x));
}

/** The subtype worth logging next to the type (debug output only). */
export function eventSubtype(e: SessionEvent): string {
  if (e.type === "system" || e.type === "result") return e.subtype || "";
  if (e.type === "control_request") return e.request?.subtype || "";
  return "";
}

/** A message's content blocks (a plain-text message has none to take in). */
export function blocksOf(e: CliMessageEvent): CliContentBlock[] {
  const c = e.message?.content;
  return Array.isArray(c) ? c : [];
}

// ---- Tool inputs the session managers read ---------------------------------

export interface AskQuestion {
  question: string;
  header?: string;
  options?: { label: string; description?: string }[];
  multiSelect?: boolean;
}

function isAskQuestion(x: unknown): x is AskQuestion {
  return isRecord(x) && typeof x.question === "string";
}

/** AskUserQuestion's questions, or null when its input has none (yet). */
export function askedQuestions(input: ToolInput | undefined): AskQuestion[] | null {
  const q = input?.questions;
  return Array.isArray(q) && q.every(isAskQuestion) ? q : null;
}

/** The prompts ExitPlanMode asks to be allowed. */
export function allowedPrompts(input: ToolInput | undefined): { tool: string; prompt: string }[] {
  const a = input?.allowedPrompts;
  if (!Array.isArray(a)) return [];
  return a.filter((p): p is { tool: string; prompt: string } => isRecord(p) && typeof p.tool === "string" && typeof p.prompt === "string");
}

/** The fields of ToolInput that Hyo shows, and so must really be strings. */
const SHOWN_TEXT_FIELDS = ["file_path", "pattern", "command", "description", "content", "skill", "name"] as const;

/**
 * Read a tool's raw input (from a transcript or the stream) as a ToolInput.
 * A field Hyo shows that isn't a string is dropped rather than trusted, so
 * the type's promise holds; every other field is kept as it came.
 */
export function toToolInput(raw: unknown): ToolInput {
  if (!isRecord(raw) || Array.isArray(raw)) return {};
  const input: ToolInput = { ...raw };
  for (const key of SHOWN_TEXT_FIELDS) {
    if (key in input && typeof input[key] !== "string") delete input[key];
  }
  return input;
}

/** A string field of a tool's input, if it's there and not empty. */
export function inputText(input: ToolInput | undefined, key: string): string | undefined {
  const v = input?.[key];
  return typeof v === "string" && v ? v : undefined;
}
