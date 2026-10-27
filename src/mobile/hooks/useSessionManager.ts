import { debug } from "../debug";
import { addOutgoing, startQueued } from "../../send-queue";
import { turnStarted, queued as queuedElsewhere, permissionAnswered, replayBase, queueDropped, hasQueued } from "../../live-sync";
import { newStreamState, processContentBlocks, buildSnapshot, endTurn, startsTurnOfItsOwn, openReply, isInjectedContext, type StreamState } from "../../reply-stream";
import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import { GatewayTransport } from "../gateway-transport";
import { MAIN_CHAT_WIRE_ID, unexpectedExitNotice } from "../../session-owner";
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
import { isThinkingBlockApiError, type RepairResult } from "../session-repair";
import { generateConversationTitle } from "../title-generator";
import { parseClaudeUpdateError } from "../../models";
import { applyJobEvent, hasRunningJobs, jobAsking, jobList, maySwapProcess, IdleGate, type JobMap, type BackgroundJob } from "../../background-jobs";
import { appendedPrompt, withMainChatReminder, withMainChat, mainFirst, canCloseTab, canReorder, startupActive, MAIN_CHAT_TITLE } from "../../main-chat";
import { GatewayClient, HISTORY_TIMEOUT_MS } from "../gateway-client";
import { PendingOps, reconcileTabs, syncChanges, syncedSid, type OpenEntry } from "../../open-conversations";

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
  // Reasoning effort, as on the desktop (unset: the CLI's default).
  effort?: string;
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
  // Its history is on its way from the Mac ("Loading conversation…").
  loading?: boolean;
  // Where the loaded history starts among the conversation's messages: more
  // than 0 means there are older messages to load when scrolling up.
  historyOffset?: number;
  // Older messages are on their way.
  loadingOlder?: boolean;
  // Why the older messages couldn't be loaded.
  olderError?: string;
  // When a turn last started or ended here (epoch ms), for its Open row.
  lastActivity?: number;
  // The model, agent and permission mode above are the conversation's
  // process's own (reported by the Mac), not this device's defaults.
  infoKnown?: boolean;
  // Why its history couldn't be loaded, in plain words (shown with a retry).
  loadError?: string;
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
  /** Settings → Permission mode: what a new conversation starts in. */
  permissionMode?: string;
  /** How long opening a conversation waits for the Mac (tests shorten it). */
  historyTimeoutMs?: number;
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
          permissionMode: options.permissionMode || (options.askFirst === false ? "bypassPermissions" : "manual"),
          agent: options.agent || LOCKED_AGENT,
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
  // A conversation this phone starts begins in the phone's Ask first choice.
  // New conversations start in Settings → Permission mode, as on the desktop.
  const defaultMode = () => optionsRef.current.permissionMode || (optionsRef.current.askFirst === false ? "bypassPermissions" : "manual");
  // Messages sent while Claude is still answering, per tab, oldest first.
  // They show in the chat at once and go to Claude when the turn ends (see
  // send-queue.ts). turnRunningRef is set the moment a turn starts, so two
  // sends in the same tick can't both start one.
  // The Mac holds them now (session-owner.ts): they go to it at once and it
  // starts each when the turn before ends, on every device alike.
  const turnRunningRef = useRef<Record<string, boolean>>({});
  // Messages this phone sent, by the id they went to the Mac with.
  const localSendsRef = useRef(new Set<string>());
  // The turn under way on each tab was started here (only that view nudges
  // after a compaction or names the conversation, so it happens once).
  const ownTurnRef = useRef<Record<string, boolean>>({});
  // Tabs with unsent text in their message box: one closed on the Mac stays
  // open here until the box is empty (see isBusy).
  const draftsRef = useRef(new Set<string>());
  // Tabs whose history has been asked for and not yet answered.
  const requestedRef = useRef(new Set<string>());
  /** The turn on this tab ended. */
  const turnEnded = (tabId: string) => {
    turnRunningRef.current[tabId] = false;
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

  // ---- The shared open list (open-conversations.ts) ----
  // Which conversations are open is the Mac's list, pushed here whenever it
  // changes; what this phone is looking at is its own. Changes made here go
  // to the Mac numbered, and a list that arrives before the Mac has seen
  // them doesn't undo them on screen (PendingOps).
  const pendingRef = useRef(new PendingOps());
  const remoteRef = useRef<OpenEntry[] | null>(null);
  const [openList, setOpenList] = useState<OpenEntry[] | null>(null);
  const mainSid = () => (optionsRef.current.mainChat ? optionsRef.current.mainChatSessionId || undefined : undefined);
  const gateway = () => (optionsRef.current.gatewayUrl ? GatewayClient.get(optionsRef.current.gatewayUrl) : null);
  const tellMac = {
    open: (sid: string, title: string) => gateway()?.openAdd(sid, title, pendingRef.current.note(sid, "add")),
    close: (sid: string) => gateway()?.openRemove(sid, pendingRef.current.note(sid, "remove")),
    rename: (sid: string, title: string) => gateway()?.openRename(sid, title, pendingRef.current.note(sid, "rename")),
    replace: (oldSid: string, sid: string, title: string) => {
      pendingRef.current.note(oldSid, "remove");
      gateway()?.openReplace(oldSid, sid, title, pendingRef.current.note(sid, "add"));
    },
  };
  const isPinned = (sid: string | null | undefined) => !!sid && !!remoteRef.current?.some((e) => e.id === sid && e.pinned);

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
      const handle = (event: any): void => {
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

        // The conversation is shared live with other views (session-owner.ts):
        // a turn started anywhere, a message waiting, an answer given
        // elsewhere, or catching up on a turn already under way.
        const onTab = (fn: (t: TabSession) => TabSession) => setState((prev) => ({ ...prev, tabs: prev.tabs.map((t) => (t.id === tabId ? fn(t) : t)) }));
        if (event.type === "hyo_session_info") {
          // What the conversation's process really runs with: shown here,
          // whichever device started it or changed it.
          onTab((t) => ({
            ...t,
            infoKnown: true,
            ...(typeof event.permissionMode === "string" ? { permissionMode: event.permissionMode } : {}),
            ...(typeof event.effort === "string" && event.effort ? { effort: event.effort } : {}),
            ...(typeof event.model === "string" && event.model ? { model: event.model } : {}),
            ...(typeof event.agent === "string" ? { agent: event.agent } : {}),
          }));
          return;
        }
        if (event.type === "hyo_user_message" && event.silent) {
          // Claude was asked to carry on after a compaction: same reply, no message.
          turnRunningRef.current[tabId] = true;
          const ss0 = streamStatesRef.current[tabId];
          if (ss0) ss0.turnDone = false;
          updateTabLastAssistant(tabId, () => ({ streaming: true }));
          onTab((t) => ({ ...t, generating: true }));
          return;
        }
        if (event.type === "hyo_user_message") {
          const own = !!event.qid && localSendsRef.current.has(event.qid);
          const cur = stateRef.current.tabs.find((t) => t.id === tabId);
          const shown = !!event.qid && !!cur?.messages.some((m) => m.sendId === event.qid && !m.queuedId);
          ownTurnRef.current[tabId] = own;
          turnRunningRef.current[tabId] = true;
          // A message this view just sent already has its reply slot and
          // stream state; anything else starts a fresh one.
          if (!shown) streamStatesRef.current[tabId] = newStreamState();
          onTab((t) => ({ ...t, messages: turnStarted(t.messages, event).messages, generating: true, lastActivity: Date.now() }));
          return;
        }
        if (event.type === "hyo_queued") {
          onTab((t) => ({ ...t, messages: queuedElsewhere(t.messages, event) }));
          return;
        }
        if (event.type === "hyo_permission_answered") {
          onTab((t) => ({ ...t, messages: permissionAnswered(t.messages, event) }));
          return;
        }
        if (event.type === "hyo_queue_dropped") {
          onTab((t) => ({ ...t, messages: queueDropped(t.messages, event.qids || [], event.reason) }));
          return;
        }
        if (event.type === "hyo_replay") {
          // Opening the conversation mid-turn (or coming back to it): the
          // turn's reply is rebuilt from its events so far, then carries on live.
          const turn = event.turn;
          if (turn) {
            ownTurnRef.current[tabId] = !!turn.qid && localSendsRef.current.has(turn.qid);
            turnRunningRef.current[tabId] = true;
            streamStatesRef.current[tabId] = newStreamState();
            onTab((t) => ({ ...t, messages: replayBase(t.messages, turn), generating: true }));
            for (const e of turn.events || []) handle(e);
          }
          for (const q of event.queued || []) onTab((t) => ({ ...t, messages: queuedElsewhere(t.messages, q) }));
          if ((event.asks || []).length) {
            if (!streamStatesRef.current[tabId]) streamStatesRef.current[tabId] = { ...newStreamState(), turnDone: true };
            for (const e of event.asks) handle(e);
          }
          return;
        }
        if (event.type === "hyo_owner_refused") {
          updateTabLastAssistant(tabId, () => ({
            streaming: false,
            content: "_The main chat is already running in another copy of Obsidian on your computer. Use that one, or quit it and try again._",
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
          if (compactNudgeRef.current[tabId] && ownTurnRef.current[tabId] === true) {
            compactNudgeRef.current[tabId] = false;
            transportsRef.current[tabId]?.sendUserMessage("Please continue where you left off before the compaction.", optionsRef.current.askFirst, { silent: true });
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
                    lastActivity: Date.now(),
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
          // Named once, by the view whose message started the conversation.
          if (options.autoGenerateTitles && ownTurnRef.current[tabId]) {
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
          ownTurnRef.current[tabId] = false;
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
      return handle;
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
            permissionMode: defaultMode(),
            agent: optionsRef.current.agent || LOCKED_AGENT,
            voiceMode: false,
          },
        ],
        activeTabId: id,
      };
    });
  }, []);

  const closeTab = useCallback((tabIdToClose: string) => {
    // The main chat stays: it's the one conversation that's always there.
    const closing = stateRef.current.tabs.find((t) => t.id === tabIdToClose);
    if (!canCloseTab(closing)) return;
    // So does a pinned one, until it's unpinned.
    if (isPinned(closing?.cliSessionId)) return;
    const sid = closing ? syncedSid(closing, mainSid()) : null;
    if (sid) tellMac.close(sid);
    transportsRef.current[tabIdToClose]?.stop();
    delete transportsRef.current[tabIdToClose];
    delete streamStatesRef.current[tabIdToClose];
    delete jobsRef.current[tabIdToClose];
    draftsRef.current.delete(tabIdToClose);

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
              permissionMode: defaultMode(),
              agent: optionsRef.current.agent || LOCKED_AGENT,
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
    // The Mac's list (and so its tabs) takes the new title too.
    const sid = stateRef.current.tabs.find((t) => t.id === id)?.cliSessionId;
    if (sid && remoteRef.current?.some((e) => e.id === sid)) tellMac.rename(sid, title);
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
    if (remoteRef.current?.some((e) => e.id === sessionId)) tellMac.rename(sessionId, title);
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
      // Unpinning closes it everywhere, the way a close does, unless it's
      // the conversation in view here: then it stays open, as an ordinary
      // row. Told to the Mac before the pin itself, so it lands first.
      if (patch.pinned === false) {
        const inView = stateRef.current.tabs.find((t) => t.id === stateRef.current.activeTabId);
        if (inView?.cliSessionId === sessionId) tellMac.open(sessionId, inView.title);
        else tellMac.close(sessionId);
      }
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

  /**
   * The tab's connection to its conversation on the Mac: subscribed (by the
   * tab's id; the main chat's shared id) to the Mac's one process for it.
   * Registered before anything is asked for, so nothing the Mac sends for
   * the tab is missed.
   */
  function ensureTransport(tabId: string): GatewayTransport {
    const have = transportsRef.current[tabId];
    const currentTab = stateRef.current.tabs.find((t) => t.id === tabId);
    if (have) {
      if (currentTab?.cliSessionId && !currentTab.isMain) have.setSessionId(currentTab.cliSessionId);
      return have;
    }
    transportPromptRef.current[tabId] = promptFor(currentTab);
    if (!streamStatesRef.current[tabId]) streamStatesRef.current[tabId] = { ...newStreamState(), turnDone: true };
    const transport = new GatewayTransport({
      gatewayUrl: optionsRef.current.gatewayUrl,
      // The main chat joins the Mac's one process for it, by its shared id.
      tabId: currentTab?.isMain ? MAIN_CHAT_WIRE_ID : tabId,
      // The tab's own model: a reopened conversation carries on with the
      // one it was built on (and its context window), not the default. The
      // Mac only uses it if the phone is the one starting the process.
      model: currentTab?.model || optionsRef.current.model,
      agent: currentTab?.agent || optionsRef.current.agent,
      ...sessionSpawn(currentTab?.cliSessionId ?? null, currentTab?.sessionPending),
      appendSystemPrompt: promptFor(currentTab),
      onMessage: makeProcessEvent(tabId),
      onError: (error) => console.error("[hyo] Gateway error:", error),
      onClose: (code) => {
        if (transportsRef.current[tabId] !== transport) return;
        const wasGenerating = stateRef.current.tabs.find((t) => t.id === tabId)?.generating;
        // Its background agents ended with it.
        if (jobsRunning(tabId)) setJobs(tabId, {});
        setState((prev) => ({
          ...prev,
          tabs: prev.tabs.map((tab) => (tab.id === tabId ? { ...tab, generating: false } : tab)),
        }));
        turnEnded(tabId);
        updateTabLastAssistant(tabId, () => ({ streaming: false }));
        // A process that ended on its own mid-turn: say so. (One Hyo stopped
        // or swapped on purpose never gets here.)
        const notice = unexpectedExitNotice(code, !!wasGenerating);
        if (notice) {
          const errorMsg: Message = {
            role: "assistant",
            content: notice,
            thinking: "",
            toolCalls: [],
            orderedBlocks: [],
            streaming: false,
          };
          setState((prev) => ({
            ...prev,
            tabs: prev.tabs.map((tab) => (tab.id === tabId ? { ...tab, messages: [...tab.messages, errorMsg] } : tab)),
          }));
        }
      },
    });
    transport.spawn();
    transportsRef.current[tabId] = transport;
    return transport;
  }

  const sendMessage = useCallback(
    (
      content: string | any[],
      meta?: { displayText?: string; attachedFileNames?: string[]; isCompaction?: boolean; handoff?: boolean },
      opts?: { tabId?: string }
    ) => {
      const tabId = opts?.tabId ?? stateRef.current.activeTabId;
      let tab = stateRef.current.tabs.find((t) => t.id === tabId);
      if (!tab) return;
      const wasGenerating = !!turnRunningRef.current[tabId] || !!tab.generating || hasQueued(tab.messages);

      // A new conversation gets its id now, so its one process on the Mac
      // (and every view of it) is keyed by it from the first message.
      if (!tab.isMain && !tab.cliSessionId) {
        const minted = genId();
        tab = { ...tab, cliSessionId: minted, sessionPending: true };
        const patched = tab;
        stateRef.current = { ...stateRef.current, tabs: stateRef.current.tabs.map((t) => (t.id === tabId ? patched : t)) };
        setState((prev) => ({ ...prev, tabs: prev.tabs.map((t) => (t.id === tabId ? { ...t, cliSessionId: minted, sessionPending: true } : t)) }));
      }
      // Closed on the Mac while it was being typed in: sending opens it
      // everywhere again.
      const sid = tab.cliSessionId;
      if (sid && !tab.isMain && sid !== mainSid() && syncedRef.current.get(tabId) === sid && remoteRef.current && !remoteRef.current.some((e) => e.id === sid)) {
        tellMac.open(sid, tab.title);
      }

      // For display, use the typed text; for arrays (image messages) use displayText or placeholder
      const displayContent = typeof content === "string"
        ? (meta?.displayText ?? content)
        : (meta?.displayText ?? "");

      const qid = genId();
      localSendsRef.current.add(qid);
      const userMsg: Message = {
        role: "user",
        content: displayContent,
        displayText: meta?.displayText,
        attachments: meta?.attachedFileNames?.map((name) => ({ type: "file", name })),
        isCompaction: meta?.isCompaction,
        handoff: meta?.handoff,
        sendId: qid,
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

      // Claude is mid-turn: show it now, marked queued; the Mac sends it
      // when the turn ends, and every other view shows it waiting too.
      const queuedNow = wasGenerating && !meta?.isCompaction;
      if (!queuedNow) {
        turnRunningRef.current[tabId] = true;
        ownTurnRef.current[tabId] = true;
        streamStatesRef.current[tabId] = newStreamState();
      }
      setState((prev) => ({
        ...prev,
        tabs: prev.tabs.map((t) => {
          if (t.id !== tabId) return t;
          const titleText = meta?.displayText ?? (typeof content === "string" ? content : "");
          const title =
            t.messages.length === 0 && t.title === "New conversation"
              ? titleText.slice(0, 40) + (titleText.length > 40 ? "..." : "")
              : t.title;
          if (queuedNow) return { ...t, title, messages: addOutgoing(t.messages, userMsg, assistantMsg, true, qid) };
          // Compaction: don't add a user message — just the streaming assistant marker
          const newMessages = meta?.isCompaction ? [...t.messages, assistantMsg] : [...t.messages, userMsg, assistantMsg];
          return { ...t, title, messages: newMessages, generating: true, lastActivity: Date.now() };
        }),
      }));
      scrollRef.current.nearBottom = true;

      // Voice mode changes the persona, which goes with every message; the
      // Mac swaps the process between turns when it differs.
      transportPromptRef.current[tabId] = promptFor(tab);
      const transport = ensureTransport(tabId);
      transport.setAppendSystemPrompt(promptFor(tab));
      // The main chat's reminder rides on every message (never shown).
      // The conversation's permission mode goes with it (used if the phone
      // is the one starting its process; a running one keeps its own).
      const mode = tab.permissionMode || defaultMode();
      transport.sendUserMessage(tab.isMain && !meta?.isCompaction ? withMainChatReminder(content) : content, mode !== "bypassPermissions", { qid, permissionMode: mode, ...(tab.effort ? { effort: tab.effort } : {}) });
    },
    [options, makeProcessEvent, updateTabLastAssistant]
  );

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

  /**
   * The model for the conversation in view, as on the desktop: it carries on
   * on the new model (a fresh process on the Mac once nothing is running),
   * and every view shows it. A new conversation starts on it.
   */
  /** Reasoning effort for the conversation in view, as on the desktop. */
  const setTabEffort = useCallback((effort: string) => {
    const t = stateRef.current.tabs.find((x) => x.id === stateRef.current.activeTabId);
    if (t?.cliSessionId || t?.isMain) ensureTransport(t.id).setEffort(effort);
    setState((prev) => ({
      ...prev,
      tabs: prev.tabs.map((tab) => (tab.id === prev.activeTabId ? { ...tab, effort } : tab)),
    }));
  }, []);

  const setTabModel = useCallback((model: string) => {
    const t = stateRef.current.tabs.find((x) => x.id === stateRef.current.activeTabId);
    if (t?.cliSessionId || t?.isMain) ensureTransport(t.id).setModel(model);
    setState((prev) => ({
      ...prev,
      tabs: prev.tabs.map((tab) => (tab.id === prev.activeTabId ? { ...tab, model } : tab)),
    }));
  }, []);

  /**
   * A different agent, as on the desktop: a new conversation with it in
   * this tab (an agent is fixed for a conversation's life). Refused while
   * background jobs are running in the current one, which it would leave.
   */
  const setTabAgent = useCallback((agent: string): boolean => {
    const tabId = stateRef.current.activeTabId;
    if (jobsRunning(tabId)) return false;
    transportsRef.current[tabId]?.stop();
    delete transportsRef.current[tabId];
    delete streamStatesRef.current[tabId];
    setState((prev) => ({
      ...prev,
      tabs: prev.tabs.map((tab) => (tab.id === tabId ? { ...tab, agent, cliSessionId: null, infoKnown: false } : tab)),
    }));
    return true;
  }, []);

  const setTabPermissionMode = useCallback((permissionMode: string) => {
    // The conversation's mode: its process on the Mac takes it (every view
    // shows it). A new conversation starts in it with its first message.
    const t = stateRef.current.tabs.find((x) => x.id === stateRef.current.activeTabId);
    if (t?.cliSessionId || t?.isMain) ensureTransport(t.id).setPermissionMode(permissionMode);
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

  /** A tab for a saved conversation: open at once, its history on its way. */
  const sessionTabFor = (pastSession: Pick<PastSession, "id" | "title" | "callOnly">, like?: TabSession): TabSession => ({
    id: genId(),
    cliSessionId: pastSession.id,
    sessionPending: !!pastSession.callOnly,
    title: pastSession.title || "Untitled",
    messages: [],
    generating: false,
    model: like?.model || LOCKED_MODEL,
    permissionMode: defaultMode(),
    agent: optionsRef.current.agent || LOCKED_AGENT,
    inputTokens: 0,
    voiceMode: false,
    loading: true,
  });

  const openPastSession = useCallback((pastSession: PastSession) => {
    const existing = stateRef.current.tabs.find(
      (t) => t.cliSessionId === pastSession.id
    );
    if (existing) {
      setState((prev) => ({ ...prev, activeTabId: existing.id }));
      return;
    }

    // Open the tab immediately and switch to it — history is fetched from
    // the gateway asynchronously and back-filled once it arrives, with
    // "Loading conversation…" showing until then.
    const tab = sessionTabFor(pastSession, stateRef.current.tabs.find((t) => t.id === stateRef.current.activeTabId));
    setState((prev) => ({ tabs: [...prev.tabs, tab], activeTabId: tab.id }));
    // Opened on the Mac too (not the main chat, which is always there).
    if (pastSession.id !== mainSid()) tellMac.open(pastSession.id, tab.title);
    // Its history is fetched by the loader below, once the tab exists.
  }, [options.gatewayUrl]);

  /** History messages from the Mac, as chat messages. */
  const toChat = (history: { messages: any[] }): Message[] =>
    history.messages.map((m: any) => {
      // Hand-offs from a live call carry the marker in the prompt itself.
      const handoff = m.role === "user" && typeof m.content === "string" && m.content.includes(HANDOFF_MARKER);
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

  /**
   * One page of history with its voice calls threaded in where they started.
   * A call belongs to the page its position falls in (the newest page also
   * takes the ones after the last message).
   */
  const withCalls = (messages: Message[], calls: VoiceCallRecord[], offset: number, total: number): Message[] => {
    const end = offset + messages.length;
    const mine = (calls || []).filter((c) => c.after >= offset && (c.after < end || end >= total));
    return threadCalls(
      messages,
      mine.map((c) => ({ ...c, after: c.after - offset })),
      (call) => ({ role: "system" as const, content: "", streaming: false, voiceCall: mine.find((c) => c.id === call.id) || call })
    );
  };

  /** A request to the Mac that settles no matter what: its answer, its error, or ours after `ms`. */
  function settleWithin<T>(p: Promise<T>, ms: number, why: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(why)), ms);
      p.then(
        (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        (e) => {
          clearTimeout(timer);
          reject(e);
        }
      );
    });
  }

  /**
   * Fill an open tab with its conversation's history from the Mac: the newest
   * page first (older pages load when scrolling up). Asking for it also
   * subscribes the tab to the conversation, so a turn under way arrives right
   * after, live. The tab shows it's loading until then; if the Mac can't be
   * reached, or doesn't answer in time, it says so with a retry instead. It
   * always settles: the client's own timeout, and a second one here.
   */
  function backfill(id: string, sessionId: string) {
    const url = optionsRef.current.gatewayUrl;
    if (!url) return;
    requestedRef.current.add(id);
    setState((prev) => ({
      ...prev,
      tabs: prev.tabs.map((t) => (t.id === id ? { ...t, loading: true, loadError: undefined } : t)),
    }));
    // Listening before asking, so nothing the Mac sends right after is missed.
    const transport = ensureTransport(id);
    const wait = optionsRef.current.historyTimeoutMs ?? HISTORY_TIMEOUT_MS;
    settleWithin(
      loadSessionHistory(url, sessionId, { tabId: transport.wireId, timeoutMs: wait }),
      wait + 5000,
      "Your Mac didn't send it in time."
    )
      .then((history) => {
        const messages = withCalls(toChat(history), history.voiceCalls || [], history.offset, history.total);
        // Continue on the model the conversation was actually built with, rather
        // than the hardcoded mobile default. Resuming must not silently switch
        // models mid-conversation — and forcing a long conversation onto a
        // different model's context window is what caused "Prompt is too long".
        const inheritedModel = history.model || LOCKED_MODEL;
        setState((prev) => ({
          ...prev,
          tabs: prev.tabs.map((t) => {
            if (t.id !== id) return t;
            // Only if nothing has been said in it yet on this phone.
            if (t.messages.length > 0) return { ...t, loading: false, loadError: undefined };
            return { ...t, messages, model: inheritedModel, loading: false, loadError: undefined, historyOffset: history.offset };
          }),
        }));
      })
      .catch((e: any) => {
        const cause = e?.message || String(e);
        console.error("[hyo] Couldn't load the conversation:", cause);
        setState((prev) => ({
          ...prev,
          tabs: prev.tabs.map((t) => (t.id === id ? { ...t, loading: false, loadError: cause } : t)),
        }));
      })
      .finally(() => requestedRef.current.delete(id));
  }

  /** Try loading a conversation's history again (after it failed). */
  const retryLoad = useCallback((tabId: string) => {
    const t = stateRef.current.tabs.find((x) => x.id === tabId);
    if (t?.cliSessionId && !requestedRef.current.has(tabId)) backfill(t.id, t.cliSessionId);
  }, []);

  /** Scrolled to the top: load the page of messages before the ones shown. */
  const loadOlder = useCallback((tabId: string) => {
    const t = stateRef.current.tabs.find((x) => x.id === tabId);
    const url = optionsRef.current.gatewayUrl;
    if (!t?.cliSessionId || !url || t.loadingOlder || !t.historyOffset || t.historyOffset <= 0) return;
    const before = t.historyOffset;
    setState((prev) => ({ ...prev, tabs: prev.tabs.map((x) => (x.id === tabId ? { ...x, loadingOlder: true, olderError: undefined } : x)) }));
    settleWithin(
      loadSessionHistory(url, t.cliSessionId, { before }),
      HISTORY_TIMEOUT_MS + 5000,
      "Your Mac didn't send the earlier messages in time."
    )
      .then((page) => {
        const older = withCalls(toChat(page), page.voiceCalls || [], page.offset, page.total);
        setState((prev) => ({
          ...prev,
          tabs: prev.tabs.map((x) =>
            x.id !== tabId || x.historyOffset !== before
              ? x
              : { ...x, messages: [...older, ...x.messages], historyOffset: page.offset, loadingOlder: false }
          ),
        }));
      })
      .catch((e: any) => {
        const cause = e?.message || String(e);
        console.error("[hyo] Couldn't load earlier messages:", cause);
        setState((prev) => ({ ...prev, tabs: prev.tabs.map((x) => (x.id === tabId ? { ...x, loadingOlder: false, olderError: cause } : x)) }));
      });
  }, []);

  // Every tab waiting for its history has a request out for it. Tabs come
  // from several places (opening from History, the Mac's list, the main
  // chat, the desk restored at startup); asking here, after they exist, means
  // none is ever left on "Loading conversation…" with nothing asked.
  useEffect(() => {
    if (!options.gatewayUrl) return;
    for (const t of state.tabs) {
      if (t.loading && t.cliSessionId && !requestedRef.current.has(t.id)) backfill(t.id, t.cliSessionId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.tabs, options.gatewayUrl]);
  // Close a list's busy tabs only once their work is done.
  const isBusy = (t: TabSession) =>
    t.generating || jobsRunning(t.id) || !!turnRunningRef.current[t.id] || hasQueued(t.messages) || draftsRef.current.has(t.id);

  const blankTab = (): TabSession => ({
    id: genId(),
    cliSessionId: null,
    title: "New conversation",
    messages: [],
    generating: false,
    model: LOCKED_MODEL,
    permissionMode: defaultMode(),
    agent: optionsRef.current.agent || LOCKED_AGENT,
    inputTokens: 0,
    voiceMode: false,
  });

  /**
   * Bring this phone's tabs in line with an open list: the Mac's, or at
   * startup the one this phone last had. Never sent back to the Mac.
   */
  const applyOpenList = (entries: OpenEntry[], startup?: { activeId?: string | null }) => {
    const p = pendingRef.current;
    const done: { closed: TabSession[]; opened: TabSession[] } = { closed: [], opened: [] };
    setState((prev) => {
      const r = reconcileTabs(prev.tabs, prev.activeTabId, entries, (e) => sessionTabFor(e), blankTab, {
        mainSessionId: mainSid(),
        busy: isBusy,
        blocksClose: (sid) => p.blocksClose(sid),
        blocksOpen: (sid) => p.blocksOpen(sid),
        blocksRetitle: (sid) => p.blocksRetitle(sid),
      });
      done.closed = r.closed;
      done.opened = r.opened;
      if (!startup) return r.changed ? { tabs: r.tabs, activeTabId: r.activeTabId } : prev;
      // Opening Hyo: the pristine starter tab makes way for the desk.
      const restored = r.tabs.filter((t) => t.cliSessionId && !t.isMain);
      if (restored.length === 0) return r.changed ? { tabs: r.tabs, activeTabId: r.activeTabId } : prev;
      const tabs = r.tabs.filter((t) => t.isMain || t.cliSessionId || t.messages.length > 0);
      return { tabs, activeTabId: startupActive(tabs, startup.activeId) || tabs[tabs.length - 1].id };
    });
    // The updater has run by the next tick: stop hearing closed tabs. (The
    // ones just opened load their history from the loader effect.)
    setTimeout(() => {
      for (const t of done.closed) {
        transportsRef.current[t.id]?.stop();
        delete transportsRef.current[t.id];
        delete streamStatesRef.current[t.id];
        delete jobsRef.current[t.id];
        draftsRef.current.delete(t.id);
      }
    }, 0);
  };
  const applyOpenListRef = useRef(applyOpenList);
  applyOpenListRef.current = applyOpenList;

  // ---- Reopen the tabs from last time ---------------------------------------
  // The phone remembers the open list it last had (and which conversation it
  // was on) in this webview's localStorage, so the desk is there at once and
  // offline. The Mac's list, when it arrives, is the one that counts.
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
    // The Mac's list got here first: it's what's open.
    const entries: OpenEntry[] =
      remoteRef.current ?? (saved?.sessions || []).filter((s) => s?.id).map((s) => ({ id: s.id, title: s.title || "Untitled" }));
    if (!entries.length) return;
    applyOpenList(entries, { activeId: saved?.activeId });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options.gatewayUrl]);

  // Hear the Mac's list: now, after every reconnect (what was changed here
  // while offline goes first), and whenever it changes there.
  useEffect(() => {
    if (!options.gatewayUrl) return;
    const g = GatewayClient.get(options.gatewayUrl);
    const off = g.onOpenList((entries, meta) => {
      pendingRef.current.settle(meta);
      remoteRef.current = entries;
      setOpenList(entries);
      applyOpenListRef.current(entries);
    });
    const sync = () => g.openSync(pendingRef.current.sync());
    const offConnected = g.onConnected(sync);
    if (g.getStatus() === "connected") sync();
    return () => {
      off();
      offConnected();
    };
  }, [options.gatewayUrl]);

  // A close that waited on running work happens once the work is done; a
  // main chat switched on or off changes which conversation is the list's.
  const busyKey = state.tabs.filter(isBusy).map((t) => t.id).join(",");
  useEffect(() => {
    if (remoteRef.current) applyOpenListRef.current(remoteRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busyKey, options.mainChat, options.mainChatSessionId]);

  // Tell the Mac what changed here: a conversation that got its session id
  // (its first message, or a call), moved to a new one, or let go of one.
  // Opening from History and closing tell it themselves.
  const syncedRef = useRef(new Map<string, string | null>());
  useEffect(() => {
    const ch = syncChanges(syncedRef.current, state.tabs, mainSid());
    syncedRef.current = ch.next;
    for (const g of ch.gained) {
      if (g.oldSid) tellMac.replace(g.oldSid, g.sid, g.title);
      else tellMac.open(g.sid, g.title);
    }
    for (const sid of ch.cleared) tellMac.close(sid);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.tabs]);

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

  // A tab that's gone (closed here or by the shared list) stops hearing its
  // conversation. Worked out from the tabs themselves after each change,
  // rather than from inside a state update, which may not have run yet.
  useEffect(() => {
    const ids = new Set(state.tabs.map((t) => t.id));
    for (const id of Object.keys(transportsRef.current)) {
      if (ids.has(id)) continue;
      try {
        transportsRef.current[id]?.stop();
      } catch (e) {
        console.error("[hyo] Couldn't let go of a closed conversation:", e);
      }
      delete transportsRef.current[id];
      delete streamStatesRef.current[id];
      draftsRef.current.delete(id);
    }
  }, [state.tabs]);

  // The main chat listens from the moment it's open: what's said on the Mac
  // shows here as it happens, and a turn already running is picked up. (With
  // history to load, asking for it subscribes it; otherwise it attaches now.)
  useEffect(() => {
    if (!options.gatewayUrl) return;
    for (const t of state.tabs) {
      if (!t.isMain || transportsRef.current[t.id]) continue;
      const transport = ensureTransport(t.id);
      if (!t.loading) transport.attach();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.tabs, options.gatewayUrl]);
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
          permissionMode: defaultMode(),
          agent: optionsRef.current.agent || LOCKED_AGENT,
          inputTokens: 0,
          voiceMode: false,
          isMain: true,
          loading: !!sid,
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
    // Its history (if it has any) is fetched by the loader effect.
    void filled;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options.mainChat, options.gatewayUrl]);

  const compact = useCallback(() => {
    sendMessage("/compact", { isCompaction: true });
  }, [sendMessage]);

  // Recover a session poisoned by an orphaned `thinking` block (the result
  // of an output-cap mid-stream truncation): the Mac runs the desktop's own
  // repair on the file and restarts the conversation's process on it, then
  // the broken tail comes off here. Resolves with the result, as the
  // desktop's does, so the panel can prefill the message to send again.
  const recoverSession = useCallback(
    async (tabId: string): Promise<RepairResult> => {
      const tab = stateRef.current.tabs.find((t) => t.id === tabId);
      if (!tab?.cliSessionId) {
        return {
          success: false,
          linesRemoved: 0,
          capturedUserText: null,
          reason: "No session ID for this tab",
        };
      }
      const url = optionsRef.current.gatewayUrl;
      const result: RepairResult = url
        ? await GatewayClient.get(url).repairSession(tab.cliSessionId)
        : { success: false, linesRemoved: 0, capturedUserText: null, reason: "this phone isn't connected to a Mac" };
      if (!result.success) return result;
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
      // The tab keeps hearing the conversation throughout.
      const restart = () => {
        try {
          transportsRef.current[tabId]?.restartProcess();
        } catch (e) {
          console.error("[hyo] Couldn't ask the Mac to restart Claude:", e);
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

  /**
   * The message box of a tab has text in it (or not). A conversation closed
   * on the Mac stays open here while its box has text, so nothing typed is
   * lost; once the box is empty, the close goes ahead. Sending reopens it
   * everywhere instead.
   */
  const setDraft = useCallback((tabId: string, text: string) => {
    const has = !!text && !!text.trim();
    if (has === draftsRef.current.has(tabId)) return;
    if (has) draftsRef.current.add(tabId);
    else {
      draftsRef.current.delete(tabId);
      if (remoteRef.current) applyOpenListRef.current(remoteRef.current);
    }
  }, []);

  // The conversation in view was closed on the Mac, and stays here only
  // because there's text in its box.
  const activeSid = activeTab && !activeTab.isMain ? activeTab.cliSessionId : null;
  const activeClosedElsewhere =
    !!activeSid &&
    activeSid !== mainSid() &&
    !!openList &&
    syncedRef.current.get(activeTab!.id) === activeSid &&
    !openList.some((e) => e.id === activeSid) &&
    !pendingRef.current.blocksClose(activeSid);

  // What each open conversation's row shows when this phone hasn't loaded it
  // yet: its last line and when it was last active, from the Mac.
  const openHints = useMemo(() => {
    const m: Record<string, { peek?: string; lastActive?: number }> = {};
    for (const e of openList || []) if (e.peek || e.lastActive) m[e.id] = { peek: e.peek, lastActive: e.lastActive };
    return m;
  }, [openList]);

  /** Background jobs still running in a tab (closing it would stop them). */
  const tabJobs = useCallback((tabId: string): BackgroundJob[] => jobList(jobsRef.current[tabId]), []);

  // Pinned conversations, from the Mac's list (null until it's heard from:
  // the session metadata's pins are used instead).
  const pinnedSessionIds = useMemo(
    () => (openList ? new Set(openList.filter((e) => e.pinned).map((e) => e.id)) : null),
    [openList]
  );

  return {
    setDraft,
    activeClosedElsewhere,
    openHints,
    loadOlder,
    activeHasOlder: (activeTab?.historyOffset ?? 0) > 0,
    activeLoadingOlder: !!activeTab?.loadingOlder,
    activeOlderError: activeTab?.olderError || null,
    pinnedSessionIds,
    activeLoading: !!activeTab?.loading,
    activeLoadError: activeTab?.loadError || null,
    retryLoad,
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
    activePermissionMode: activeTab?.permissionMode || defaultMode(),
    activeInfoKnown: !!activeTab?.infoKnown,
    setTabModel,
    setTabAgent,
    setTabEffort,
    activeEffort: activeTab?.effort || "",
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
