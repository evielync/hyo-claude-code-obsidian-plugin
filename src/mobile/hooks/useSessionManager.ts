import { debug } from "../debug";
import { addOutgoing, startQueued } from "../../send-queue";
import { newStreamState, processContentBlocks, buildSnapshot, endTurn, startsTurnOfItsOwn, openReply, isInjectedContext, type StreamState } from "../../reply-stream";
import { useState, useCallback, useRef, useEffect } from "react";
import { GatewayTransport } from "../gateway-transport";
import { VOICE_PERSONA } from "../voice/voice-persona";
import type {
  Message,
  ToolCallData,
  OrderedBlock,
  AskQuestionData,
  PlanReviewData,
} from "./useChatEngine";
import { listPastSessions, loadSessionHistory, saveCustomTitle, setTaskMeta as persistTaskMeta, saveVoiceCall, type PastSession } from "../session-parser";
import { LIVE_BACKEND_PERSONA } from "../../voice/voice-persona";
import { handoffRequestText, HANDOFF_MARKER, threadCalls, insertCallLine, sessionSpawn, callHome, type VoiceCallRecord } from "../../voice/voice-call";
import { repairSession, isThinkingBlockApiError, type RepairResult } from "../session-repair";
import { generateConversationTitle } from "../title-generator";
import { parseClaudeUpdateError } from "../../models";
import { applyJobEvent, hasRunningJobs, jobAsking, jobList, maySwapProcess, IdleGate, type JobMap, type BackgroundJob } from "../../background-jobs";
import { appendedPrompt, withMainChatReminder, withMainChat, mainFirst, canCloseTab, canReorder, startupActive, MAIN_CHAT_TITLE } from "../../main-chat";

// Re-export for convenience
export type { PastSession };

// Locked scope: mobile Hyo always talks to Chad on Sonnet 5.5, asking before
// it acts. The gateway enforces all three server-side regardless of what's
// sent — these are just the values shown in the UI.
const LOCKED_MODEL = "claude-sonnet-5-5";
const LOCKED_AGENT = ""; // empty = the CLI default agent
// Display value only — matches PERMISSION_MODES' "manual" ("Ask First"),
// which reflects the gateway's actual hardcoded behaviour.
const LOCKED_PERMISSION_MODE = "manual";

// ------- types -------

export interface TabSession {
  id: string;
  cliSessionId: string | null;
  // The id was chosen by Hyo when a call ended in a tab Claude hadn't been
  // used in yet. No transcript exists, so Claude starts it with --session-id.
  sessionPending?: boolean;
  title: string;
  messages: Message[];
  generating: boolean;
  model: string;
  permissionMode: string;
  agent: string;
  inputTokens: number;
  contextWindow?: number;
  voiceMode: boolean;
  // Task mode: set when a turn finishes on a tab you aren't viewing, cleared
  // when you open it. Makes a finished result read as "waiting on you".
  hasUnseenReply?: boolean;
  // The main chat: pinned first, can't be closed (see main-chat.ts).
  isMain?: boolean;
  // Background agents running in this tab's Claude process, by task id.
  jobs?: JobMap;
}

interface SessionState {
  tabs: TabSession[];
  activeTabId: string;
}

interface SessionManagerOptions {
  gatewayUrl: string;
  model?: string;
  agent?: string;
  settingsVersion?: number;
  autoGenerateTitles?: boolean;
  // Live value of the "Ask First" toggle (plugin settings). Read fresh on
  // every sendMessage call and sent with each prompt — see gateway-client's
  // sendPrompt.
  askFirst?: boolean;
  // Settings → Main chat, and the conversation it carries on (synced from
  // the desktop's settings, so it's the same conversation on both).
  mainChat?: boolean;
  mainChatSessionId?: string;
  onMainChatSession?: (sessionId: string) => void;
}

// ------- utilities -------

// Desktop read a locally-written plan.md off disk here. There's no fs on
// mobile — the ExitPlanMode handler below gets plan content from the Write
// tool call that created it instead, so this always reports null.
function readPlanFile(_cwd?: string): string | null {
  return null;
}

function genId(): string {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
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
          model: LOCKED_MODEL,
          permissionMode: LOCKED_PERMISSION_MODE,
          agent: LOCKED_AGENT,
          inputTokens: 0,
          voiceMode: false,
        },
      ],
      activeTabId: id,
    };
  });

  const [pastSessions, setPastSessions] = useState<PastSession[]>([]);

  const transportsRef = useRef<Record<string, GatewayTransport>>({});
  // Each tab's background jobs, in step with tab.jobs for the guards below.
  const jobsRef = useRef<Record<string, JobMap>>({});
  const jobsRunning = (tabId: string) => hasRunningJobs(jobsRef.current[tabId]);
  // Work that has to restart a tab's process waits for its background jobs.
  const gatesRef = useRef<Record<string, IdleGate>>({});
  const gate = (tabId: string) => (gatesRef.current[tabId] ||= new IdleGate());
  const whenIdle = (tabId: string, fn: () => void) => {
    const g = gate(tabId);
    g.update(jobsRef.current[tabId]);
    g.whenIdle(fn);
  };
  const setJobs = (tabId: string, jobs: JobMap) => {
    jobsRef.current[tabId] = jobs;
    setState((prev) => ({
      ...prev,
      tabs: prev.tabs.map((t) => (t.id === tabId ? { ...t, jobs } : t)),
    }));
    setTimeout(() => gate(tabId).update(jobsRef.current[tabId]), 0);
  };
  // An auto-compaction that ended the turn without carrying on (older CLIs).
  const compactNudgeRef = useRef<Record<string, boolean>>({});
  const optionsRef = useRef(options);
  optionsRef.current = options;
  // Messages sent while Claude is still answering, per tab, oldest first.
  // They show in the chat at once and go to Claude when the turn ends (see
  // send-queue.ts). turnRunningRef is set the moment a turn starts, so two
  // sends in the same tick can't both start one.
  const queuedSendsRef = useRef<Record<string, { id: string; content: string | any[]; meta?: any }[]>>({});
  const turnRunningRef = useRef<Record<string, boolean>>({});
  const sendMessageRef = useRef<(content: string | any[], meta?: any, opts?: { tabId?: string; fromQueue?: string }) => void>(() => {});
  /** The turn on this tab ended: send the next waiting message, if any. */
  const turnEnded = (tabId: string) => {
    turnRunningRef.current[tabId] = false;
    const next = queuedSendsRef.current[tabId]?.shift();
    if (next) setTimeout(() => sendMessageRef.current(next.content, next.meta, { tabId, fromQueue: next.id }), 0);
  };
  // The voice engine the desktop is set to (ChatPanel learns it from the
  // gateway). GPT-Live tabs get the backend persona, ElevenLabs the spoken one.
  const voiceEngineRef = useRef<string>("elevenlabs");
  const setVoiceEngine = useCallback((engine: string) => {
    voiceEngineRef.current = engine;
  }, []);
  const personaFor = (voiceMode: boolean | undefined): string | undefined =>
    voiceMode ? (voiceEngineRef.current === "gpt-live" ? LIVE_BACKEND_PERSONA : VOICE_PERSONA) : undefined;
  // The main chat's instructions (main chat only), then the voice persona.
  const promptFor = (tab: TabSession | undefined): string | undefined =>
    appendedPrompt(tab?.isMain, personaFor(tab?.voiceMode));
  // The persona each tab's process was started with; a change swaps the
  // process on the next send between turns (never mid-turn — a hand-off
  // carries on after hang-up).
  const transportPromptRef = useRef<Record<string, string | undefined>>({});
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

  // ------- internal helpers -------

  const updateTabLastAssistant = useCallback(
    (tabId: string, updater: (msg: Message) => Partial<Message>) => {
      setState((prev) => ({
        ...prev,
        tabs: prev.tabs.map((tab) => {
          if (tab.id !== tabId) return tab;
          const msgs = [...tab.messages];
          // Claude's message, never a spoken turn from a live call.
          for (let i = msgs.length - 1; i >= 0; i--) {
            if (msgs[i].role === "assistant" && !msgs[i].voice) {
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

        // Background agents starting, reporting and finishing.
        if (event.type === "system") {
          const next = applyJobEvent(jobsRef.current[tabId] || {}, event);
          if (next) setJobs(tabId, next);
        }

        const ss = streamStatesRef.current[tabId];
        if (!ss) return;

        // System init
        if (event.type === "system" && event.subtype === "init") {
          if (event.session_id) {
            const t = stateRef.current.tabs.find((x) => x.id === tabId);
            if (t?.isMain && event.session_id !== optionsRef.current.mainChatSessionId) {
              optionsRef.current.onMainChatSession?.(event.session_id);
              // Named in History too, wherever it's opened.
              void saveCustomTitle(optionsRef.current.gatewayUrl, event.session_id, MAIN_CHAT_TITLE);
            }
            setState((prev) => ({
              ...prev,
              tabs: prev.tabs.map((tab) =>
                tab.id === tabId
                  ? { ...tab, cliSessionId: event.session_id, sessionPending: false }
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
            streamStatesRef.current[tabId] = newStreamState();
            // Claude Code carries on by itself after compacting; only if the
            // turn ends here is it nudged (see the result handler).
            compactNudgeRef.current[tabId] = true;
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
            transportsRef.current[tabId]?.sendPermissionResponse(requestId, "allow");
            return;
          }

          // ExitPlanMode — show plan review UI with plan content.
          // Claude is blocked until the user approves or rejects.
          if (toolName === "ExitPlanMode") {
            // Get plan content: first try the Write tool call that created
            // the plan (the content is right there in the input), then fall
            // back to readPlanFile (always null on mobile — no fs).
            let planContent: string | null = null;
            const writeCalls = ss.toolCalls.filter(
              (t) => t.name === "Write" && t.input?.content
            );
            if (writeCalls.length > 0) {
              planContent = writeCalls[writeCalls.length - 1].input.content;
            }
            if (!planContent) {
              planContent = readPlanFile();
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

          // A background agent's ask names the job.
          const asker = jobAsking(jobsRef.current[tabId], req)?.title;
          updateTabLastAssistant(tabId, (msg) => {
            const existing = msg.permissionRequests || [];
            // Guard against a re-delivered control_request for the same id.
            if (existing.some((r) => r.requestId === requestId)) {
              return {};
            }
            return {
              permissionRequests: [
                ...existing,
                { requestId, toolName, input: req.input, ...(asker ? { asker } : {}) },
              ],
            };
          });
          return;
        }

        // Result — turn complete. Only pick up contextWindow here; inputTokens
        // is tracked from individual assistant events (see below) since result.usage
        // aggregates across multiple API calls within a turn.
        if (event.type === "result") {
          // A sub-agent's own result never ends the chat's turn.
          if (event.isSidechain || event.parent_tool_use_id) return;
          if (compactNudgeRef.current[tabId]) {
            compactNudgeRef.current[tabId] = false;
            transportsRef.current[tabId]?.sendUserMessage(
              "Please continue where you left off before the compaction.",
              optionsRef.current.askFirst
            );
            return;
          }
          endTurn(ss, event);
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
                    ...(prev.activeTabId !== tabId
                      ? { hasUnseenReply: true }
                      : {}),
                  }
                : tab
            ),
          }));
          // Anything sent while this turn ran goes now.
          turnEnded(tabId);

          // Auto-generate title after first response
          if (options.autoGenerateTitles) {
            const currentTab = stateRef.current.tabs.find((t) => t.id === tabId);
            if (currentTab && !currentTab.isMain && currentTab.messages.length >= 2) {
              const firstUser = currentTab.messages.find((m) => m.role === "user" && !m.isCompaction);
              const firstAssistant = currentTab.messages.find((m) => m.role === "assistant" && !m.isCompaction);

              if (firstUser && firstAssistant) {
                const userText =
                  firstUser.displayText ||
                  (typeof firstUser.content === "string" ? firstUser.content : "");
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
                    gatewayUrl: options.gatewayUrl,
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

        // Claude started a turn of its own (a background agent finished, a
        // task notification, another session's message): it gets its own
        // reply below, and the one before it stays as it was.
        if (startsTurnOfItsOwn(ss, event)) {
          turnRunningRef.current[tabId] = true;
          const reply: Message = {
            role: "assistant",
            content: "",
            thinking: "",
            toolCalls: [],
            orderedBlocks: [],
            streaming: true,
            selfStarted: true,
          };
          setState((prev) => ({
            ...prev,
            tabs: prev.tabs.map((tab) =>
              tab.id === tabId
                ? { ...tab, messages: openReply(tab.messages, reply), generating: true }
                : tab
            ),
          }));
        }

        // User event (tool results)
        if (event.type === "user") {
          // A sub-agent's messages (its brief, its tool results) aren't the
          // chat's: they'd land in whatever reply was last.
          if (event.isSidechain || event.parent_tool_use_id) return;
          // A skill's instructions, added for the agent to read: never a message.
          if (isInjectedContext(event)) return;
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
          // A sub-agent's narration and report stay out of the chat's reply.
          if (isSidechain) return;
          compactNudgeRef.current[tabId] = false;
          const contentArr = event.message?.content || [];
          processContentBlocks(contentArr, ss, "assistant");
          updateTabLastAssistant(tabId, () => buildSnapshot(ss));

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

            if (delta?.type === "text_delta" && delta.text && !(event.isSidechain || event.parent_tool_use_id)) {
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
            model: activeTab?.model || LOCKED_MODEL,
            permissionMode: activeTab?.permissionMode || LOCKED_PERMISSION_MODE,
            agent: LOCKED_AGENT,
            voiceMode: false,
          },
        ],
        activeTabId: id,
      };
    });
  }, []);

  const closeTab = useCallback((tabIdToClose: string) => {
    // The main chat stays: it's the one conversation that's always there.
    if (!canCloseTab(stateRef.current.tabs.find((t) => t.id === tabIdToClose))) return;
    transportsRef.current[tabIdToClose]?.stop();
    delete transportsRef.current[tabIdToClose];
    delete streamStatesRef.current[tabIdToClose];
    delete jobsRef.current[tabIdToClose];

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
              model: LOCKED_MODEL,
              permissionMode: LOCKED_PERMISSION_MODE,
              agent: LOCKED_AGENT,
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
        saveCustomTitle(options.gatewayUrl, tab.cliSessionId, title).then(() => {
          refreshPastSessions();
        });
      }

      return {
        ...prev,
        tabs: prev.tabs.map((t) =>
          t.id === id ? { ...t, title } : t
        ),
      };
    });
  }, [options.gatewayUrl]); // refreshPastSessions intentionally omitted — declared later, referenced via closure

  // Rename a conversation from the task list (open tab or not). Saves the custom
  // title via the gateway and refreshes; updates the tab title too if it's open.
  const renamePastSession = useCallback((sessionId: string, title: string) => {
    saveCustomTitle(options.gatewayUrl, sessionId, title).then(() => {
      refreshPastSessions();
    });
    setState((prev) => ({
      ...prev,
      tabs: prev.tabs.map((t) =>
        t.cliSessionId === sessionId ? { ...t, title } : t
      ),
    }));
  }, [options.gatewayUrl]);

  // Persist pinned / closed to the shared metadata via the gateway, then refresh
  // so the list reflects it. WebSocket messages are ordered, so the write lands
  // before the subsequent list request reads it back.
  const setTaskMeta = useCallback(
    (sessionId: string, patch: { pinned?: boolean; closed?: boolean; lastActive?: string }) => {
      persistTaskMeta(options.gatewayUrl, sessionId, patch);
      setTimeout(() => refreshPastSessions(), 0);
    },
    [options.gatewayUrl]
  );

  // ------- messaging -------

  // A finished voice call: one line in the thread where the call started,
  // saved to the shared metadata through the gateway (so desktop sees it
  // too). A tab with no session yet holds it until an id exists.
  const addVoiceCall = useCallback(
    (tabId: string, call: VoiceCallRecord) => {
      const tab = stateRef.current.tabs.find((t) => t.id === tabId);
      if (!tab) return;
      // A tab Claude hasn't been used in yet gets its conversation id here,
      // so the call is saved at once and shows in history; Claude takes the
      // same id when it's first asked anything.
      const { sessionId, minted, title } = callHome(tab, call);
      saveVoiceCall(options.gatewayUrl, sessionId, call, title);
      const line: Message = { role: "system", content: "", streaming: false, voiceCall: call };
      setState((prev) => ({
        ...prev,
        tabs: prev.tabs.map((t) => {
          if (t.id !== tabId) return t;
          if (minted && !t.cliSessionId) t = { ...t, cliSessionId: sessionId, sessionPending: true, title: title || t.title };
          const exists = t.messages.some((m) => m.voiceCall?.id === call.id);
          const messages = exists
            ? t.messages.map((m) => (m.voiceCall?.id === call.id ? line : m))
            : insertCallLine(t.messages, line as Message & { voiceCall: VoiceCallRecord });
          return { ...t, messages };
        }),
      }));
    },
    [options.gatewayUrl]
  );

  useEffect(() => {
    for (const tab of state.tabs) {
      if (!tab.cliSessionId) continue;
      const unsaved = tab.messages.filter((m) => m.voiceCall && m.voiceCallUnsaved);
      if (!unsaved.length) continue;
      for (const m of unsaved) saveVoiceCall(options.gatewayUrl, tab.cliSessionId, m.voiceCall!);
      const tabId = tab.id;
      setState((prev) => ({
        ...prev,
        tabs: prev.tabs.map((t) =>
          t.id !== tabId ? t : { ...t, messages: t.messages.map((m) => (m.voiceCallUnsaved ? { ...m, voiceCallUnsaved: false } : m)) }
        ),
      }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.tabs]);

  const sendMessage = useCallback(
    (
      content: string | any[],
      meta?: { displayText?: string; attachedFileNames?: string[]; isCompaction?: boolean; handoff?: boolean },
      opts?: { tabId?: string; fromQueue?: string }
    ) => {
      const tabId = opts?.tabId ?? stateRef.current.activeTabId;
      const wasGenerating =
        !opts?.fromQueue &&
        (!!turnRunningRef.current[tabId] ||
          !!stateRef.current.tabs.find((t) => t.id === tabId)?.generating ||
          (queuedSendsRef.current[tabId]?.length ?? 0) > 0);

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
        handoff: meta?.handoff,
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

      // Claude is mid-turn: show it now, send it when the turn ends.
      if (wasGenerating && !meta?.isCompaction) {
        const qid = genId();
        (queuedSendsRef.current[tabId] ||= []).push({ id: qid, content, meta });
        setState((prev) => ({
          ...prev,
          tabs: prev.tabs.map((tab) =>
            tab.id === tabId ? { ...tab, messages: addOutgoing(tab.messages, userMsg, assistantMsg, true, qid) } : tab
          ),
        }));
        scrollRef.current.nearBottom = true;
        return;
      }
      turnRunningRef.current[tabId] = true;

      streamStatesRef.current[tabId] = newStreamState();

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
            : opts?.fromQueue
            ? startQueued(tab.messages, opts.fromQueue, assistantMsg)
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

      // Voice mode changed the persona since this process started: swap it
      // between turns. A turn still running keeps going.
      {
        const t = stateRef.current.tabs.find((x) => x.id === tabId);
        const running = transportsRef.current[tabId];
        // Background agents live in that process: the swap waits for the
        // first send after they finish.
        if (
          running &&
          maySwapProcess({
            running: running.isRunning(),
            midTurn: wasGenerating,
            jobs: jobsRef.current[tabId],
            promptChanged: transportPromptRef.current[tabId] !== promptFor(t),
          })
        ) {
          try {
            running.stop();
          } catch {}
          delete transportsRef.current[tabId];
        }
      }

      if (
        !transportsRef.current[tabId] ||
        !transportsRef.current[tabId].isRunning()
      ) {
        const currentTab = stateRef.current.tabs.find(
          (t) => t.id === tabId
        );
        transportPromptRef.current[tabId] = promptFor(currentTab);
        const cliSessionId = currentTab?.cliSessionId;

        const transport = new GatewayTransport({
          gatewayUrl: options.gatewayUrl,
          // The tab's own model: a reopened conversation carries on with the
          // one it was built on (and its context window), not the default.
          model: currentTab?.model || options.model,
          agent: options.agent,
          tabId,
          // A conversation that began as a call starts with --session-id on
          // the id Hyo gave it; anything Claude has written is resumed.
          ...sessionSpawn(cliSessionId ?? null, currentTab?.sessionPending),
          // Voice mode is a fresh conversation, so the persona is fixed for the
          // tab's life — inject it at spawn (and on any respawn, since it's sent
          // per-prompt). Text tabs send nothing and behave exactly as before.
          appendSystemPrompt: promptFor(currentTab),
          onMessage: makeProcessEvent(tabId),
          onError: (error) => console.error("[hyo] Gateway error:", error),
          onClose: (code) => {
            const wasGenerating = stateRef.current.tabs.find(
              (t) => t.id === tabId
            )?.generating;
            // Its background agents ended with it.
            if (jobsRunning(tabId)) setJobs(tabId, {});
            setState((prev) => ({
              ...prev,
              tabs: prev.tabs.map((tab) =>
                tab.id === tabId ? { ...tab, generating: false } : tab
              ),
            }));
            turnEnded(tabId);
            updateTabLastAssistant(tabId, () => ({ streaming: false }));
            // If the CLI process exited with an error while generating, show
            // an error message
            if (code !== 0 && code !== null && wasGenerating) {
              const errorMsg: Message = {
                role: "assistant",
                content: `_Claude process exited unexpectedly (code ${code}). Start a new conversation to continue._`,
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
          },
        });
        transport.spawn();
        transportsRef.current[tabId] = transport;
      }

      // The main chat's reminder rides on every message (never shown).
      const isMain = !!stateRef.current.tabs.find((t) => t.id === tabId)?.isMain;
      transportsRef.current[tabId].sendUserMessage(
        isMain && !meta?.isCompaction ? withMainChatReminder(content) : content,
        options.askFirst
      );
    },
    [options, makeProcessEvent, updateTabLastAssistant]
  );

  sendMessageRef.current = sendMessage;

  const sendPermissionResponse = useCallback(
    (requestId: string, behavior: "allow" | "allow_always" | "deny") => {
      const tabId = stateRef.current.activeTabId;
      // Look up the toolName from the pending permission request so the
      // transport can build the correct updatedPermissions for "always allow".
      // Any reply can hold it: a background agent's ask lands on whichever
      // reply was last when it came in.
      const tab = stateRef.current.tabs.find((t) => t.id === tabId);
      const toolName = tab?.messages
        .flatMap((m) => m.permissionRequests || [])
        .find((r) => r.requestId === requestId)?.toolName;
      transportsRef.current[tabId]?.sendPermissionResponse(requestId, behavior, toolName);
      const resolved = behavior === "deny" ? ("denied" as const) : ("allowed" as const);
      setState((prev) => ({
        ...prev,
        tabs: prev.tabs.map((t) =>
          t.id !== tabId
            ? t
            : {
                ...t,
                messages: t.messages.map((m) =>
                  m.permissionRequests?.some((r) => r.requestId === requestId)
                    ? { ...m, permissionRequests: m.permissionRequests.map((r) => (r.requestId === requestId ? { ...r, resolved } : r)) }
                    : m
                ),
              }
        ),
      }));
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
      transportsRef.current[tabId]?.sendPermissionResponse(
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
    transportsRef.current[tabId]?.sendInterrupt();
    setState((prev) => ({
      ...prev,
      tabs: prev.tabs.map((tab) =>
        tab.id === tabId ? { ...tab, generating: false } : tab
      ),
    }));
    updateTabLastAssistant(tabId, () => ({ streaming: false }));
  }, [updateTabLastAssistant]);

  const setTabPermissionMode = useCallback((permissionMode: string) => {
    setState((prev) => ({
      ...prev,
      tabs: prev.tabs.map((tab) =>
        tab.id === prev.activeTabId ? { ...tab, permissionMode } : tab
      ),
    }));
  }, []);

  const toggleVoiceMode = useCallback(() => {
    // The persona is a spawn-time argument; the next send swaps the process
    // (see sendMessage). Nothing is stopped here, so a hand-off still running
    // when the call ends keeps going and posts to the chat.
    const tabId = stateRef.current.activeTabId;
    setState((prev) => ({
      ...prev,
      tabs: prev.tabs.map((tab) =>
        tab.id === tabId
          ? { ...tab, voiceMode: !tab.voiceMode }
          : tab
      ),
    }));
  }, []);

  // ------- past sessions -------

  const refreshPastSessions = useCallback(() => {
    listPastSessions(options.gatewayUrl)
      .then(setPastSessions)
      .catch((e) => console.error("[hyo] Failed to list past sessions:", e));
  }, [options.gatewayUrl]);

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

    // Open the tab immediately (empty) and switch to it — history is
    // fetched from the gateway asynchronously and back-filled once it
    // arrives, so opening a past session doesn't block the UI.
    const id = genId();
    setState((prev) => {
      const activeTab = prev.tabs.find((t) => t.id === prev.activeTabId);
      return {
        tabs: [
          ...prev.tabs,
          {
            id,
            cliSessionId: pastSession.id,
            sessionPending: !!pastSession.callOnly,
            title: pastSession.title,
            messages: [],
            generating: false,
            model: activeTab?.model || LOCKED_MODEL,
            permissionMode: activeTab?.permissionMode || LOCKED_PERMISSION_MODE,
            agent: LOCKED_AGENT,
            voiceMode: false,
          },
        ],
        activeTabId: id,
      };
    });

    backfill(id, pastSession.id);
  }, [options.gatewayUrl]);

  /** Fill an open tab with its conversation's history from the gateway. */
  function backfill(id: string, sessionId: string) {
    loadSessionHistory(options.gatewayUrl, sessionId).then((history) => {
      const claudeMessages: Message[] = history.messages.map((m) => {
        // Hand-offs from a live call carry the marker in the prompt itself.
        const handoff = m.role === "user" && m.content.includes(HANDOFF_MARKER);
        return {
          role: m.role,
          content: m.content,
          thinking: m.thinking || "",
          toolCalls: m.toolCalls || [],
          orderedBlocks: m.orderedBlocks || [],
          streaming: false,
          handoff: handoff || undefined,
          displayText: handoff ? handoffRequestText(m.content) : m.displayText,
        };
      });
      // Each voice call goes back in as its one line, where it started.
      const messages = threadCalls(claudeMessages, history.voiceCalls || [], (call) => ({
        role: "system" as const,
        content: "",
        streaming: false,
        voiceCall: call,
      }));
      // Continue on the model the conversation was actually built with, rather
      // than the hardcoded mobile default. Resuming must not silently switch
      // models mid-conversation — and forcing a long conversation onto a
      // different model's context window is what caused "Prompt is too long".
      const inheritedModel = history.model || LOCKED_MODEL;
      setState((prev) => ({
        ...prev,
        tabs: prev.tabs.map((t) =>
          // Only if nothing has been said in it yet on this phone.
          t.id === id && t.messages.length === 0 ? { ...t, messages, model: inheritedModel } : t
        ),
      }));
    });
  }

  // ---- Reopen the tabs from last time ---------------------------------------
  // Same behaviour as desktop: remember which conversations are open and
  // restore them on mount. Device-local (this webview's localStorage), so the
  // phone's desk is its own — closing the app doesn't lose your open tabs.
  const restoreKey = `hyo-open-tabs:${options.gatewayUrl}`;
  const restoredRef = useRef(false);

  useEffect(() => {
    if (restoredRef.current || !options.gatewayUrl) return;
    restoredRef.current = true;
    let saved: { sessions: { id: string; title: string }[]; activeId?: string | null } | null = null;
    try {
      saved = JSON.parse(window.localStorage.getItem(restoreKey) || "null");
    } catch {
      /* absent or corrupt — start fresh */
    }
    if (!saved?.sessions?.length) return;
    for (const s of saved.sessions) {
      // The main chat has its own tab; never a second copy of it.
      if (s?.id && !(options.mainChat && s.id === options.mainChatSessionId)) {
        openPastSession({ id: s.id, title: s.title || "Untitled" } as PastSession);
      }
    }
    const activeId = saved.activeId;
    setState((prev) => {
      const restored = prev.tabs.filter((t) => t.cliSessionId && !t.isMain);
      if (restored.length === 0) return prev;
      // The pristine starter tab makes way for the restored desk.
      const tabs = prev.tabs.filter((t) => t.isMain || t.cliSessionId || t.messages.length > 0);
      return { tabs, activeTabId: startupActive(tabs, activeId) || tabs[tabs.length - 1].id };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openPastSession, options.gatewayUrl]);

  useEffect(() => {
    if (!restoredRef.current || !options.gatewayUrl) return; // never clobber before restore reads it
    try {
      // The main chat isn't part of the desk: it's always there.
      const sessions = state.tabs
        .filter((t) => t.cliSessionId && !t.isMain)
        .map((t) => ({ id: t.cliSessionId as string, title: t.title }));
      const active = state.tabs.find((t) => t.id === state.activeTabId);
      window.localStorage.setItem(
        restoreKey,
        JSON.stringify({ sessions, activeId: active?.cliSessionId || null }),
      );
    } catch {
      /* storage unavailable — restore just won't happen */
    }
  }, [state.tabs, state.activeTabId, restoreKey, options.gatewayUrl]);

  // ---- The main chat --------------------------------------------------------
  // Same as desktop: a pinned first tab carrying the one long conversation
  // (the id comes from the synced settings), and what Hyo opens to when
  // nothing else is open. Off: it stays as an ordinary tab.
  useEffect(() => {
    if (!options.gatewayUrl) return;
    let filled: { id: string; sid: string } | null = null;
    setState((prev) => {
      const enabled = !!options.mainChat;
      let tabs = withMainChat(prev.tabs, enabled, () => {
        const sid = options.mainChatSessionId || null;
        const tab: TabSession = {
          id: genId(),
          cliSessionId: sid,
          title: MAIN_CHAT_TITLE,
          messages: [],
          generating: false,
          model: LOCKED_MODEL,
          permissionMode: LOCKED_PERMISSION_MODE,
          agent: LOCKED_AGENT,
          inputTokens: 0,
          voiceMode: false,
          isMain: true,
        };
        if (sid) filled = { id: tab.id, sid };
        return tab;
      });
      if (tabs === prev.tabs) return prev;
      let activeTabId = prev.activeTabId;
      if (enabled) {
        const pristine = (t: TabSession) => !t.isMain && !t.cliSessionId && t.messages.length === 0;
        const others = tabs.filter((t) => !t.isMain);
        if (others.length > 0 && others.every(pristine)) tabs = tabs.filter((t) => t.isMain);
        if (!tabs.some((t) => t.id === activeTabId) || tabs.length === 1) activeTabId = tabs[0].id;
      }
      return { tabs: mainFirst(tabs), activeTabId };
    });
    // setState's updater has run by the next tick; then read its history.
    setTimeout(() => {
      if (filled) backfill(filled.id, filled.sid);
    }, 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options.mainChat, options.gatewayUrl]);

  const compact = useCallback(() => {
    sendMessage("/compact", { isCompaction: true });
  }, [sendMessage]);

  // On desktop this surgically repaired a session poisoned by an orphaned
  // `thinking` block, editing the .jsonl directly via fs. There's no fs on
  // mobile and the gateway protocol doesn't expose a repair RPC, so
  // repairSession always reports failure here — the "Recover session"
  // button still appears (ChatMessage.tsx detects the same error text) but
  // tells the user recovery isn't available yet instead of silently no-op'ing.
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

      const result = repairSession(tab.cliSessionId);
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
    []
  );

  // After the gateway Mac updates Claude: stop this tab's process on the Mac
  // (it's still the old Claude), then resend the message that drew the
  // "needs an update" error, in place of the failed pair. Same rules as the
  // desktop: only the tab in view, and only a plain typed message. Returns
  // whether it resent.
  const retryAfterClaudeUpdate = useCallback(
    (tabId: string): boolean => {
      // The Mac's old process is stopped so the next send starts the updated
      // Claude. Background jobs running in it would stop too, so that waits.
      const restart = () => {
        const existing = transportsRef.current[tabId];
        if (existing) {
          try {
            existing.stop();
          } catch {}
          delete transportsRef.current[tabId];
        }
      };

      const tab = stateRef.current.tabs.find((t) => t.id === tabId);
      if (!tab) {
        restart();
        return false;
      }
      const msgs = tab.messages;
      const textOf = (m: Message) =>
        (m.content || "") +
        "\n" +
        (m.orderedBlocks || [])
          .filter((b) => b.type === "text")
          .map((b) => b.content || "")
          .join("\n");
      let failedAt = -1;
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i];
        if (m.role === "assistant" && !m.streaming && parseClaudeUpdateError(textOf(m))) {
          failedAt = i;
          break;
        }
      }
      if (failedAt < 0) {
        whenIdle(tabId, restart);
        return false;
      }

      const prevUser = msgs[failedAt - 1];
      const text = prevUser ? prevUser.displayText ?? prevUser.content : "";
      const canResend =
        stateRef.current.activeTabId === tabId &&
        !msgs[failedAt].isCompaction &&
        prevUser?.role === "user" &&
        !prevUser.isCompaction &&
        !prevUser.attachments?.length &&
        typeof text === "string" &&
        !!text.trim();
      if (!canResend) {
        whenIdle(tabId, restart);
        return false;
      }

      whenIdle(tabId, () => {
        restart();
        setState((prev) => ({
          ...prev,
          tabs: prev.tabs.map((t) =>
            t.id === tabId
              ? { ...t, messages: t.messages.filter((_, i) => i !== failedAt - 1 && i !== failedAt) }
              : t
          ),
        }));
        setTimeout(() => sendMessage(text, { displayText: prevUser!.displayText }), 0);
      });
      return true;
    },
    [sendMessage]
  );

  // ------- return -------

  const activeTab = state.tabs.find((t) => t.id === state.activeTabId);

  /** Background jobs still running in a tab (closing it would stop them). */
  const tabJobs = useCallback((tabId: string): BackgroundJob[] => jobList(jobsRef.current[tabId]), []);

  return {
    activeJobs: jobList(activeTab?.jobs),
    activeIsMain: !!activeTab?.isMain,
    tabJobs,
    addVoiceCall,
    setVoiceEngine,
    tabs: state.tabs,
    activeTabId: state.activeTabId,
    activeMessages: activeTab?.messages || [],
    activeGenerating: activeTab?.generating || false,
    activeModel: activeTab?.model || LOCKED_MODEL,
    activePermissionMode: activeTab?.permissionMode || LOCKED_PERMISSION_MODE,
    activeAgent: activeTab?.agent || LOCKED_AGENT,
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
    setTabPermissionMode,
    toggleVoiceMode,
    sendMessage,
    sendPermissionResponse,
    sendQuestionAnswer,
    stopGeneration,
    compact,
    recoverSession,
    retryAfterClaudeUpdate,
    pastSessions,
    openPastSession,
    refreshPastSessions,
    scrollRef,
  };
}
