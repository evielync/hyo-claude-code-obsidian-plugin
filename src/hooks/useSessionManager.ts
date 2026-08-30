import { debug } from "../debug";
import { useState, useCallback, useRef, useEffect } from "react";
import { ClaudeTransport, normalizeModelId } from "../claude-transport";
import { CodexTransport } from "../codex-transport";
import { resolveModelForEngine, resolveEffortForEngine } from "../models";
import type { AgentEvent, AgentTransport, EngineId } from "../agent-transport";
import { VOICE_PERSONA } from "../voice/voice-persona";
import type {
  Message,
  ToolCallData,
  OrderedBlock,
  AskQuestionData,
  PlanReviewData,
} from "./useChatEngine";
import { HIDDEN_TOOLS } from "./useChatEngine";
import { listCodexSessions, loadCodexSessionHistory } from "../codex-sessions";
import { listPastSessions, loadSessionHistory, saveCustomTitle, setTaskMeta as persistTaskMeta, type PastSession, getProjectDir } from "../session-parser";
import { repairSession, isThinkingBlockApiError, type RepairResult } from "../session-repair";
import { generateConversationTitle } from "../title-generator";
import { Platform } from "obsidian";
// Node built-in; deferred so this module loads on mobile.
const path: typeof import("path") = Platform.isMobile ? (undefined as any) : require("path");

// Re-export for convenience
export type { PastSession };

// A bare greeting opener ("hi chad", "hey", "good morning") carries no topic —
// used to skip it when picking what to title a conversation from, so voice
// chats started with a hello don't end up titled off the hello (or untitled).
function isTrivialOpener(text: string): boolean {
  const s = text.trim().toLowerCase().replace(/[.!,?'"]/g, "");
  if (!s) return true;
  if (s.split(/\s+/).length > 6) return false;
  return /^(hi|hey|hello|hiya|heya|yo|sup|hola|morning|good morning|good afternoon|good evening|hey there)\b/.test(
    s
  );
}

// ------- types -------

interface StreamState {
  toolCalls: ToolCallData[];
  orderedBlocks: OrderedBlock[];
  turnIndex: number;
  toolResultSinceLastText: boolean;
  skillResultPending: boolean; // true after Skill tool_result, until next text block is consumed
}

export interface TabSession {
  id: string;
  cliSessionId: string | null;
  title: string;
  messages: Message[];
  generating: boolean;
  model: string;
  effort: string;
  permissionMode: string;
  agent: string;
  inputTokens: number;
  contextWindow?: number;
  voiceMode: boolean;
  // Task mode: set true when a turn finishes on a tab that isn't the one being
  // viewed, cleared when the task is opened. Makes a background/finished result
  // read as "waiting for you" on the board. See hyo-task-mode-build-spec.
  hasUnseenReply?: boolean;
}

export interface EngineRateLimits {
  primaryUsedPercent?: number;
  primaryWindowMins?: number;
  secondaryUsedPercent?: number;
  secondaryWindowMins?: number;
  resetsAt?: number;
  planType?: string;
  updatedAt?: number;
}

interface SessionState {
  tabs: TabSession[];
  activeTabId: string;
}

interface SessionManagerOptions {
  /** Which agent engine this vault runs. Defaults to Claude Code. */
  engine?: EngineId;
  cliPath: string;
  /** Path to the Codex CLI, used when `engine` is "codex". */
  codexCliPath?: string;
  cwd: string;
  model: string;
  effort: string;
  permissionMode: string;
  defaultAgent: string;
  maxOutputTokens?: number;
  settingsVersion?: number;
  /**
   * Called when the engine changes: hand back the tabs the old engine had open
   * and receive whatever was stored for the new one. Persistence lives with the
   * plugin settings rather than in here.
   */
  onSwitchEngine?: (
    from: EngineId,
    openTabs: { cliSessionId: string; title: string }[],
    to: EngineId,
  ) => { cliSessionId: string; title: string }[];
  autoGenerateTitles?: boolean;
}

// ------- utilities -------

/**
 * Claude Code writes its plan to `.claude/plan.md` and gates on approving it.
 * Codex has a planning mode but no approval request to gate on, so it never
 * calls this — its plans arrive as content in the reply instead.
 */
function readPlanFile(cwd: string): string | null {
  try {
    const fs = require("fs");
    const planPath = path.join(cwd, ".claude", "plan.md");
    if (fs.existsSync(planPath)) {
      return fs.readFileSync(planPath, "utf-8");
    }
    // Also check project root
    const rootPlanPath = path.join(cwd, "plan.md");
    if (fs.existsSync(rootPlanPath)) {
      return fs.readFileSync(rootPlanPath, "utf-8");
    }
  } catch {
    // File system not available or file not found
  }
  return null;
}

function genId(): string {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

function processContentBlocks(contentArr: any[], ss: StreamState, source: "user" | "assistant") {
  for (const block of contentArr) {
    if (block.type === "text") {
      if (ss.toolResultSinceLastText && ss.orderedBlocks.length > 0)
        ss.turnIndex++;
      const existing = ss.orderedBlocks.find(
        (b) => b.type === "text" && b.turnIndex === ss.turnIndex
      );
      if (existing) {
        existing.content = block.text || "";
        // When Claude's assistant event updates a previously suppressed block, unsuppress it
        if (source === "assistant") existing.isSkillOutput = false;
      } else {
        // Text arriving in a user event immediately after a Skill tool_result is a system message — hide it
        const isSkillOutput = source === "user" && ss.skillResultPending;
        ss.skillResultPending = false;
        ss.orderedBlocks.push({
          type: "text",
          content: block.text || "",
          turnIndex: ss.turnIndex,
          isSkillOutput,
        });
      }
      ss.toolResultSinceLastText = false;
    } else if (block.type === "thinking") {
      const existing = ss.orderedBlocks.find(
        (b) => b.type === "thinking" && b.turnIndex === ss.turnIndex
      );
      if (existing) existing.content = block.thinking || "";
      else
        ss.orderedBlocks.push({
          type: "thinking",
          content: block.thinking || "",
          turnIndex: ss.turnIndex,
        });
    } else if (block.type === "tool_use") {
      const tool: ToolCallData = {
        id: block.id,
        name: block.name,
        input: block.input,
        result: null,
      };
      if (!ss.toolCalls.find((t) => t.id === tool.id)) {
        ss.toolCalls.push(tool);
        ss.orderedBlocks.push({
          type: "tool",
          toolId: tool.id,
          turnIndex: ss.turnIndex,
        });
        // Immediately suppress text at this turn if it's a Skill call
        if (tool.name === "Skill") {
          for (const b of ss.orderedBlocks) {
            if (b.type === "text" && b.turnIndex === ss.turnIndex) {
              b.isSkillOutput = true;
            }
          }
        }
      }
    } else if (block.type === "tool_result") {
      const tool = ss.toolCalls.find((t) => t.id === block.tool_use_id);
      if (tool) {
        tool.result =
          typeof block.content === "string"
            ? block.content
            : JSON.stringify(block.content);
        if (tool.name === "Skill") {
          ss.skillResultPending = true;
          // Retroactively suppress text at the same turn as the Skill tool block
          const skillBlock = ss.orderedBlocks.find(
            (b) => b.type === "tool" && b.toolId === tool.id
          );
          if (skillBlock) {
            for (const b of ss.orderedBlocks) {
              if (b.type === "text" && b.turnIndex === skillBlock.turnIndex) {
                b.isSkillOutput = true;
              }
            }
          }
        }
      }
      ss.toolResultSinceLastText = true;
    }
  }
}

function buildSnapshot(ss: StreamState) {
  return {
    content: ss.orderedBlocks
      .filter((b) => b.type === "text")
      .map((b) => b.content)
      .join(""),
    thinking: ss.orderedBlocks
      .filter((b) => b.type === "thinking")
      .map((b) => b.content)
      .join(""),
    toolCalls: [...ss.toolCalls],
    orderedBlocks: [...ss.orderedBlocks.map((b) => ({ ...b }))],
  };
}

// ------- hook -------

export function useSessionManager(options: SessionManagerOptions) {
  const [state, setState] = useState<SessionState>(() => {
    const id = genId();
    return {
      tabs: [
        {
          id,
          cliSessionId: null,
          title: "New conversation",
          messages: [],
          generating: false,
          model: resolveModelForEngine(options.engine || "claude", options.model),
          effort: options.effort,
          permissionMode: options.permissionMode,
          agent: options.defaultAgent,
          inputTokens: 0,
          voiceMode: false,
        },
      ],
      activeTabId: id,
    };
  });

  const [pastSessions, setPastSessions] = useState<PastSession[]>([]);

  const transportsRef = useRef<Record<string, AgentTransport>>({});
  // Plan consumption as the engine itself reports it. Only Codex sends this;
  // Claude's numbers come from Anthropic's usage API instead.
  const [engineRateLimits, setEngineRateLimits] = useState<EngineRateLimits | null>(null);
  const streamStatesRef = useRef<Record<string, StreamState>>({});
  const scrollRef = useRef({ nearBottom: true });
  const stateRef = useRef(state);
  stateRef.current = state;

  // Cleanup transports on unmount
  useEffect(() => {
    return () => {
      for (const id of Object.keys(transportsRef.current)) {
        transportsRef.current[id]?.stop();
      }
    };
  }, []);

  /**
   * Changing engine is changing platform, not swapping a setting underneath the
   * same conversations. A Claude thread cannot be continued by Codex, so open
   * tabs belong to the engine that made them: they are put away, the panel
   * comes back blank, and switching back restores where you were — the way
   * closing one app and reopening another does.
   */
  const previousEngineRef = useRef<EngineId | null>(null);
  useEffect(() => {
    const engine = options.engine || "claude";
    const previous = previousEngineRef.current;
    previousEngineRef.current = engine;
    if (previous === null || previous === engine) return;

    // Stop everything the old engine had running — its processes mean nothing
    // to the new one.
    for (const id of Object.keys(transportsRef.current)) {
      transportsRef.current[id]?.stop();
      delete transportsRef.current[id];
    }
    streamStatesRef.current = {};

    const restored =
      options.onSwitchEngine?.(
        previous,
        stateRef.current.tabs
          .filter((t) => t.cliSessionId)
          .map((t) => ({ cliSessionId: t.cliSessionId as string, title: t.title })),
        engine,
      ) ?? [];

    const blank = {
      generating: false,
      model: resolveModelForEngine(engine, options.model),
      effort: resolveEffortForEngine(engine, options.effort),
      permissionMode: options.permissionMode,
      agent: options.defaultAgent,
      inputTokens: 0,
      voiceMode: false,
    };

    const tabs: TabSession[] = restored.length
      ? restored.map((r) => ({
          id: genId(),
          cliSessionId: r.cliSessionId,
          title: r.title,
          // Restored tabs load their transcript when opened, the same as
          // picking the conversation out of history.
          messages: [],
          ...blank,
        }))
      : [
          {
            id: genId(),
            cliSessionId: null,
            title: "New conversation",
            messages: [],
            ...blank,
          },
        ];

    for (const tab of tabs) {
      streamStatesRef.current[tab.id] = {
        toolCalls: [],
        orderedBlocks: [],
        turnIndex: 0,
        toolResultSinceLastText: false,
        skillResultPending: false,
      };
    }
    setState({ tabs, activeTabId: tabs[0].id });
    debug("[hyo] engine switched", previous, "->", engine, `(${tabs.length} tabs)`);
  }, [options.engine]);

  // ------- internal helpers -------

  const updateTabLastAssistant = useCallback(
    (tabId: string, updater: (msg: Message) => Partial<Message>) => {
      setState((prev) => ({
        ...prev,
        tabs: prev.tabs.map((tab) => {
          if (tab.id !== tabId) return tab;
          const msgs = [...tab.messages];
          for (let i = msgs.length - 1; i >= 0; i--) {
            if (msgs[i].role === "assistant") {
              msgs[i] = { ...msgs[i], ...updater(msgs[i]) };
              break;
            }
          }
          return { ...tab, messages: msgs };
        }),
      }));
    },
    []
  );

  /**
   * Handler for the engine-neutral `AgentEvent` stream (Codex today, further
   * engines after it). Claude Code keeps its own handler below, because that
   * path carries Claude-only behaviour — AskUserQuestion, plan review, skill
   * output suppression — with no counterpart on other engines yet. Both write
   * into the same per-tab `StreamState`, so everything downstream is shared.
   */
  const makeProcessAgentEvent = useCallback(
    (tabId: string) => {
      return (event: AgentEvent) => {
        const ss = streamStatesRef.current[tabId];
        if (!ss) return;

        switch (event.type) {
          case "session-ready":
            setState((prev) => ({
              ...prev,
              tabs: prev.tabs.map((tab) =>
                tab.id === tabId ? { ...tab, cliSessionId: event.sessionId } : tab,
              ),
            }));
            return;

          case "text-delta": {
            if (!event.text) return;
            // A tool ran since the last prose, so this starts a new block
            // rather than continuing the paragraph from before the tool call.
            if (ss.toolResultSinceLastText && ss.orderedBlocks.length > 0) {
              ss.turnIndex++;
            }
            const existing = ss.orderedBlocks.find(
              (b) => b.type === "text" && b.turnIndex === ss.turnIndex,
            );
            if (existing) existing.content = (existing.content || "") + event.text;
            else
              ss.orderedBlocks.push({
                type: "text",
                content: event.text,
                turnIndex: ss.turnIndex,
              });
            ss.toolResultSinceLastText = false;
            updateTabLastAssistant(tabId, () => buildSnapshot(ss));
            return;
          }

          case "thinking-delta": {
            if (!event.text) return;
            const existing = ss.orderedBlocks.find(
              (b) => b.type === "thinking" && b.turnIndex === ss.turnIndex,
            );
            if (existing) existing.content = (existing.content || "") + event.text;
            else
              ss.orderedBlocks.push({
                type: "thinking",
                content: event.text,
                turnIndex: ss.turnIndex,
              });
            updateTabLastAssistant(tabId, () => buildSnapshot(ss));
            return;
          }

          case "tool-start": {
            if (ss.toolCalls.some((t) => t.id === event.id)) return;
            ss.toolCalls.push({
              id: event.id,
              name: event.name,
              input: event.input ?? {},
              result: null,
            });
            if (!HIDDEN_TOOLS.has(event.name)) {
              ss.orderedBlocks.push({
                type: "tool",
                toolId: event.id,
                turnIndex: ss.turnIndex,
              });
            }
            updateTabLastAssistant(tabId, () => buildSnapshot(ss));
            return;
          }

          case "tool-input-delta": {
            const tool = ss.toolCalls.find((t) => t.id === event.id);
            if (!tool) return;
            tool._inputJson = (tool._inputJson || "") + event.partialJson;
            try {
              tool.input = JSON.parse(tool._inputJson);
            } catch {
              // Still partial — wait for the rest.
            }
            updateTabLastAssistant(tabId, () => buildSnapshot(ss));
            return;
          }

          case "tool-result": {
            const tool = ss.toolCalls.find((t) => t.id === event.id);
            if (!tool) return;
            tool.result =
              typeof event.content === "string"
                ? event.content
                : JSON.stringify(event.content ?? "");
            ss.toolResultSinceLastText = true;
            updateTabLastAssistant(tabId, () => buildSnapshot(ss));
            return;
          }

          case "question-request":
            updateTabLastAssistant(tabId, () => ({
              askQuestion: {
                id: event.requestId,
                questions: event.questions.map((q) => ({
                  question: q.question,
                  header: q.header,
                  options: q.options,
                })),
                answers: {},
              },
            }));
            return;

          case "permission-request":
            updateTabLastAssistant(tabId, (msg) => {
              const existing = msg.permissionRequests || [];
              if (existing.some((r) => r.requestId === event.requestId)) return {};
              return {
                permissionRequests: [
                  ...existing,
                  {
                    requestId: event.requestId,
                    toolName: event.toolName,
                    input: event.input,
                  },
                ],
              };
            });
            return;

          case "turn-complete":
            updateTabLastAssistant(tabId, () => ({ streaming: false }));
            setState((prev) => ({
              ...prev,
              tabs: prev.tabs.map((tab) =>
                tab.id === tabId ? { ...tab, generating: false } : tab,
              ),
            }));
            if (event.error) console.error("[hyo] turn failed:", event.error);
            return;

          case "error":
            // Into the conversation, not just the console. A failure the user
            // cannot see reads as the agent ignoring them.
            console.error("[hyo] engine error:", event.message);
            setState((prev) => ({
              ...prev,
              tabs: prev.tabs.map((tab) =>
                tab.id === tabId
                  ? {
                      ...tab,
                      generating: false,
                      messages: [
                        ...tab.messages,
                        {
                          role: "assistant",
                          content: `_${event.message}_`,
                          thinking: "",
                          toolCalls: [],
                          orderedBlocks: [],
                          streaming: false,
                        } as Message,
                      ],
                    }
                  : tab,
              ),
            }));
            updateTabLastAssistant(tabId, () => ({ streaming: false }));
            return;

          case "rate-limits":
            setEngineRateLimits({
              primaryUsedPercent: event.primaryUsedPercent,
              primaryWindowMins: event.primaryWindowMins,
              secondaryUsedPercent: event.secondaryUsedPercent,
              secondaryWindowMins: event.secondaryWindowMins,
              resetsAt: event.resetsAt,
              planType: event.planType,
              updatedAt: Date.now(),
            });
            return;

          case "tool-end":
          case "status":
            return;
        }
      };
    },
    [updateTabLastAssistant],
  );

  const makeProcessEvent = useCallback(
    (tabId: string) => {
      return (event: any) => {
        if (event.type === "stream_event") {
          const evt = event.event || event;
          if (evt.type !== "content_block_delta") {
            debug("[hyo] event:", event.type, evt.type);
          }
        } else {
          debug(
            "[hyo] event:",
            event.type,
            event.subtype || event.request?.subtype || ""
          );
        }

        const ss = streamStatesRef.current[tabId];
        if (!ss) return;

        // System init
        if (event.type === "system" && event.subtype === "init") {
          if (event.session_id) {
            setState((prev) => ({
              ...prev,
              tabs: prev.tabs.map((tab) =>
                tab.id === tabId
                  ? { ...tab, cliSessionId: event.session_id }
                  : tab
              ),
            }));
          }
          return;
        }

        // Auto-compaction marker (compact_boundary fires when the CLI auto-compacts)
        if (event.type === "system" && event.subtype === "compact_boundary") {
          // Only handle as auto-compact if this wasn't triggered by a manual /compact
          // (manual compact already has a streaming isCompaction assistant message)
          const currentTab = stateRef.current.tabs.find((t) => t.id === tabId);
          const alreadyHasCompactionMarker = currentTab?.messages.some(
            (m) => m.isCompaction && m.streaming
          );
          if (!alreadyHasCompactionMarker) {
            // Mark the currently-streaming pre-compact assistant message as complete,
            // add the compacted marker, then add a new streaming assistant message
            // to receive the continuation. Reset the stream state so new content
            // doesn't merge with pre-compact content.
            const markerMsg: Message = {
              role: "assistant",
              content: "compacted",
              isCompaction: true,
              streaming: false,
              toolCalls: [],
              orderedBlocks: [],
            };
            const continuationMsg: Message = {
              role: "assistant",
              content: "",
              thinking: "",
              toolCalls: [],
              orderedBlocks: [],
              streaming: true,
            };
            setState((prev) => ({
              ...prev,
              tabs: prev.tabs.map((tab) => {
                if (tab.id !== tabId) return tab;
                const msgs = [...tab.messages];
                for (let i = msgs.length - 1; i >= 0; i--) {
                  if (msgs[i].role === "assistant" && msgs[i].streaming) {
                    msgs[i] = { ...msgs[i], streaming: false };
                    break;
                  }
                }
                return {
                  ...tab,
                  messages: [...msgs, markerMsg, continuationMsg],
                  generating: true,
                };
              }),
            }));
            streamStatesRef.current[tabId] = {
              toolCalls: [],
              orderedBlocks: [],
              turnIndex: 0,
              toolResultSinceLastText: false,
              skillResultPending: false,
            };
            // Nudge the CLI to resume what it was doing before compaction.
            setTimeout(() => {
              transportsRef.current[tabId]?.sendUserMessage(
                "Please continue where you left off before the compaction."
              );
            }, 100);
          }
          return;
        }

        if (event.type === "system") return;

        // Permission request
        if (event.type === "control_request") {
          const req = event.request || {};
          const toolName = req.tool_name || "";
          const requestId = event.request_id || "";

          // AskUserQuestion — hold the control_request. DON'T respond.
          // The CLI blocks waiting for our control_response.
          // The assistant event handler already set askQuestion with the
          // tool's id. Update it to the requestId so sendQuestionAnswer
          // can send the control_response when the user answers.
          if (toolName === "AskUserQuestion") {
            const input = req.input || {};
            updateTabLastAssistant(tabId, (msg) => ({
              askQuestion: msg.askQuestion
                ? { ...msg.askQuestion, id: requestId }
                : {
                    id: requestId,
                    questions: input.questions || [{ question: input.question }],
                    answers: {},
                  },
            }));
            return;
          }

          // EnterPlanMode — auto-approve silently. No user gate needed.
          if (toolName === "EnterPlanMode") {
            transportsRef.current[tabId]?.respondToPermission(requestId, "allow");
            return;
          }

          // ExitPlanMode — show plan review UI with plan content.
          // Claude is blocked until the user approves or rejects.
          if (toolName === "ExitPlanMode") {
            // Get plan content: first try the Write tool call that created
            // the plan (the content is right there in the input), then fall
            // back to reading from disk.
            let planContent: string | null = null;
            const writeCalls = ss.toolCalls.filter(
              (t) => t.name === "Write" && t.input?.content
            );
            if (writeCalls.length > 0) {
              planContent = writeCalls[writeCalls.length - 1].input.content;
            }
            if (!planContent) {
              planContent = readPlanFile(options.cwd);
            }

            const allowedPrompts = req.input?.allowedPrompts || [];
            updateTabLastAssistant(tabId, () => ({
              planReview: {
                requestId,
                planContent,
                allowedPrompts,
              },
            }));
            return;
          }

          updateTabLastAssistant(tabId, (msg) => {
            const existing = msg.permissionRequests || [];
            // Guard against a re-delivered control_request for the same id.
            if (existing.some((r) => r.requestId === requestId)) {
              return {};
            }
            return {
              permissionRequests: [
                ...existing,
                { requestId, toolName, input: req.input },
              ],
            };
          });
          return;
        }

        // Result — turn complete. Only pick up contextWindow here; inputTokens
        // is tracked from individual assistant events (see below) since result.usage
        // aggregates across multiple API calls within a turn.
        if (event.type === "result") {
          // A sub-agent finishing emits its own `result` — that must NOT end the
          // main turn (which is still running the delegation). Otherwise the
          // main tab flips to "not generating" mid-turn: in voice mode the mic
          // un-suspends and the Blob drops to "Listening" while Chad's still
          // working. Only the main-chain result ends the turn.
          if (event.isSidechain || event.parent_tool_use_id) return;
          updateTabLastAssistant(tabId, () => ({ streaming: false }));
          const mu: any = event.modelUsage || {};
          const firstModel: any = Object.values(mu)[0];
          const contextWindow: number | undefined = firstModel?.contextWindow;
          setState((prev) => ({
            ...prev,
            tabs: prev.tabs.map((tab) =>
              tab.id === tabId
                ? {
                    ...tab,
                    generating: false,
                    ...(contextWindow ? { contextWindow } : {}),
                    // Task mode: a turn that finished on a tab the user isn't
                    // looking at is a result waiting for them.
                    ...(prev.activeTabId !== tabId
                      ? { hasUnseenReply: true }
                      : {}),
                  }
                : tab
            ),
          }));

          // Auto-generate title after first response
          // Claude only. Codex names its own threads and Hyo reads those from
          // its session index, so generating one here would spend the Claude
          // plan while the user is on Codex.
          if (options.autoGenerateTitles && options.engine !== "codex") {
            const currentTab = stateRef.current.tabs.find((t) => t.id === tabId);
            if (currentTab && currentTab.messages.length >= 2) {
              const msgs = currentTab.messages;
              const textOf = (m: Message) =>
                m.displayText ||
                (typeof m.content === "string" ? m.content : "");
              // Title from the first user message with real substance — skip a
              // "hi chad" opener so the title reflects the actual topic. If only
              // a greeting exists so far, wait for the next turn.
              const firstUser =
                msgs.find(
                  (m) =>
                    m.role === "user" &&
                    !m.isCompaction &&
                    !isTrivialOpener(textOf(m))
                ) || undefined;
              const userIdx = firstUser ? msgs.indexOf(firstUser) : -1;
              const firstAssistant =
                userIdx >= 0
                  ? msgs
                      .slice(userIdx + 1)
                      .find((m) => m.role === "assistant" && !m.isCompaction)
                  : undefined;

              if (firstUser && firstAssistant) {
                const userText = textOf(firstUser);
                const truncatedTitle =
                  userText.slice(0, 40) + (userText.length > 40 ? "..." : "");

                // Only generate if title hasn't been manually set
                const needsTitle =
                  currentTab.title === "New conversation" ||
                  currentTab.title === truncatedTitle;

                if (needsTitle && userText) {
                  const titleBeforeGeneration = currentTab.title;
                  const assistantText =
                    typeof firstAssistant.content === "string"
                      ? firstAssistant.content
                      : "";

                  debug("[hyo][title] Generating for tab", tabId);

                  generateConversationTitle({
                    cliPath: options.cliPath,
                    // Claude only — see generateConversationTitle.
                    userMessage: userText,
                    assistantMessage: assistantText,
                  }).then((generatedTitle) => {
                    if (!generatedTitle) {
                      console.warn("[hyo][title] Generation returned null");
                      return;
                    }
                    const tab = stateRef.current.tabs.find((t) => t.id === tabId);
                    if (!tab || tab.title !== titleBeforeGeneration) return;
                    debug("[hyo][title] Renamed:", generatedTitle);
                    renameTab(tabId, generatedTitle);
                  }).catch((err) => {
                    console.error("[hyo][title] Error:", err);
                  });
                }
              }
            }
          }

          return;
        }

        // User event (tool results)
        if (event.type === "user") {
          // A sub-agent's messages stream in as sidechain user events — and the
          // FIRST one is its user message, which is the delegation prompt itself.
          // Without this gate that prompt lands as a text block in the main reply
          // and voice reads the raw instructions aloud. The main chain's own tool
          // results are NOT sidechain, so they still process normally below.
          if (event.isSidechain || event.parent_tool_use_id) return;
          const contentArr = event.message?.content || [];
          processContentBlocks(contentArr, ss, "user");
          updateTabLastAssistant(tabId, () => buildSnapshot(ss));
          return;
        }

        // Assistant message (complete)
        if (event.type === "assistant") {
          // Track context window from each main-chain assistant event's usage.
          // Each assistant API response's usage reflects the context state at that call.
          // Skip sidechain (subagent) events to avoid out-of-order drops/spikes when
          // parallel subagents finish.
          const isSidechain = event.isSidechain || event.parent_tool_use_id;
          const u = event.message?.usage;
          if (u && !isSidechain) {
            const total =
              (u.input_tokens ?? 0) +
              (u.cache_creation_input_tokens ?? 0) +
              (u.cache_read_input_tokens ?? 0);
            if (total > 0) {
              setState((prev) => ({
                ...prev,
                tabs: prev.tabs.map((tab) =>
                  tab.id === tabId ? { ...tab, inputTokens: total } : tab
                ),
              }));
            }
          }
          // A sub-agent's completed messages (its narration and final report)
          // arrive as sidechain assistant events. Do NOT merge them into the
          // main reply — otherwise voice reads the agent's raw output aloud and
          // it clutters the transcript. The Agent tool block + its result still
          // show the work.
          if (!isSidechain) {
            const contentArr = event.message?.content || [];
            processContentBlocks(contentArr, ss, "assistant");
            updateTabLastAssistant(tabId, () => buildSnapshot(ss));
          }

          // Eagerly detect AskUserQuestion from the complete assistant event.
          // The control_request arrives AFTER this, so set the question UI now.
          // The control_request handler will update the id to the requestId.
          const askTool = ss.toolCalls.find(
            (t) => t.name === "AskUserQuestion" && !t.result && t.input?.questions
          );
          if (askTool) {
            updateTabLastAssistant(tabId, () => ({
              askQuestion: {
                id: askTool.id,
                questions: askTool.input.questions,
                answers: {},
              },
            }));
          }
          return;
        }

        // Stream event (incremental deltas)
        if (event.type === "stream_event") {
          const evt = event.event || event;

          if (
            evt.type === "content_block_start" &&
            evt.content_block?.type === "tool_use"
          ) {
            const tool: ToolCallData = {
              id: evt.content_block.id,
              name: evt.content_block.name,
              input: {},
              result: null,
            };
            if (!ss.toolCalls.find((t) => t.id === tool.id)) {
              ss.toolCalls.push(tool);
              ss.orderedBlocks.push({
                type: "tool",
                toolId: tool.id,
                turnIndex: ss.turnIndex,
              });
              if (tool.name === "Skill") {
                for (const b of ss.orderedBlocks) {
                  if (b.type === "text" && b.turnIndex === ss.turnIndex) {
                    b.isSkillOutput = true;
                  }
                }
              }
              updateTabLastAssistant(tabId, () => buildSnapshot(ss));
            }
          }

          if (evt.type === "content_block_stop") {
            const lastBlock = ss.orderedBlocks[ss.orderedBlocks.length - 1];
            if (lastBlock?.type === "tool") {
              ss.toolResultSinceLastText = true;
            }
          }

          if (evt.type === "message_stop" || evt.type === "message_delta") {
            return;
          }

          if (
            evt.type === "content_block_delta" &&
            evt.delta?.type === "input_json_delta"
          ) {
            const lastTool = ss.toolCalls[ss.toolCalls.length - 1];
            if (lastTool) {
              if (!lastTool._inputJson) lastTool._inputJson = "";
              lastTool._inputJson += evt.delta.partial_json || "";
              try {
                lastTool.input = JSON.parse(lastTool._inputJson);
              } catch {
                // partial
              }
            }
          }

          if (evt.type === "content_block_delta") {
            const delta = evt.delta;

            // A sub-agent's own narration and final report stream through here as
            // sidechain text. Keep it OUT of the main reply — otherwise voice
            // mode reads the agent's raw output aloud (and it clutters the
            // transcript). The agent's tool calls still render.
            const isSidechain =
              event.isSidechain || event.parent_tool_use_id;

            if (delta?.type === "text_delta" && delta.text && !isSidechain) {
              if (ss.toolResultSinceLastText && ss.orderedBlocks.length > 0)
                ss.turnIndex++;
              const existing = ss.orderedBlocks.find(
                (b) => b.type === "text" && b.turnIndex === ss.turnIndex
              );
              if (existing) {
                existing.content = (existing.content || "") + delta.text;
              } else {
                ss.orderedBlocks.push({
                  type: "text",
                  content: delta.text,
                  turnIndex: ss.turnIndex,
                });
              }
              ss.toolResultSinceLastText = false;
              updateTabLastAssistant(tabId, () => buildSnapshot(ss));
            } else if (delta?.type === "thinking_delta" && delta.thinking) {
              const existing = ss.orderedBlocks.find(
                (b) => b.type === "thinking" && b.turnIndex === ss.turnIndex
              );
              if (existing) {
                existing.content = (existing.content || "") + delta.thinking;
              } else {
                ss.orderedBlocks.push({
                  type: "thinking",
                  content: delta.thinking,
                  turnIndex: ss.turnIndex,
                });
              }
              updateTabLastAssistant(tabId, () => buildSnapshot(ss));
            }
          }
          return;
        }
      };
    },
    [updateTabLastAssistant]
  );

  // ------- tab management -------

  const newTab = useCallback(() => {
    const id = genId();
    setState((prev) => {
      const activeTab = prev.tabs.find((t) => t.id === prev.activeTabId);
      return {
        tabs: [
          ...prev.tabs,
          {
            id,
            cliSessionId: null,
            title: "New conversation",
            messages: [],
            generating: false,
            model: resolveModelForEngine(
              options.engine || "claude",
              activeTab?.model || options.model,
            ),
            effort: resolveEffortForEngine(
              options.engine || "claude",
              activeTab?.effort || options.effort,
            ),
            permissionMode: activeTab?.permissionMode || options.permissionMode,
            agent: options.defaultAgent,
            voiceMode: false,
          },
        ],
        activeTabId: id,
      };
    });
  }, [options.model, options.effort, options.permissionMode]);

  const closeTab = useCallback((tabIdToClose: string) => {
    transportsRef.current[tabIdToClose]?.stop();
    delete transportsRef.current[tabIdToClose];
    delete streamStatesRef.current[tabIdToClose];

    setState((prev) => {
      const remaining = prev.tabs.filter((t) => t.id !== tabIdToClose);

      if (remaining.length === 0) {
        const newId = genId();
        return {
          tabs: [
            {
              id: newId,
              cliSessionId: null,
              title: "New conversation",
              messages: [],
              generating: false,
              model: resolveModelForEngine(options.engine || "claude", options.model),
              effort: options.effort,
              permissionMode: options.permissionMode,
              agent: options.defaultAgent,
              voiceMode: false,
            },
          ],
          activeTabId: newId,
        };
      }

      let activeTabId = prev.activeTabId;
      if (prev.activeTabId === tabIdToClose) {
        const idx = prev.tabs.findIndex((t) => t.id === tabIdToClose);
        const newIdx = Math.min(idx, remaining.length - 1);
        activeTabId = remaining[newIdx].id;
      }

      return { tabs: remaining, activeTabId };
    });
  }, []);

  const switchTab = useCallback((id: string) => {
    setState((prev) => ({
      ...prev,
      activeTabId: id,
      // Opening a task clears its "unseen reply" flag — you've now seen it.
      tabs: prev.tabs.map((t) =>
        t.id === id && t.hasUnseenReply ? { ...t, hasUnseenReply: false } : t
      ),
    }));
    scrollRef.current.nearBottom = true;
  }, []);

  const renameTab = useCallback((id: string, title: string) => {
    setState((prev) => {
      const tab = prev.tabs.find((t) => t.id === id);

      // If this tab has a persisted session, save the custom title and refresh dropdown
      if (tab?.cliSessionId) {
        saveCustomTitle(options.cwd, tab.cliSessionId, title);
        // Refresh past sessions to update dropdown
        setTimeout(() => refreshPastSessions(), 0);
      }

      return {
        ...prev,
        tabs: prev.tabs.map((t) =>
          t.id === id ? { ...t, title } : t
        ),
      };
    });
  }, [options.cwd, options.engine]); // refreshPastSessions intentionally omitted — declared later, referenced via closure

  // Rename a conversation that isn't open as a tab (from the task list). Writes
  // the custom title to the on-disk metadata and refreshes the list. If it does
  // happen to be open, update the tab's title too so they stay in sync.
  const renamePastSession = useCallback((sessionId: string, title: string) => {
    saveCustomTitle(options.cwd, sessionId, title);
    setState((prev) => ({
      ...prev,
      tabs: prev.tabs.map((t) =>
        t.cliSessionId === sessionId ? { ...t, title } : t
      ),
    }));
    setTimeout(() => refreshPastSessions(), 0);
  }, [options.cwd, options.engine]);

  // Persist task state (pinned / closed) to the shared session metadata, then
  // refresh so the list reflects it. Keyed by cliSessionId — a brand-new tab
  // with no session yet can't be pinned/closed (nothing to persist to).
  const setTaskMeta = useCallback(
    (sessionId: string, patch: { pinned?: boolean; closed?: boolean; lastActive?: string }) => {
      persistTaskMeta(options.cwd, sessionId, patch);
      setTimeout(() => refreshPastSessions(), 0);
    },
    [options.cwd]
  );

  // Move a tab to sit where another tab currently is. Dropping onto the right
  // half of the target lands after it, which is what makes dragging a tab to
  // the end of the bar feel natural.
  const reorderTab = useCallback((draggedId: string, targetId: string, after: boolean) => {
    if (draggedId === targetId) return;
    setState((prev) => {
      const from = prev.tabs.findIndex((t) => t.id === draggedId);
      const target = prev.tabs.findIndex((t) => t.id === targetId);
      if (from === -1 || target === -1) return prev;

      const tabs = [...prev.tabs];
      const [moved] = tabs.splice(from, 1);
      const targetAfterRemoval = tabs.findIndex((t) => t.id === targetId);
      const insertAt = after ? targetAfterRemoval + 1 : targetAfterRemoval;
      tabs.splice(insertAt, 0, moved);

      return { ...prev, tabs };
    });
  }, []);

  // ------- messaging -------

  const sendMessage = useCallback(
    (content: string | any[], meta?: { displayText?: string; attachedFileNames?: string[]; isCompaction?: boolean }) => {
      const tabId = stateRef.current.activeTabId;

      // For display, use the typed text; for arrays (image messages) use displayText or placeholder
      const displayContent = typeof content === "string"
        ? (meta?.displayText ?? content)
        : (meta?.displayText ?? "");

      const userMsg: Message = {
        role: "user",
        content: displayContent,
        displayText: meta?.displayText,
        attachments: meta?.attachedFileNames?.map((name) => ({ type: "file", name })),
        isCompaction: meta?.isCompaction,
      };
      const assistantMsg: Message = {
        role: "assistant",
        content: "",
        thinking: "",
        toolCalls: [],
        orderedBlocks: [],
        streaming: true,
        isCompaction: meta?.isCompaction,
      };

      streamStatesRef.current[tabId] = {
        toolCalls: [],
        orderedBlocks: [],
        turnIndex: 0,
        toolResultSinceLastText: false,
        skillResultPending: false,
      };

      setState((prev) => ({
        ...prev,
        tabs: prev.tabs.map((tab) => {
          if (tab.id !== tabId) return tab;
          const titleText = meta?.displayText ?? (typeof content === "string" ? content : "");
          const title =
            tab.messages.length === 0 && tab.title === "New conversation"
              ? titleText.slice(0, 40) + (titleText.length > 40 ? "..." : "")
              : tab.title;
          // Compaction: don't add a user message — just the streaming assistant marker
          const newMessages = meta?.isCompaction
            ? [...tab.messages, assistantMsg]
            : [...tab.messages, userMsg, assistantMsg];
          return {
            ...tab,
            title,
            messages: newMessages,
            generating: true,
          };
        }),
      }));
      scrollRef.current.nearBottom = true;

      if (
        !transportsRef.current[tabId] ||
        !transportsRef.current[tabId].isRunning()
      ) {
        const currentTab = stateRef.current.tabs.find(
          (t) => t.id === tabId
        );
        const cliSessionId = currentTab?.cliSessionId;

        const shared = {
          cwd: options.cwd,
          model: resolveModelForEngine(options.engine || "claude", currentTab?.model || options.model),
          effort: resolveEffortForEngine(options.engine || "claude", currentTab?.effort || options.effort),
          permissionMode: currentTab?.permissionMode || options.permissionMode,
          // Agents are Claude Code's; Codex has no equivalent and is not given
          // an emulated one, so the selection simply doesn't apply there.
          agent: options.engine === "codex" ? "" : currentTab?.agent || "",
          sessionId: cliSessionId || undefined,
          resume: !!cliSessionId,
          maxOutputTokens: options.maxOutputTokens,
          // Voice conversation mode: append the voice persona so Chad speaks for
          // listening. toggleVoiceMode kills the transport, so the next spawn
          // (here) picks up or drops the persona and --resumes the same session.
          appendSystemPrompt: currentTab?.voiceMode ? VOICE_PERSONA : undefined,
        };

        const engineName = options.engine === "codex" ? "Codex" : "Claude";
        const onClose = (code: number | null) => {
          const wasGenerating = stateRef.current.tabs.find(
            (t) => t.id === tabId
          )?.generating;
          setState((prev) => ({
            ...prev,
            tabs: prev.tabs.map((tab) =>
              tab.id === tabId ? { ...tab, generating: false } : tab
            ),
          }));
          updateTabLastAssistant(tabId, () => ({ streaming: false }));
          // If the process exited with an error mid-turn, say so in the chat —
          // otherwise the reply just stops and looks like the agent ignored you.
          if (code !== 0 && code !== null && wasGenerating) {
            const errorMsg: Message = {
              role: "assistant",
              content: `_${engineName} process exited unexpectedly (code ${code}). Start a new conversation to continue._`,
              thinking: "",
              toolCalls: [],
              orderedBlocks: [],
              streaming: false,
            };
            setState((prev) => ({
              ...prev,
              tabs: prev.tabs.map((tab) =>
                tab.id === tabId
                  ? { ...tab, messages: [...tab.messages, errorMsg] }
                  : tab
              ),
            }));
          }
          delete transportsRef.current[tabId];
        };

        const transport: AgentTransport =
          options.engine === "codex"
            ? new CodexTransport({
                ...shared,
                cliPath: options.codexCliPath || options.cliPath,
                onEvent: makeProcessAgentEvent(tabId),
                onError: (error) => console.error("[hyo] Codex error:", error),
                onClose,
              })
            : new ClaudeTransport({
                ...shared,
                cliPath: options.cliPath,
                onMessage: makeProcessEvent(tabId),
                onError: (error) => console.error("[hyo] CLI error:", error),
                onClose,
              });

        transport.start();
        transportsRef.current[tabId] = transport;
      }

      transportsRef.current[tabId].sendUserMessage(content);
    },
    [options, makeProcessEvent, updateTabLastAssistant]
  );

  const sendPermissionResponse = useCallback(
    (requestId: string, behavior: "allow" | "allow_always" | "deny") => {
      const tabId = stateRef.current.activeTabId;
      // Look up the toolName from the pending permission request so the
      // transport can build the correct updatedPermissions for "always allow".
      const tab = stateRef.current.tabs.find((t) => t.id === tabId);
      const lastMsg = tab?.messages[tab.messages.length - 1];
      const toolName = lastMsg?.permissionRequests?.find(
        (r) => r.requestId === requestId
      )?.toolName;
      transportsRef.current[tabId]?.respondToPermission(requestId, behavior, toolName);
      updateTabLastAssistant(tabId, (msg) => {
        const updates: Partial<Message> = {};
        if (msg.permissionRequests?.some((r) => r.requestId === requestId)) {
          updates.permissionRequests = msg.permissionRequests.map((r) =>
            r.requestId === requestId
              ? {
                  ...r,
                  resolved: behavior === "deny" ? ("denied" as const) : ("allowed" as const),
                }
              : r
          );
        }
        // Also resolve planReview if this requestId matches
        if (msg.planReview && msg.planReview.requestId === requestId) {
          updates.planReview = {
            ...msg.planReview,
            resolved: behavior === "deny" ? ("rejected" as const) : ("approved" as const),
          };
        }
        return updates;
      });
    },
    [updateTabLastAssistant]
  );

  const sendQuestionAnswer = useCallback(
    (questionId: string, answers: Record<string, string>) => {
      const tabId = stateRef.current.activeTabId;

      // Codex has its own answer channel keyed by question id, rather than
      // Claude's "reply to the tool call with an updated input".
      const transport = transportsRef.current[tabId];
      if (options.engine === "codex") {
        transport?.respondToQuestion?.(questionId, answers);
        updateTabLastAssistant(tabId, () => ({ askQuestion: null }));
        return;
      }

      // AskUserQuestion's input schema requires "questions" — updatedInput
      // must satisfy the tool's original input schema, not just carry the
      // answers. Echo back the questions we already have from the tab's
      // askQuestion state alongside the answers.
      const tab = stateRef.current.tabs.find((t) => t.id === tabId);
      const lastAssistant = [...(tab?.messages || [])]
        .reverse()
        .find((m) => m.role === "assistant");
      const questions = lastAssistant?.askQuestion?.questions || [];

      // Send control_response with questions + answers as updatedInput.
      // The CLI was blocked on the control_request — this unblocks it.
      // Claude receives the answers and continues within the same turn.
      transportsRef.current[tabId]?.respondToPermission(
        questionId,
        "allow",
        undefined,
        { questions, answers }
      );

      // Clear the question UI. The assistant message stays streaming —
      // Claude will continue and the result event will finalize it.
      updateTabLastAssistant(tabId, () => ({ askQuestion: null }));
    },
    [updateTabLastAssistant]
  );

  const stopGeneration = useCallback(() => {
    const tabId = stateRef.current.activeTabId;
    transportsRef.current[tabId]?.interrupt();
    setState((prev) => ({
      ...prev,
      tabs: prev.tabs.map((tab) =>
        tab.id === tabId ? { ...tab, generating: false } : tab
      ),
    }));
    updateTabLastAssistant(tabId, () => ({ streaming: false }));
  }, [updateTabLastAssistant]);

  const setTabModel = useCallback((model: string) => {
    const normalized = normalizeModelId(model);
    setState((prev) => ({
      ...prev,
      tabs: prev.tabs.map((tab) =>
        tab.id === prev.activeTabId ? { ...tab, model: normalized } : tab
      ),
    }));
  }, []);

  const setTabEffort = useCallback((effort: string) => {
    setState((prev) => ({
      ...prev,
      tabs: prev.tabs.map((tab) =>
        tab.id === prev.activeTabId ? { ...tab, effort } : tab
      ),
    }));
  }, []);

  const setTabPermissionMode = useCallback((permissionMode: string) => {
    setState((prev) => ({
      ...prev,
      tabs: prev.tabs.map((tab) =>
        tab.id === prev.activeTabId ? { ...tab, permissionMode } : tab
      ),
    }));
  }, []);

  const toggleVoiceMode = useCallback(() => {
    // Entering/leaving voice mode changes the system prompt (the voice persona
    // is passed via --append-system-prompt at spawn). Kill the current
    // transport so the next sendMessage respawns with the persona attached or
    // dropped; --resume against the tab's cliSessionId keeps the conversation.
    setState((prev) => {
      const tabId = prev.activeTabId;
      transportsRef.current[tabId]?.stop();
      delete transportsRef.current[tabId];
      return {
        ...prev,
        tabs: prev.tabs.map((tab) =>
          tab.id === tabId ? { ...tab, voiceMode: !tab.voiceMode } : tab
        ),
      };
    });
  }, []);

  const setTabAgent = useCallback((agent: string) => {
    // Switching agents requires a fresh CLI process — kill the current transport.
    // Next sendMessage will respawn with the new --agent flag.
    setState((prev) => {
      const tabId = prev.activeTabId;
      transportsRef.current[tabId]?.stop();
      delete transportsRef.current[tabId];
      delete streamStatesRef.current[tabId];
      return {
        ...prev,
        tabs: prev.tabs.map((tab) =>
          tab.id === tabId ? { ...tab, agent, cliSessionId: null } : tab
        ),
      };
    });
  }, []);

  // ------- past sessions -------

  const refreshPastSessions = useCallback(() => {
    try {
      // Each engine serves its own history. Switching engine is switching
      // platforms, so Claude's conversations never appear under Codex or the
      // other way round.
      const sessions =
        options.engine === "codex"
          ? listCodexSessions(options.cwd)
          : listPastSessions(options.cwd);
      setPastSessions(sessions);
    } catch (e) {
      console.error("[hyo] Failed to list past sessions:", e);
    }
  }, [options.cwd, options.engine]);

  useEffect(() => {
    refreshPastSessions();
  }, [refreshPastSessions]);

  const openPastSession = useCallback((pastSession: PastSession) => {
    const existing = stateRef.current.tabs.find(
      (t) => t.cliSessionId === pastSession.id
    );
    if (existing) {
      setState((prev) => ({ ...prev, activeTabId: existing.id }));
      return;
    }

    // Load conversation history from JSONL
    const history =
      options.engine === "codex"
        ? loadCodexSessionHistory(pastSession.id)
        : loadSessionHistory(options.cwd, pastSession.id);
    const messages: Message[] = history.map((m) => ({
      role: m.role,
      content: m.content,
      thinking: m.thinking || "",
      toolCalls: m.toolCalls || [],
      orderedBlocks: m.orderedBlocks || [],
      streaming: false,
    }));

    const id = genId();
    setState((prev) => {
      const activeTab = prev.tabs.find((t) => t.id === prev.activeTabId);
      return {
        tabs: [
          ...prev.tabs,
          {
            id,
            cliSessionId: pastSession.id,
            title: pastSession.title,
            messages,
            generating: false,
            model: resolveModelForEngine(
              options.engine || "claude",
              activeTab?.model || options.model,
            ),
            effort: resolveEffortForEngine(
              options.engine || "claude",
              activeTab?.effort || options.effort,
            ),
            permissionMode: activeTab?.permissionMode || options.permissionMode,
            agent: options.defaultAgent,
            voiceMode: false,
          },
        ],
        activeTabId: id,
      };
    });
  }, [options.cwd, options.engine, options.model, options.effort, options.permissionMode, options.defaultAgent]);

  // ---- Reopen the tabs from last time ---------------------------------------
  // Closing Obsidian used to take every open Hyo tab with it. Remember which
  // conversations are open and restore them on mount. Deliberately
  // device-local (localStorage, keyed by vault) rather than synced settings:
  // the desktop restores the desktop's desk, the phone restores the phone's.
  const restoreKey = `hyo-open-tabs:${options.cwd}`;
  const restoredRef = useRef(false);

  useEffect(() => {
    if (restoredRef.current) return;
    restoredRef.current = true;
    let saved: { sessions: { id: string; title: string }[]; activeId?: string | null } | null = null;
    try {
      saved = JSON.parse(window.localStorage.getItem(restoreKey) || "null");
    } catch {
      /* absent or corrupt — start fresh */
    }
    if (!saved?.sessions?.length) return;
    for (const s of saved.sessions) {
      if (s?.id) openPastSession({ id: s.id, title: s.title || "Untitled" } as PastSession);
    }
    const activeId = saved.activeId;
    setState((prev) => {
      const restored = prev.tabs.filter((t) => t.cliSessionId);
      if (restored.length === 0) return prev;
      // The pristine starter tab makes way for the restored desk.
      const tabs = prev.tabs.filter((t) => t.cliSessionId || t.messages.length > 0);
      const active = activeId ? tabs.find((t) => t.cliSessionId === activeId) : null;
      return { tabs, activeTabId: active?.id || tabs[tabs.length - 1].id };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openPastSession]);

  useEffect(() => {
    if (!restoredRef.current) return; // never clobber the stored desk before restore reads it
    try {
      const sessions = state.tabs
        .filter((t) => t.cliSessionId)
        .map((t) => ({ id: t.cliSessionId as string, title: t.title }));
      const active = state.tabs.find((t) => t.id === state.activeTabId);
      window.localStorage.setItem(
        restoreKey,
        JSON.stringify({ sessions, activeId: active?.cliSessionId || null }),
      );
    } catch {
      /* storage unavailable — restore just won't happen */
    }
  }, [state.tabs, state.activeTabId, restoreKey]);

  const compact = useCallback(() => {
    // "/compact" is a Claude Code slash command. Sending that text to another
    // engine is just a message about compacting, so engines with a real call
    // for it are asked directly.
    const transport = transportsRef.current[stateRef.current.activeTabId];
    if (transport?.compact?.()) return;
    sendMessage("/compact", { isCompaction: true });
  }, [sendMessage]);

  // Recover a session that's been poisoned by an orphaned `thinking` block
  // (the result of an output-cap mid-stream truncation). Reads the .jsonl,
  // surgically removes the orphan + cap-error + failed retries, repairs
  // parent UUIDs, kills the broken transport so the next send re-spawns
  // with `--resume` against the cleaned file. Returns the user's last
  // attempted message text so the UI can prefill the input.
  const recoverSession = useCallback(
    (tabId: string): RepairResult => {
      const tab = stateRef.current.tabs.find((t) => t.id === tabId);
      if (!tab?.cliSessionId) {
        return {
          success: false,
          linesRemoved: 0,
          capturedUserText: null,
          reason: "No session ID for this tab",
        };
      }

      const projectDir = getProjectDir(options.cwd);
      const jsonlPath = path.join(projectDir, `${tab.cliSessionId}.jsonl`);
      const result = repairSession(jsonlPath);
      if (!result.success) return result;

      // Kill the existing transport so the next sendMessage spawns a fresh
      // process that --resumes against the cleaned file.
      const existing = transportsRef.current[tabId];
      if (existing) {
        try {
          existing.stop();
        } catch {}
        delete transportsRef.current[tabId];
      }

      // Strip the corrupt trailing messages from the in-memory state so the
      // chat UI matches the file. Walk back from the end, removing assistant
      // API errors and the user retries that triggered them, plus any
      // orphaned-cap residue.
      setState((prev) => ({
        ...prev,
        tabs: prev.tabs.map((t) => {
          if (t.id !== tabId) return t;
          const msgs = [...t.messages];
          while (msgs.length > 0) {
            const last = msgs[msgs.length - 1];
            const text = (last.content || "").trim();
            const isApiError =
              last.role === "assistant" &&
              (text.startsWith("API Error") ||
                isThinkingBlockApiError(text));
            const isFailedUserRetry =
              last.role === "user" &&
              msgs.length >= 2 &&
              ((msgs[msgs.length - 2].content || "").startsWith("API Error") ||
                isThinkingBlockApiError(msgs[msgs.length - 2].content || ""));
            if (isApiError || isFailedUserRetry) {
              msgs.pop();
            } else {
              break;
            }
          }
          return { ...t, messages: msgs, generating: false };
        }),
      }));

      return result;
    },
    [options.cwd]
  );

  // ------- return -------

  const activeTab = state.tabs.find((t) => t.id === state.activeTabId);

  return {
    engineRateLimits,
    tabs: state.tabs,
    activeTabId: state.activeTabId,
    activeMessages: activeTab?.messages || [],
    activeGenerating: activeTab?.generating || false,
    activeModel: activeTab?.model || options.model,
    activeEffort: activeTab?.effort || options.effort,
    activePermissionMode: activeTab?.permissionMode || options.permissionMode,
    activeAgent: activeTab?.agent || "",
    activeVoiceMode: activeTab?.voiceMode || false,
    activeTabHasSession: !!activeTab?.cliSessionId,
    activeInputTokens: activeTab?.inputTokens || 0,
    activeContextWindow: activeTab?.contextWindow,
    newTab,
    closeTab,
    switchTab,
    renameTab,
    renamePastSession,
    setTaskMeta,
    reorderTab,
    setTabModel,
    setTabEffort,
    setTabPermissionMode,
    setTabAgent,
    toggleVoiceMode,
    sendMessage,
    sendPermissionResponse,
    sendQuestionAnswer,
    stopGeneration,
    compact,
    recoverSession,
    pastSessions,
    openPastSession,
    refreshPastSessions,
    scrollRef,
  };
}
