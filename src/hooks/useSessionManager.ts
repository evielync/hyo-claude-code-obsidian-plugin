import { debug } from "../debug";
import { addOutgoing, startQueued } from "../send-queue";
import { newStreamState, processContentBlocks, buildSnapshot, endTurn, startsTurnOfItsOwn, openReply, isInjectedContext, type StreamState } from "../reply-stream";
import { useState, useCallback, useRef, useEffect } from "react";
import { ClaudeTransport, normalizeModelId } from "../claude-transport";
import { MainChatTransport, mainChatOwner } from "../main-chat-owner";

type TabProc = ClaudeTransport | MainChatTransport;
import { VOICE_PERSONA, LIVE_BACKEND_PERSONA, HANDOFF_MARKER } from "../voice/voice-persona";
import type {
  Message,
  ToolCallData,
  OrderedBlock,
  AskQuestionData,
  PlanReviewData,
} from "./useChatEngine";
import { listPastSessions, loadSessionHistory, loadSessionModel, saveCustomTitle, setTaskMeta as persistTaskMeta, type PastSession, getProjectDir, saveVoiceCall, getVoiceCalls, hasTranscript } from "../session-parser";
import { handoffRequestText, threadCalls, insertCallLine, sessionSpawn, callHome, type VoiceCallRecord } from "../voice/voice-call";
import { repairSession, isThinkingBlockApiError, type RepairResult } from "../session-repair";
import { generateConversationTitle } from "../title-generator";
import { Platform } from "obsidian";
import { parseClaudeUpdateError, isClaudeAuthError } from "../models";
import { applyJobEvent, hasRunningJobs, jobAsking, jobList, IdleGate, maySwapProcess, type JobMap, type BackgroundJob } from "../background-jobs";
import { appendedPrompt, withMainChatReminder, withMainChat, mainFirst, canCloseTab, canReorder, startupActive, MAIN_CHAT_TITLE } from "../main-chat";
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
  // The main chat: pinned first, can't be closed, delegates to background
  // agents (see main-chat.ts).
  isMain?: boolean;
  // Background agents running in this tab's Claude process, by task id.
  jobs?: JobMap;
}

interface SessionState {
  tabs: TabSession[];
  activeTabId: string;
}

interface SessionManagerOptions {
  cliPath: string;
  cwd: string;
  model: string;
  effort: string;
  permissionMode: string;
  defaultAgent: string;
  maxOutputTokens?: number;
  settingsVersion?: number;
  autoGenerateTitles?: boolean;
  // Which voice engine is on — picks the persona Claude gets in voice mode.
  voiceEngine?: string;
  // Settings → Main chat. The conversation it carries on, shared with the
  // phone through the synced settings, and where a new id is saved.
  mainChat?: boolean;
  mainChatSessionId?: string;
  onMainChatSession?: (sessionId: string) => void;
}

// ------- utilities -------

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

/** The reply updateTabLastAssistant writes to: the last of Claude's, never a call's spoken turn. */
function lastAssistantIndex(msgs: Message[]): number {
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === "assistant" && !msgs[i].voice) return i;
  }
  return -1;
}

function genId(): string {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}


// ------- hook -------

export function useSessionManager(options: SessionManagerOptions) {
  // A fresh conversation on the defaults from Settings.
  const blankTab = (): TabSession => ({
    id: genId(),
    cliSessionId: null,
    title: "New conversation",
    messages: [],
    generating: false,
    model: options.model,
    effort: options.effort,
    permissionMode: options.permissionMode,
    agent: options.defaultAgent,
    inputTokens: 0,
    voiceMode: false,
  });
  const [state, setState] = useState<SessionState>(() => {
    const tab = blankTab();
    return { tabs: [tab], activeTabId: tab.id };
  });

  const [pastSessions, setPastSessions] = useState<PastSession[]>([]);

  const transportsRef = useRef<Record<string, TabProc>>({});
  // Each tab's background jobs, kept in step with tab.jobs so the stop
  // guards below read the latest without waiting for a render.
  const jobsRef = useRef<Record<string, JobMap>>({});
  // Work that has to restart a tab's process, held until its background
  // jobs finish (restarting would stop them).
  const gatesRef = useRef<Record<string, IdleGate>>({});
  const gate = (tabId: string) => (gatesRef.current[tabId] ||= new IdleGate());
  const jobsRunning = (tabId: string) => hasRunningJobs(jobsRef.current[tabId]);
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
    // Out of this event's handling first, so a restart never runs inside it.
    setTimeout(() => gate(tabId).update(jobsRef.current[tabId]), 0);
  };
  // An auto-compaction that ended the turn without carrying on (older CLIs).
  // Newer ones continue by themselves, and a nudge would start a second turn.
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
  // The system prompt each tab's process was spawned with. Voice mode changes
  // it; the process is swapped on the next send between turns, never by
  // killing a turn that's running (a hand-off carries on after hang-up).
  const transportPromptRef = useRef<Record<string, string | undefined>>({});
  const personaFor = (voiceMode: boolean | undefined): string | undefined =>
    voiceMode ? (options.voiceEngine === "gpt-live" ? LIVE_BACKEND_PERSONA : VOICE_PERSONA) : undefined;
  // What a tab's process is spawned with: the main chat's instructions (main
  // chat only), then the voice persona when a call is on.
  const promptFor = (tab: TabSession | undefined): string | undefined =>
    appendedPrompt(tab?.isMain, personaFor(tab?.voiceMode));
  const streamStatesRef = useRef<Record<string, StreamState>>({});
  const scrollRef = useRef({ nearBottom: true });
  const stateRef = useRef(state);
  // The newest cliPath, readable before a re-render lands. Updating Claude can
  // move it (the installer puts a fresh copy in ~/.local), and the resend that
  // follows fires in the same tick, before `options` catches up.
  const cliPathRef = useRef(options.cliPath);
  cliPathRef.current = options.cliPath;
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
          // Claude's message, never a spoken turn from a live call — those
          // can land after the streaming placeholder while Claude works.
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

        // The main chat, shared with other views (main-chat-owner.ts).
        if (event.type === "hyo_user_message" || event.type === "hyo_busy") {
          // Said from another view (the phone, another panel), or a turn
          // already under way when this one joined: show it, and a reply.
          turnRunningRef.current[tabId] = true;
          streamStatesRef.current[tabId] = newStreamState();
          const reply: Message = { role: "assistant", content: "", thinking: "", toolCalls: [], orderedBlocks: [], streaming: true };
          const said: Message[] = event.type === "hyo_user_message" && event.text ? [{ role: "user", content: event.text, displayText: event.text }] : [];
          setState((prev) => ({
            ...prev,
            tabs: prev.tabs.map((t) =>
              t.id === tabId ? { ...t, messages: openReply([...t.messages, ...said], reply), generating: true } : t
            ),
          }));
          return;
        }
        if (event.type === "hyo_permission_answered") {
          const resolved = event.behavior === "deny" ? ("denied" as const) : ("allowed" as const);
          setState((prev) => ({
            ...prev,
            tabs: prev.tabs.map((t) =>
              t.id !== tabId
                ? t
                : {
                    ...t,
                    messages: t.messages.map((m) =>
                      m.permissionRequests?.some((r) => r.requestId === event.requestId)
                        ? { ...m, permissionRequests: m.permissionRequests.map((r) => (r.requestId === event.requestId ? { ...r, resolved } : r)) }
                        : m
                    ),
                  }
            ),
          }));
          return;
        }
        if (event.type === "hyo_owner_refused") {
          updateTabLastAssistant(tabId, () => ({
            streaming: false,
            content: "_The main chat is already running in another copy of Obsidian on this computer. Use that one, or quit it and try again._",
          }));
          setState((prev) => ({ ...prev, tabs: prev.tabs.map((t) => (t.id === tabId ? { ...t, generating: false } : t)) }));
          turnEnded(tabId);
          return;
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
              saveCustomTitle(options.cwd, event.session_id, MAIN_CHAT_TITLE);
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
            // Claude Code carries on by itself after compacting (2.1.280:
            // compact, then the answer, in one turn). Only if the turn ends
            // here instead is it nudged to continue; see the result handler.
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

          // A background agent's ask names the job, so it reads as that job
          // asking, not the chat.
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
          // A sub-agent finishing emits its own `result` — that must NOT end the
          // main turn (which is still running the delegation). Otherwise the
          // main tab flips to "not generating" mid-turn: in voice mode the mic
          // un-suspends and the Blob drops to "Listening" while Chad's still
          // working. Only the main-chain result ends the turn.
          if (event.isSidechain || event.parent_tool_use_id) return;
          // Compacted and stopped without carrying on: ask it to continue,
          // into the same reply.
          if (compactNudgeRef.current[tabId]) {
            compactNudgeRef.current[tabId] = false;
            transportsRef.current[tabId]?.sendUserMessage(
              "Please continue where you left off before the compaction."
            );
            return;
          }
          endTurn(ss, event);
          updateTabLastAssistant(tabId, (msg) => {
            // Claude too old for this model: the turn ends on an API error
            // naming the version it needs. Flag it so the message offers the
            // update instead of leaving the person with a raw 400.
            const text = [
              typeof event.result === "string" ? event.result : "",
              msg.content || "",
              ...(msg.orderedBlocks || [])
                .filter((b) => b.type === "text")
                .map((b) => b.content || ""),
            ].join("\n");
            const found = parseClaudeUpdateError(text);
            if (found) return { streaming: false, claudeUpdate: { ...found, status: "needed" } };
            // Login expired: offer sign-in on the message, same as the update.
            if (isClaudeAuthError(text)) return { streaming: false, claudeSignIn: { status: "needed" } };
            return { streaming: false };
          });
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
          // Anything sent while this turn ran goes now.
          turnEnded(tabId);

          // Auto-generate title after first response
          if (options.autoGenerateTitles) {
            const currentTab = stateRef.current.tabs.find((t) => t.id === tabId);
            if (currentTab && !currentTab.isMain && currentTab.messages.length >= 2) {
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
                      .find((m) => m.role === "assistant" && !m.isCompaction && !m.voice)
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
          // A sub-agent's messages stream in as sidechain user events — and the
          // FIRST one is its user message, which is the delegation prompt itself.
          // Without this gate that prompt lands as a text block in the main reply
          // and voice reads the raw instructions aloud. The main chain's own tool
          // results are NOT sidechain, so they still process normally below.
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
          // A sub-agent's completed messages (its narration and final report)
          // arrive as sidechain assistant events. Do NOT merge them into the
          // main reply — otherwise voice reads the agent's raw output aloud and
          // it clutters the transcript. The Agent tool block + its result still
          // show the work.
          if (!isSidechain) {
            compactNudgeRef.current[tabId] = false;
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
    // A new tab starts on the defaults from Settings. The picker changes the
    // tab you're in, nothing else.
    const tab = blankTab();
    setState((prev) => ({ tabs: [...prev.tabs, tab], activeTabId: tab.id }));
  }, [options.model, options.effort, options.permissionMode]);

  const closeTab = useCallback((tabIdToClose: string) => {
    // The main chat stays: it's the one conversation that's always there.
    if (!canCloseTab(stateRef.current.tabs.find((t) => t.id === tabIdToClose))) return;
    transportsRef.current[tabIdToClose]?.stop();
    delete transportsRef.current[tabIdToClose];
    delete streamStatesRef.current[tabIdToClose];
    delete jobsRef.current[tabIdToClose];
    delete gatesRef.current[tabIdToClose];

    setState((prev) => {
      const remaining = prev.tabs.filter((t) => t.id !== tabIdToClose);

      if (remaining.length === 0) {
        const tab = blankTab();
        return { tabs: [tab], activeTabId: tab.id };
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
  }, [options.cwd]); // refreshPastSessions intentionally omitted — declared later, referenced via closure

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
  }, [options.cwd]);

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

  // ---- Voice calls -----------------------------------------------------------
  // Each finished call becomes one `voiceCall` line in the thread, where the
  // call started. The record is Hyo's, not Claude's: written to
  // session-metadata against the tab's session id. A tab with no session yet
  // (a call that never handed anything to Claude) keeps it flagged unsaved;
  // the effect below writes it the moment an id exists.

  const persistCall = (cliSessionId: string | null, call: VoiceCallRecord): boolean => {
    if (!cliSessionId) return false;
    try {
      saveVoiceCall(options.cwd, cliSessionId, call);
      return true;
    } catch (e) {
      console.error("[hyo] Couldn't save the voice call:", e);
      return false;
    }
  };

  /**
   * Put a finished call in its tab's thread and save it. Calling again with
   * the same id replaces it. A tab Claude hasn't been used in yet gets its
   * conversation id here, chosen by Hyo, so the call is saved at once and the
   * conversation shows in history; Claude takes the same id when it's first
   * asked anything (see sessionSpawn).
   */
  const addVoiceCall = useCallback(
    (tabId: string, call: VoiceCallRecord) => {
      const tab = stateRef.current.tabs.find((t) => t.id === tabId);
      if (!tab) return;
      const { sessionId, minted, title } = callHome(tab, call);
      // Written before the state update so it survives the panel closing.
      let saved = false;
      try {
        saveVoiceCall(options.cwd, sessionId, call, title);
        saved = true;
      } catch (e) {
        console.error("[hyo] Couldn't save the voice call:", e);
      }
      const line: Message = { role: "system", content: "", streaming: false, voiceCall: call, voiceCallUnsaved: !saved };
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
    [options.cwd]
  );

  useEffect(() => {
    for (const tab of state.tabs) {
      if (!tab.cliSessionId) continue;
      const unsaved = tab.messages.filter((m) => m.voiceCall && m.voiceCallUnsaved);
      if (!unsaved.length) continue;
      for (const m of unsaved) persistCall(tab.cliSessionId, m.voiceCall!);
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

  // Move a tab to sit where another tab currently is. Dropping onto the right
  // half of the target lands after it, which is what makes dragging a tab to
  // the end of the bar feel natural.
  const reorderTab = useCallback((draggedId: string, targetId: string, after: boolean) => {
    if (draggedId === targetId) return;
    setState((prev) => {
      // The main chat stays first.
      if (!canReorder(prev.tabs, draggedId, targetId, after)) return prev;
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

  /**
   * Let go of a tab's process so the next message starts a fresh one. The
   * main chat's shared process is restarted in its owner (only when nothing
   * is running there), and this view joins again.
   */
  function restartTransport(tabId: string): void {
    const existing = transportsRef.current[tabId];
    if (!existing) return;
    try {
      if (existing instanceof MainChatTransport) existing.restartProcess();
      existing.stop();
    } catch {}
    delete transportsRef.current[tabId];
  }

  /** The tab's Claude connection: its own process, or the main chat's shared one. */
  function openTransport(tabId: string): TabProc {
    const currentTab = stateRef.current.tabs.find(
      (t) => t.id === tabId
    );
    const cliSessionId = currentTab?.cliSessionId;
    transportPromptRef.current[tabId] = promptFor(currentTab);

    const spec = {
      cliPath: cliPathRef.current || options.cliPath,
      cwd: options.cwd,
      model: currentTab?.model || options.model,
      effort: currentTab?.effort || options.effort,
      permissionMode: currentTab?.permissionMode || options.permissionMode,
      agent: currentTab?.agent || "",
      // A conversation that began as a call starts with --session-id on
      // the id Hyo gave it; anything Claude has written is resumed.
      ...sessionSpawn(
        cliSessionId ?? null,
        currentTab?.sessionPending || (!!cliSessionId && !hasTranscript(options.cwd, cliSessionId))
      ),
      maxOutputTokens: options.maxOutputTokens,
      // The main chat's delegation instructions, then the voice persona
      // when a call is on. ElevenLabs: Claude IS the voice, so it gets the
      // full spoken persona. GPT-Live: a separate model talks; Claude is
      // the backend it hands to. A change respawns between turns (above)
      // and --resumes.
      appendSystemPrompt: promptFor(currentTab),
    };
    const handlers = {
      onMessage: makeProcessEvent(tabId),
      onError: (error: string) => console.error("[hyo] CLI error:", error),
      onClose: (code: number | null) => {
        // Hyo stopped this process on purpose (sign-in, update, agent or
        // voice switch, closed tab) and has already let go of it. Its exit
        // arrives late, often after a replacement process is running, so
        // it must not touch the tab: no crash message, no ending the new
        // turn, and no deleting the replacement from transportsRef.
        if (transportsRef.current[tabId] !== transport) return;
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
        // If process exited with error while generating, show error message
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
        // The main chat stays subscribed: the next message starts a new
        // process in the owner, and other views keep hearing it.
        if (!(transport instanceof MainChatTransport)) delete transportsRef.current[tabId];
      },
    };
    // The main chat never gets a process of its own: it joins the one
    // the Mac's owner runs, shared with other panels and the phone.
    const owner = currentTab?.isMain ? mainChatOwner(options.cwd) : null;
    const transport: TabProc = owner
      ? new MainChatTransport(owner, spec, handlers)
      : new ClaudeTransport({ ...spec, ...handlers });
    transport.spawn();
    transportsRef.current[tabId] = transport;
    return transport;
  }

  // ------- messaging -------

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

      // Voice mode changes the system prompt, which is fixed at spawn. Swap
      // the process here, between turns — if a turn is still running (a
      // hand-off carrying on after hang-up), keep it and swap next time.
      {
        const t = stateRef.current.tabs.find((x) => x.id === tabId);
        const running = transportsRef.current[tabId];
        // Background agents live in this process: stopping it would stop
        // them, so the swap waits for the first send after they finish.
        if (
          running &&
          maySwapProcess({
            running: running.isRunning(),
            midTurn: wasGenerating,
            jobs: jobsRef.current[tabId],
            promptChanged: transportPromptRef.current[tabId] !== promptFor(t),
          })
        ) {
          running.stop();
          delete transportsRef.current[tabId];
        }
      }

      if (
        !transportsRef.current[tabId] ||
        !transportsRef.current[tabId].isRunning()
      ) {
        openTransport(tabId);
      }

      // The main chat's reminder rides on every message (never shown).
      const isMain = !!stateRef.current.tabs.find((t) => t.id === tabId)?.isMain;
      transportsRef.current[tabId].sendUserMessage(
        isMain && !meta?.isCompaction ? withMainChatReminder(content) : content
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
      // Resolve it on the message that holds it, wherever that is.
      setState((prev) => ({
        ...prev,
        tabs: prev.tabs.map((t) => {
          if (t.id !== tabId) return t;
          const holder = t.messages.findIndex((m) => m.permissionRequests?.some((r) => r.requestId === requestId));
          if (holder < 0 || holder === lastAssistantIndex(t.messages)) return t;
          const messages = [...t.messages];
          const m = messages[holder];
          messages[holder] = {
            ...m,
            permissionRequests: m.permissionRequests!.map((r) =>
              r.requestId === requestId ? { ...r, resolved: behavior === "deny" ? ("denied" as const) : ("allowed" as const) } : r
            ),
          };
          return { ...t, messages };
        }),
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
        .find((m) => m.role === "assistant" && !m.voice);
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
    // The voice persona is a spawn-time argument, so the next send swaps the
    // process (see sendMessage). Nothing is stopped here: a hand-off still
    // running when the call ends keeps going and posts to the chat.
    setState((prev) => ({
      ...prev,
      tabs: prev.tabs.map((tab) =>
        tab.id === prev.activeTabId ? { ...tab, voiceMode: !tab.voiceMode } : tab
      ),
    }));
  }, []);

  const setTabAgent = useCallback((agent: string): boolean => {
    // Switching agents requires a fresh CLI process, which would stop any
    // background agents still working in this one: refused until they finish.
    if (jobsRunning(stateRef.current.activeTabId)) return false;
    // Kill the current transport. Next sendMessage will respawn with the new
    // --agent flag.
    setState((prev) => {
      const tabId = prev.activeTabId;
      restartTransport(tabId);
      delete streamStatesRef.current[tabId];
      return {
        ...prev,
        tabs: prev.tabs.map((tab) =>
          tab.id === tabId ? { ...tab, agent, cliSessionId: null } : tab
        ),
      };
    });
    return true;
  }, []);

  // ------- past sessions -------

  const refreshPastSessions = useCallback(() => {
    try {
      const sessions = listPastSessions(options.cwd);
      setPastSessions(sessions);
    } catch (e) {
      console.error("[hyo] Failed to list past sessions:", e);
    }
  }, [options.cwd]);

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

    const tab = sessionTab(pastSession);
    setState((prev) => ({ tabs: [...prev.tabs, tab], activeTabId: tab.id }));
  }, [options.cwd, options.model, options.effort, options.permissionMode, options.defaultAgent]);

  /** A tab holding a saved conversation, its history read back from disk. */
  function sessionTab(pastSession: Pick<PastSession, "id" | "title" | "callOnly">): TabSession {
    // Load conversation history from JSONL
    const history = loadSessionHistory(options.cwd, pastSession.id);
    const sessionModel = loadSessionModel(options.cwd, pastSession.id);
    const claudeMessages: Message[] = history.map((m) => ({
      role: m.role,
      content: m.content,
      thinking: m.thinking || "",
      toolCalls: m.toolCalls || [],
      orderedBlocks: m.orderedBlocks || [],
      streaming: false,
      // Hand-offs from a live call carry this marker in the prompt itself;
      // the spoken request is the line just before it.
      handoff: m.role === "user" && m.content.includes(HANDOFF_MARKER) ? true : undefined,
      displayText:
        m.role === "user" && m.content.includes(HANDOFF_MARKER)
          ? handoffRequestText(m.content)
          : undefined,
    }));
    // Each voice call goes back in as its one line, where the call started.
    const messages: Message[] = threadCalls(claudeMessages, getVoiceCalls(options.cwd, pastSession.id), (call) => ({
      role: "system",
      content: "",
      streaming: false,
      voiceCall: call,
    }));

    return {
      id: genId(),
      cliSessionId: pastSession.id,
      sessionPending: !!pastSession.callOnly,
      title: pastSession.title,
      messages,
      generating: false,
      // A reopened conversation carries on with the model it was last
      // running on. Effort and permission mode aren't recorded in the
      // session, so those come from Settings.
      model: sessionModel || options.model,
      effort: options.effort,
      permissionMode: options.permissionMode,
      agent: options.defaultAgent,
      inputTokens: 0,
      voiceMode: false,
    };
  }

  /** The main chat's tab: its conversation if it has one on disk, else a fresh one. */
  const mainTab = (): TabSession => {
    const sid = options.mainChatSessionId;
    const base =
      sid && hasTranscript(options.cwd, sid)
        ? sessionTab({ id: sid, title: MAIN_CHAT_TITLE })
        : blankTab();
    return { ...base, title: MAIN_CHAT_TITLE, isMain: true };
  };

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
  }, [openPastSession]);

  useEffect(() => {
    if (!restoredRef.current) return; // never clobber the stored desk before restore reads it
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
  }, [state.tabs, state.activeTabId, restoreKey]);

  // The main chat listens from the moment it's open, so what's said on the
  // phone or in another panel shows here as it happens.
  useEffect(() => {
    for (const t of state.tabs) {
      if (!t.isMain || transportsRef.current[t.id] || !mainChatOwner(options.cwd)) continue;
      // Anything streaming in before this view sends opens a reply of its own.
      if (!streamStatesRef.current[t.id]) streamStatesRef.current[t.id] = { ...newStreamState(), turnDone: true };
      openTransport(t.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.tabs]);

  // ---- The main chat --------------------------------------------------------
  // Settings → Main chat on: a pinned first tab carrying the one long
  // conversation, and what Hyo opens to when nothing else is open. Off: it
  // stays open as an ordinary tab, so nothing running in it stops.
  useEffect(() => {
    setState((prev) => {
      const enabled = !!options.mainChat;
      let tabs = withMainChat(prev.tabs, enabled, mainTab);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options.mainChat]);

  const compact = useCallback(() => {
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

      if (jobsRunning(tabId)) {
        return {
          success: false,
          linesRemoved: 0,
          capturedUserText: null,
          reason: "background work is still running in this chat. Try again once it has finished",
        };
      }
      const projectDir = getProjectDir(options.cwd);
      const jsonlPath = path.join(projectDir, `${tab.cliSessionId}.jsonl`);
      const result = repairSession(jsonlPath);
      if (!result.success) return result;

      // Kill the existing transport so the next sendMessage spawns a fresh
      // process that --resumes against the cleaned file.
      restartTransport(tabId);

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

  // After Claude has been updated from the "needs an update" card: kill the
  // old process (it's still the old binary) so the next send spawns the new
  // one, mark the card done, and resend the message that failed. The resend
  // --resumes the same session, so nothing is lost. `cliPath` is passed when
  // the update moved Claude somewhere new.
  const retryFailedTurn = useCallback(
    (tabId: string, kind: "claudeUpdate" | "claudeSignIn", cliPath?: string): boolean => {
      if (cliPath) cliPathRef.current = cliPath;
      // The old process is stopped so the next send starts a fresh one. If
      // background agents are still working in it, that waits for them.
      const restart = () => restartTransport(tabId);

      const tab = stateRef.current.tabs.find((t) => t.id === tabId);
      if (!tab) {
        restart();
        return false;
      }
      const msgs = tab.messages;
      let failedAt = -1;
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i][kind]?.status === "needed") {
          failedAt = i;
          break;
        }
      }
      if (failedAt < 0) {
        whenIdle(tabId, restart);
        return false;
      }

      // Resend the user message that drew the error, in place of the failed
      // pair. Only when this tab is the one in view (sendMessage sends to the
      // active tab), and only a plain typed message: attachments were expanded
      // into content we no longer hold, and a failed compaction has no message
      // of its own. Otherwise the card just says it's done and to send again.
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

      const finish = () => {
      restart();
      setState((prev) => ({
        ...prev,
        tabs: prev.tabs.map((t) => {
          if (t.id !== tabId) return t;
          if (canResend) {
            return { ...t, messages: t.messages.filter((_, i) => i !== failedAt - 1 && i !== failedAt) };
          }
          return {
            ...t,
            messages: t.messages.map((m, i) =>
              i === failedAt && m[kind]
                ? { ...m, [kind]: { ...m[kind]!, status: "done" as const } }
                : m
            ),
          };
        }),
      }));
      if (canResend) {
        setTimeout(() => sendMessage(text, { displayText: prevUser!.displayText }), 0);
      }
      };
      whenIdle(tabId, finish);
      return canResend;
    },
    [sendMessage]
  );
  const retryAfterClaudeUpdate = useCallback(
    (tabId: string, cliPath?: string) => retryFailedTurn(tabId, "claudeUpdate", cliPath),
    [retryFailedTurn]
  );
  // After signing in again: the tab's process still holds the dead login, so
  // it's stopped and the failed message goes again on a fresh one.
  const retryAfterSignIn = useCallback(
    (tabId: string) => retryFailedTurn(tabId, "claudeSignIn"),
    [retryFailedTurn]
  );

  // ------- return -------

  const activeTab = state.tabs.find((t) => t.id === state.activeTabId);

  /** Background jobs still running in a tab (closing it would stop them). */
  const tabJobs = useCallback((tabId: string): BackgroundJob[] => jobList(jobsRef.current[tabId]), []);

  return {
    tabs: state.tabs,
    activeJobs: jobList(activeTab?.jobs),
    activeIsMain: !!activeTab?.isMain,
    tabJobs,
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
    retryAfterClaudeUpdate,
    retryAfterSignIn,
    pastSessions,
    openPastSession,
    refreshPastSessions,
    scrollRef,
    addVoiceCall,
  };
}
