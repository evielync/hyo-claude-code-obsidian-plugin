// The chat's message shapes, shared by the session manager and the message
// components.
import type { VoiceCallRecord } from "../../voice/voice-call";

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
  // An error Hyo itself put in the chat (the process ended, Claude couldn't
  // start). Claude never sees these; during a call they're passed on.
  hyoError?: boolean;
  // Waiting for the turn under way to finish (sent here or on another device).
  queuedId?: string;
  // Waiting, and it can go into the reply under way: "Send now" is offered.
  steerable?: boolean;
  // "Send now" was pressed: on its way, Claude takes it in at the reply's next step.
  steering?: boolean;
  // The id this message went to the conversation's owner with (session-owner.ts).
  sendId?: string;
  attachments?: { type: string; name: string; preview?: string }[];
  // Said on a GPT-Live call and handled by the voice itself — shown in the
  // thread, never part of Claude's session.
  voice?: boolean;
  voiceUnsaved?: boolean;
  voiceAt?: string;
  // A user message the voice handed to Claude during a live call.
  handoff?: boolean;
  // One finished voice call, shown as a single "Voice chat · 01:38" line
  // where the call started; tapping it opens the transcript. Not part of
  // Claude's session — Hyo keeps it in session-metadata (`voiceCalls`).
  voiceCall?: VoiceCallRecord;
  // Set until the call is written to session-metadata (needs a session id).
  voiceCallUnsaved?: boolean;
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
  /** That job's id (the request's agent_id): its asks go when it ends. */
  jobId?: string;
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
