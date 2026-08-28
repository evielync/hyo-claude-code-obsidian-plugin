/**
 * The engine-neutral surface Hyo's chat UI talks to.
 *
 * Hyo runs on whichever agent engine the vault is set to — Claude Code or
 * Codex — and the UI knows about neither. Each engine ships a transport that
 * drives its own process/protocol and reports back in the `AgentEvent` shape
 * below, so the chat panel, permission prompts and status bar are written once.
 *
 * The events are deliberately Hyo's own vocabulary rather than either vendor's.
 * Reusing Claude Code's `stream-json` as the shared language would have been
 * less work today and would have made every future engine impersonate Claude
 * forever, with Anthropic's schema changes rippling into engines that have
 * nothing to do with them.
 */

/** Streaming output and lifecycle, normalised across engines. */
export type AgentEvent =
  /** The engine is up and this conversation has an id we can resume later. */
  | { type: "session-ready"; sessionId: string; model?: string }
  /** Transient status line ("Compacting…"), shown and discarded. */
  | { type: "status"; text: string }
  /** A chunk of assistant prose. */
  | { type: "text-delta"; text: string; turnId?: string }
  /** A chunk of visible reasoning. */
  | { type: "thinking-delta"; text: string; turnId?: string }
  /** A tool call has begun. `input` is present when the engine sends it upfront. */
  | { type: "tool-start"; id: string; name: string; input?: Record<string, unknown> }
  /** Streamed partial JSON for a tool's arguments, for engines that stream them. */
  | { type: "tool-input-delta"; id: string; partialJson: string }
  /** A tool call finished streaming its arguments. */
  | { type: "tool-end"; id: string }
  /** A tool produced output. */
  | { type: "tool-result"; id: string; content: unknown; isError?: boolean }
  /**
   * The engine is blocked waiting on the user. The turn does not proceed until
   * `respondToPermission` is called with this `requestId`.
   */
  | {
      type: "permission-request";
      requestId: string;
      toolName: string;
      input: Record<string, unknown>;
      /** Engine's own explanation, when it gives one. */
      reason?: string;
    }
  /** The turn finished. */
  | { type: "turn-complete"; usage?: AgentUsage; error?: string }
  /** Plan-window consumption, for the usage meter. */
  | {
      type: "rate-limits";
      /** 0–100 across the shorter window. */
      primaryUsedPercent?: number;
      /** 0–100 across the longer window. */
      secondaryUsedPercent?: number;
      /** Unix seconds when the primary window resets. */
      resetsAt?: number;
      planType?: string;
    }
  /** Engine-level failure. */
  | { type: "error"; message: string };

export interface AgentUsage {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  contextWindow?: number;
  totalTokens?: number;
}

/** How the user answered a permission request. */
export type PermissionBehavior = "allow" | "allow_always" | "deny";

export interface AgentTransportOptions {
  /** Absolute path to the engine's CLI binary. */
  cliPath: string;
  /** Working directory — the vault root. */
  cwd: string;
  model: string;
  effort?: string;
  /** Engine-specific permission/approval mode. */
  permissionMode: string;
  /** Named agent/persona to load, where the engine supports one. */
  agent?: string;
  /** Resume this conversation rather than starting a new one. */
  sessionId?: string;
  resume?: boolean;
  maxOutputTokens?: number;
  /** Extra system-prompt text for this conversation (voice persona, etc.). */
  appendSystemPrompt?: string;
  onEvent: (event: AgentEvent) => void;
  onError: (error: string) => void;
  onClose: (code: number | null) => void;
}

export interface AgentTransport {
  /** Launch the engine and begin streaming events. */
  start(): void;
  /** Send a user turn. Text, or engine-neutral content blocks. */
  sendUserMessage(content: string | unknown[]): void;
  /**
   * Answer a pending `permission-request`. `updatedInput` is only passed when
   * the user actually edited the tool's arguments; otherwise the transport
   * echoes back whatever the engine originally asked about.
   */
  respondToPermission(
    requestId: string,
    behavior: PermissionBehavior,
    toolName?: string,
    updatedInput?: Record<string, unknown>,
  ): void;
  /** Stop the current turn, leaving the conversation alive. */
  interrupt(): void;
  /** Tear the engine down. */
  stop(): void;
  isRunning(): boolean;
}

/** Which engine a vault is running. */
export type EngineId = "claude" | "codex";

export const ENGINE_LABELS: Record<EngineId, string> = {
  claude: "Claude Code",
  codex: "Codex",
};
