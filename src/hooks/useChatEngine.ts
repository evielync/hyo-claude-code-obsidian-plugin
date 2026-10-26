// The chat's message shapes, shared by the session manager and the message
// components.
import type { VoiceCallRecord } from "../voice/voice-call";

const HIDDEN_TOOLS = new Set([
  "TodoWrite",
  "TaskOutput",
  "EnterPlanMode",
  "ExitPlanMode",
  "AskUserQuestion",
]);

export { HIDDEN_TOOLS };

export interface Message {
  role: "user" | "assistant" | "system";
  content: string;
  displayText?: string; // user's typed text for display (excludes injected file blocks)
  thinking?: string;
  toolCalls?: ToolCallData[];
  orderedBlocks?: OrderedBlock[];
  streaming?: boolean;
  permissionRequests?: PermissionRequestData[];
  askQuestion?: AskQuestionData | null;
  planReview?: PlanReviewData | null;
  isCompaction?: boolean;
  // A reply Claude started itself, with nobody sending anything: a
  // background job finished and it's reporting back.
  selfStarted?: boolean;
  // Waiting for the turn under way to finish (sent here or on another device).
  queuedId?: string;
  // The id this message went to the conversation's owner with (session-owner.ts).
  sendId?: string;
  attachments?: { type: string; name: string; preview?: string }[];
  // Older builds (0.6.x) put each spoken turn in the thread. Kept only so
  // old in-memory messages type-check; calls are `voiceCall` records now.
  voice?: boolean;
  voiceUnsaved?: boolean;
  voiceAt?: string;
  // A user message the voice handed to Claude during a live call. Shown as
  // "Asked on the call" with the request; Claude's reply shows in full.
  handoff?: boolean;
  // One finished voice call, shown as a single "Voice chat · 01:38" line
  // where the call started; tapping it opens the transcript. Not part of
  // Claude's session — Hyo keeps it in session-metadata (`voiceCalls`).
  voiceCall?: VoiceCallRecord;
  // Set until the call is written to session-metadata (needs a session id).
  voiceCallUnsaved?: boolean;
  // Claude refused the model because the installed CLI is too old. Set when
  // the turn ends on that error so the message shows an "Update Claude" card
  // instead of the raw API error. See ClaudeUpdateCard.
  claudeUpdate?: ClaudeUpdateInfo;
  // Claude's login expired, so the turn ended on an auth error. The message
  // shows a "Sign in to Claude" card instead. See ClaudeSignInCard.
  claudeSignIn?: { status: "needed" | "done" };
}

export interface ClaudeUpdateInfo {
  required: string;
  current?: string;
  // needed: card offered. done: updated and the message resent, so the card
  // steps aside. Progress and failures live on the card itself.
  status: "needed" | "done";
}

export interface ToolCallData {
  id: string;
  name: string;
  input: any;
  result: string | null;
  _inputJson?: string;
}

export interface OrderedBlock {
  type: "text" | "thinking" | "tool";
  content?: string;
  toolId?: string;
  turnIndex: number;
  isSkillOutput?: boolean; // suppress text block emitted by Skill tool result
}

export interface PermissionRequestData {
  requestId: string;
  toolName: string;
  input?: any;
  /** The background job asking, by name, when it isn't the chat itself. */
  asker?: string;
  resolved?: "allowed" | "denied";
}

export interface AskQuestionData {
  id: string;
  questions: { question: string; header?: string; options?: { label: string; description?: string }[]; multiSelect?: boolean }[];
  answers: Record<string, string>;
}

export interface PlanReviewData {
  requestId: string;
  planContent: string | null;
  allowedPrompts: { tool: string; prompt: string }[];
  resolved?: "approved" | "rejected";
}
