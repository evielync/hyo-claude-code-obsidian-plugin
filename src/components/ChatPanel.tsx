import React, { useRef, useState, useCallback, useEffect, useMemo } from "react";
import { resolveWorkingDirectory } from "../working-directory";
import type { App } from "obsidian";
import { Notice } from "obsidian";
import { ChatMessages } from "./ChatMessages";
import { ConversationSwitcher } from "./ConversationSwitcher";
import { searchSessionText, transcriptLastWrite } from "../session-parser";
import { buildTaskList, type BoardTask, type OpenHint } from "../task-state";
import type { TaskMeta } from "../settings";
import { HyoStatusBar } from "./HyoStatusBar";
import { ReleaseCard } from "./ReleaseCard";
import { ReleaseNotes } from "./ReleaseNotes";
import { MODEL_OPTIONS, claudeUpdateNeeded } from "../models";
import { ClaudeUpdateCard, type ClaudeUpdateRunner } from "./ClaudeUpdateCard";
import type { ClaudeSignInRunner } from "./ClaudeSignInCard";
import type { CodeNeeded } from "../cli-probe";
import { debug } from "../debug";
import { CallBar } from "./CallBar";
import { BackgroundJobs } from "./BackgroundJobs";
import { SendButton, sendButtonMode } from "./SendButton";
import { VoiceCallSheet } from "./VoiceCallLine";
import type { AskQuestionData } from "../hooks/useChatEngine";
import type { useSessionManager } from "../hooks/useSessionManager";
import { useVoiceMode } from "../hooks/useVoiceMode";
import { parseVoiceResponse, lastSentenceBoundary, HANDOFF_NOTE } from "../voice/voice-persona";
import { ensureVoiceAssets } from "../voice/voice-assets";
import { describeStep, attentionLine } from "../voice/voice-words";
import {
  unseenTurnsBlock,
  takeUnseenTurns,
  ShownErrors,
  claudeMessageCount,
  placeAtHangUp,
  type VoiceCallRecord,
} from "../voice/voice-call";
import { readAgentIdentity } from "../voice/gpt-live";
import { resolveLiveVoice } from "../voice/live-voice";
import { useSkills, type Skill } from "../hooks/useSkills";
import { withBundledSkills } from "../bundled-skills";
import type HyoPlugin from "../main";
import {
  estimateTokens,
  formatTokens,
  shouldInline,
  writeAttachmentToDisk,
} from "../attachments";
import { Platform } from "obsidian";
// Node built-in; deferred so this module loads on mobile.
const path: typeof import("path") = Platform.isMobile ? (undefined as any) : require("path");

interface AttachedFile {
  name: string;
  fileType: "text" | "image" | "pdf";
  content?: string;       // text files
  mediaType?: string;     // image files / pdf
  data?: string;          // image files / pdf — base64
  vaultPath?: string;     // vault-relative path (only set for "Attach current file")
}

interface ChatPanelProps {
  sessionManager: ReturnType<typeof useSessionManager>;
  plugin: HyoPlugin;
  app: App;
  /** What `claude --version` reported at detection, for the update banner. */
  claudeVersion?: string;
  /** Updates Claude in the background; returns the new path if it moved. */
  onUpdateClaude?: (
    required: string,
    onPhase: (m: string) => void
  ) => Promise<{ ok: boolean; error?: string; cliPath?: string }>;
  /** Signs Claude in again in the background. Desktop only. */
  onSignInClaude?: (
    onPhase: (m: string) => void,
    onCodeNeeded: CodeNeeded
  ) => Promise<{ ok: boolean; error?: string }>;
}

// A short two-note chime so a permission ask is noticeable when she's not
// looking at the screen. Synthesised (no asset to ship).
function playPermissionChime() {
  try {
    const Ctx =
      window.AudioContext || (window as unknown as any).webkitAudioContext;
    const ctx = new Ctx();
    const t0 = ctx.currentTime;
    for (const [freq, at] of [
      [660, 0],
      [988, 0.15],
    ] as [number, number][]) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, t0 + at);
      gain.gain.linearRampToValueAtTime(0.18, t0 + at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, t0 + at + 0.18);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(t0 + at);
      osc.stop(t0 + at + 0.2);
    }
    setTimeout(() => void ctx.close().catch(() => {}), 700);
  } catch {
    /* audio not available — no-op */
  }
}

export function ChatPanel({ sessionManager, plugin, app, claudeVersion, onUpdateClaude, onSignInClaude }: ChatPanelProps) {
  // Release card: shown when the installed version is newer than the last one
  // acknowledged. A blank lastSeenVersion means a fresh install, which gets no
  // card — nobody needs release notes for a version they never ran.
  const currentVersion = plugin.manifest.version;
  const [showReleaseCard, setShowReleaseCard] = useState(
    () => !!plugin.settings.lastSeenVersion &&
          plugin.settings.lastSeenVersion !== currentVersion
  );
  const [showReleaseNotes, setShowReleaseNotes] = useState(false);

  const dismissReleaseCard = useCallback(() => {
    setShowReleaseCard(false);
    plugin.settings.lastSeenVersion = currentVersion;
    void plugin.saveData(plugin.settings);
  }, [plugin, currentVersion]);

  // A fresh install still records the version, so the first real update shows
  // a card instead of being swallowed by the blank-version check above.
  useEffect(() => {
    if (!plugin.settings.lastSeenVersion) {
      plugin.settings.lastSeenVersion = currentVersion;
      void plugin.saveData(plugin.settings);
    }
  }, [plugin, currentVersion]);

  const {
    tabs,
    activeTabId,
    activeMessages,
    activeGenerating,
    activeModel,
    activeEffort,
    activePermissionMode,
    activeAgent,
    activeVoiceMode,
    activeTabHasSession,
    activeInputTokens,
    activeContextWindow,
    newTab,
    closeTab,
    switchTab,
    renameTab,
    setTaskMeta,
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
    activeJobs,
    tabJobs,
    pinnedSessionIds,
    setDraft,
    activeClosedElsewhere,
  } = sessionManager;

  // Closing a conversation only takes it off the Open list. Its Claude
  // process lives on the Mac (session-owner.ts): a turn or background job
  // still running carries on, and is in History when it's done.
  const closeTabSafely = closeTab;
  void tabJobs;

  // A different agent needs a fresh Claude process, which would stop the
  // background jobs still working in this one.
  const switchAgent = useCallback(
    (agent: string) => {
      if (!setTabAgent(agent)) {
        new Notice("Background jobs are still running in this conversation. Switch agents once they've finished.", 6000);
      }
    },
    [setTabAgent]
  );

  // ---- Conversations: the bar's panel (Open + History) ----
  // Pinned / closed live in the shared session metadata (not the plugin's
  // local data.json), so the state is the same on every device. The map
  // buildTaskList wants is derived from the loaded sessions; writes go through
  // the session manager, which persists to that metadata and refreshes.
  const taskMeta = useMemo(() => {
    const m: Record<string, TaskMeta> = {};
    for (const s of pastSessions) {
      m[s.id] = {
        pinned: s.pinned,
        closed: s.closed,
        lastActive: s.lastActiveMeta,
        title: s.title,
      };
    }
    // Pins as the shared open list has them (it's what puts them in Open),
    // so a pin made on the other device shows here straight away.
    if (pinnedSessionIds) {
      for (const id of Object.keys(m)) m[id] = { ...m[id], pinned: pinnedSessionIds.has(id) };
      for (const id of pinnedSessionIds) if (!m[id]) m[id] = { pinned: true };
    }
    return m;
  }, [pastSessions, pinnedSessionIds]);

  // History only loads the newest 150 transcripts, so an open conversation
  // that's gone quiet can fall outside it. Read its transcript's last write
  // directly so its time is real.
  const openHints = useMemo(() => {
    const cwd = resolveWorkingDirectory(plugin.settings.workingDirectory, (app.vault.adapter as any).basePath as string);
    const loaded = new Set(pastSessions.map((p) => p.id));
    const hints: Record<string, OpenHint> = {};
    for (const t of tabs) {
      if (!t.cliSessionId || loaded.has(t.cliSessionId)) continue;
      const at = transcriptLastWrite(cwd, t.cliSessionId);
      if (at) hints[t.cliSessionId] = { lastActive: at };
    }
    return hints;
  }, [tabs, pastSessions, plugin.settings.workingDirectory, app]);

  const boardTasks = useMemo(
    () => buildTaskList(tabs, pastSessions, taskMeta, Date.now(), openHints),
    [tabs, pastSessions, taskMeta, openHints]
  );
  const tabIds = useMemo(() => tabs.map((t) => t.id), [tabs]);

  // Open a task: switch to its tab if open, otherwise resume it as a new tab.
  // Opening a closed conversation reopens it (clears the closed flag).
  const handleOpenTask = useCallback(
    (task: BoardTask) => {
      if (task.closed && task.cliSessionId)
        setTaskMeta(task.cliSessionId, { closed: false });
      if (task.tabId) switchTab(task.tabId);
      else if (task.past) openPastSession(task.past);
    },
    [switchTab, openPastSession, setTaskMeta]
  );

  const handleTogglePin = useCallback(
    (task: BoardTask) => {
      if (task.cliSessionId)
        setTaskMeta(task.cliSessionId, { pinned: !task.pinned });
    },
    [setTaskMeta]
  );

  const activeTabIdRef = useRef(activeTabId);
  activeTabIdRef.current = activeTabId;
  const activeAgentRef = useRef(activeAgent);
  activeAgentRef.current = activeAgent;
  const [inputValues, setInputValues] = useState<Record<string, string>>({});
  const inputValue = inputValues[activeTabId] ?? "";
  // Which tabs have unsent text: a conversation closed on another device
  // stays open here while its box has text (see setDraft).
  useEffect(() => {
    for (const [tabId, text] of Object.entries(inputValues)) setDraft(tabId, text);
  }, [inputValues, setDraft]);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [attachedFilesMap, setAttachedFilesMap] = useState<Record<string, AttachedFile[]>>({});
  const attachedFiles = attachedFilesMap[activeTabId] ?? [];
  const [attachPopupOpen, setAttachPopupOpen] = useState(false);
  const attachBtnRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  // Auto-detect skills from working directory
  const vaultPath = (app.vault.adapter as any).basePath as string;
  const workingDirectory = resolveWorkingDirectory(plugin.settings.workingDirectory, vaultPath);

  // Where large file attachments get written. Inside the plugin's own folder
  // so Obsidian keeps it tidy and Claude's Read tool can access absolute paths.
  const attachmentsDir = useMemo(
    () => path.join(vaultPath, plugin.manifest.dir || "", "attachments"),
    [vaultPath, plugin.manifest.dir]
  );

  // Voice mode
  const voiceEngine = plugin.settings.voiceEngine || "elevenlabs";
  const hasVoiceApiKey =
    voiceEngine === "gpt-live"
      ? !!plugin.settings.openAiApiKey
      : !!plugin.settings.elevenLabsApiKey;
  // A permission answered on screen during a call: the voice is told
  // silently, so Ev doesn't have to say "done" (which became a second job).
  const notifyPermRef = useRef<(allowed: boolean) => void>(() => {});
  const answerPermission = useCallback(
    (requestId: string, behavior: "allow" | "allow_always" | "deny") => {
      sendPermissionResponse(requestId, behavior);
      notifyPermRef.current(behavior !== "deny");
    },
    [sendPermissionResponse]
  );
  // The tab the current call is in (the tab bar is hidden during a call).
  const callTabIdRef = useRef<string | null>(null);
  // Errors Hyo shows in the call's chat: told to the voice as they appear,
  // and to Claude with the next thing sent, since neither sees the chat.
  const shownErrorsRef = useRef(new ShownErrors());
  const activeMessagesRef = useRef(activeMessages);
  activeMessagesRef.current = activeMessages;
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const currentCallRef = useRef<() => VoiceCallRecord | null>(() => null);
  // Whatever goes to Claude next carries the spoken turns it hasn't heard:
  // from the call that's on now and from finished calls in this
  // conversation, even after a reopen. The finished records are saved with
  // their new "seen" mark.
  const sendToClaude = useCallback(
    (content: string | any[], meta?: { displayText?: string; attachedFileNames?: string[]; handoff?: boolean }) => {
      const tabId = activeTabIdRef.current;
      const current = callTabIdRef.current === tabId ? currentCallRef.current() : null;
      const { turns, advanced } = takeUnseenTurns(activeMessagesRef.current, current);
      for (const rec of advanced) if (rec !== current) addVoiceCall(tabId, { ...rec });
      const errors = callTabIdRef.current === tabId ? shownErrorsRef.current.forClaude() : "";
      const prefix = [errors, unseenTurnsBlock(turns)].filter(Boolean).join("\n\n");
      if (!prefix) return sendMessage(content, meta);
      if (typeof content === "string") {
        return sendMessage(`${prefix}\n\n${content}`, { ...meta, displayText: meta?.displayText ?? content });
      }
      return sendMessage([{ type: "text", text: prefix }, ...content], meta);
    },
    [sendMessage, addVoiceCall]
  );

  // What was said on the call. GPT-Live: a hand-off — Claude's message shows
  // the request marked "Asked on the call" and its reply shows in full.
  // ElevenLabs: Claude IS the voice, so it's an ordinary message.
  const recordTurnRef = useRef<(side: "user" | "agent", text: string) => void>(() => {});
  // ElevenLabs: what she said goes to Claude as an ordinary message (Claude
  // IS the voice). GPT-Live jobs come through onLiveHandoff instead.
  const handleTranscript = useCallback(
    (text: string) => {
      recordTurnRef.current("user", text);
      sendToClaude(text);
    },
    [sendToClaude]
  );
  // A job from the live call: the whole request, built from everything she
  // said since the last job (voice/voice-call.ts handoffTask).
  const onLiveHandoff = useCallback(
    (prompt: string, said: string) => sendToClaude(prompt, { displayText: said, handoff: true }),
    [sendToClaude]
  );
  // Base URL for the bundled Silero/ORT model assets, served from the plugin
  // folder via Obsidian's resource-path scheme (strip the cache token, keep a
  // trailing slash so vad-web/ort can append filenames).
  const vadAssetBase = useMemo(() => {
    try {
      const rel = `${plugin.manifest.dir}/vad-assets`;
      const url = (app.vault.adapter as any).getResourcePath(rel) as string;
      return url.split("?")[0].replace(/\/?$/, "/");
    } catch {
      return "";
    }
  }, [plugin.manifest.dir, app.vault.adapter]);
  // What a GPT-Live call starts out knowing: the personality paragraph from
  // settings and the open conversation. Read through a ref at call start so
  // the hook's identity doesn't churn every render.
  const getLiveContext = useCallback(() => {
    const messages = activeMessagesRef.current;
    return {
      agent: activeAgentRef.current || plugin.settings.defaultAgent || "",
      personality: plugin.settings.voicePersonality,
      messages,
      after: claudeMessageCount(messages),
    };
  }, [plugin]);

  // About you, read fresh at each call: the chosen note if there is one,
  // else the typed text. It goes into the voice's starting instructions.
  const getAboutYou = useCallback(() => plugin.readAboutYou(), [plugin]);

  // A call ended: its one line goes into the thread where it started, and is
  // saved. If it dropped (not hung up), leave voice mode so the bar goes.
  const onCallEnded = useCallback(
    (record: VoiceCallRecord | null, reason: string) => {
      const tabId = callTabIdRef.current;
      if (record && tabId) {
        const tab = tabsRef.current.find((t) => t.id === tabId);
        // The line goes where the call ended, after the work done on it.
        placeAtHangUp(record, tab?.messages || []);
        addVoiceCall(tabId, record);
      }
      if (reason !== "hung-up") {
        const tab = tabsRef.current.find((t) => t.id === tabId);
        if (tab?.voiceMode && tabId === activeTabIdRef.current) toggleVoiceMode();
      }
    },
    [addVoiceCall, toggleVoiceMode]
  );

  const voiceMode = useVoiceMode({
    engine: voiceEngine,
    apiKey: plugin.settings.elevenLabsApiKey,
    voiceId: plugin.settings.voiceId,
    playbackSpeed: plugin.settings.voicePlaybackSpeed,
    isVoiceMode: activeVoiceMode,
    autoSpeak: plugin.settings.voiceAutoSpeak,
    onTranscript: handleTranscript,
    vadAssetBase,
    ensureAssets: useCallback(
      () => ensureVoiceAssets(app, plugin.manifest.dir || ""),
      [app, plugin.manifest.dir]
    ),
    openAiApiKey: plugin.settings.openAiApiKey,
    ...(() => {
      const v = resolveLiveVoice(plugin.settings.gptLiveVoice, plugin.settings.gptLiveCustomVoices);
      return { gptLiveVoice: v.voice, gptLiveVoiceDescription: v.description };
    })(),
    getAboutYou,
    getLiveContext,
    onCallEnded,
    onLiveHandoff,
    debugLog: !!plugin.settings.voiceDebugLog,
  });
  recordTurnRef.current = voiceMode.recordTurn;
  currentCallRef.current = voiceMode.currentCall;
  notifyPermRef.current = voiceMode.notifyPermissionAnswered;

  // A call is on in this tab: the call bar sits over the chat.
  const inVoiceView = activeVoiceMode && hasVoiceApiKey;
  // The transcript sheet for a tapped call line.
  const [openCall, setOpenCall] = useState<VoiceCallRecord | null>(null);
  useEffect(() => setOpenCall(null), [activeTabId]);
  const agentName = useMemo(() => {
    const a = activeAgent || plugin.settings.defaultAgent || "";
    return readAgentIdentity(a)?.name || "Agent";
  }, [activeAgent, plugin.settings.defaultAgent]);
  const openVoiceSettings = useCallback(() => {
    const setting = (app as any).setting;
    if (!setting) return;
    setting.open();
    setting.openTabById?.(plugin.manifest.id);
  }, [app, plugin.manifest.id]);

  // Claude updates, from the in-message card or the banner. After a good
  // update the tab's old process is killed (it's still the old binary) and the
  // failed message, if there is one, goes again.
  const runClaudeUpdate = useMemo<ClaudeUpdateRunner | undefined>(() => {
    if (!onUpdateClaude) return undefined;
    return async (required, onPhase) => {
      const tabId = activeTabId;
      const r = await onUpdateClaude(required, onPhase);
      if (!r.ok) return r;
      const resent = retryAfterClaudeUpdate(tabId, r.cliPath);
      return { ok: true, resent };
    };
  }, [onUpdateClaude, activeTabId, retryAfterClaudeUpdate]);

  // Sign-in from the in-message card. After a good sign-in the tab's process
  // (still holding the expired login) is stopped and the failed message goes
  // again.
  const runClaudeSignIn = useMemo<ClaudeSignInRunner | undefined>(() => {
    if (!onSignInClaude) return undefined;
    return async (onPhase, onCodeNeeded) => {
      const tabId = activeTabId;
      const r = await onSignInClaude(onPhase, onCodeNeeded);
      if (!r.ok) return r;
      const resent = retryAfterSignIn(tabId);
      return { ok: true, resent };
    };
  }, [onSignInClaude, activeTabId, retryAfterSignIn]);

  // Startup check: the installed Claude is older than the selected model
  // needs. Offered as a banner before the first message fails, never a block.
  // Dismissal holds for this model and version, so switching to another model
  // that needs an update still gets told.
  const updateRequired = claudeUpdateNeeded(activeModel, claudeVersion);
  const updateKey = `${activeModel}@${claudeVersion}`;
  const [dismissedUpdateKey, setDismissedUpdateKey] = useState<string | null>(null);
  // A failed message in this tab already carries the same card, so the banner
  // steps aside rather than offering the update twice.
  const cardInThread = activeMessages.some((m) => m.claudeUpdate?.status === "needed");
  const showUpdateBanner = !!updateRequired && dismissedUpdateKey !== updateKey && !cardInThread;
  const prevPermIdRef = useRef<string | null>(null);

  // Start the hands-free mic loop when the voice view is open, stop when it
  // closes. Refs so identity churn in the hook can't restart the mic each
  // render — the effect only fires on the view opening/closing.
  const startConvRef = useRef(voiceMode.startConversation);
  const stopConvRef = useRef(voiceMode.stopConversation);
  startConvRef.current = voiceMode.startConversation;
  stopConvRef.current = voiceMode.stopConversation;
  const [callStartedAt, setCallStartedAt] = useState<number | null>(null);
  useEffect(() => {
    if (!inVoiceView) return;
    callTabIdRef.current = activeTabIdRef.current;
    setCallStartedAt(Date.now());
    void startConvRef.current();
    return () => {
      stopConvRef.current();
      setCallStartedAt(null);
    };
  }, [inVoiceView]);

  // An error shown in the call's chat (the process ended, Claude couldn't
  // start, an API error): the voice hears what it said straight away, and
  // Claude gets it with the next message (sendToClaude). Errors already in
  // the chat when the call started aren't news.
  useEffect(() => {
    if (callStartedAt) shownErrorsRef.current.begin(activeMessagesRef.current);
  }, [callStartedAt]);
  const { notifyErrorShown } = voiceMode;
  useEffect(() => {
    if (!callStartedAt || activeTabId !== callTabIdRef.current) return;
    for (const text of shownErrorsRef.current.take(activeMessages)) notifyErrorShown(text);
  }, [activeMessages, activeTabId, callStartedAt, notifyErrorShown]);

  // Half-duplex: the loop stays muted while Chad is generating.
  const { setBusy: setVoiceBusy } = voiceMode;
  useEffect(() => {
    setVoiceBusy(activeGenerating);
  }, [activeGenerating, setVoiceBusy]);

  // AI Commands seam: expose `runCommand` so an external trigger (the AI
  // Commands companion plugin) can open a new chat pre-loaded with a prompt
  // and note. The prompt is queued, a fresh tab is opened, and the queued
  // text is flushed once that tab becomes active. See main.ts.
  const pendingCommandPromptRef = useRef<string | null>(null);
  // The tab that was active when the command fired. The flush below waits for
  // a different tab to be active: when the panel is mounting (Hyo was closed
  // when the command fired) this effect and the flush effect run in the same
  // pass, before newTab() has applied, so flushing on the first pass would send
  // the prompt into the tab that was already there and the new tab would sit
  // empty.
  const pendingCommandFromTabRef = useRef<string | null>(null);
  useEffect(() => {
    const run = (prompt: string, notePath?: string) => {
      let text = prompt;
      if (notePath) {
        text += `\n\nUse the note at \`${notePath}\` as the source for this task.`;
      }
      pendingCommandPromptRef.current = text;
      pendingCommandFromTabRef.current = activeTabIdRef.current;
      newTab();
    };
    plugin.runCommand = run;
    if (plugin.pendingCommand) {
      const c = plugin.pendingCommand;
      plugin.pendingCommand = null;
      run(c.prompt, c.notePath);
    }
    return () => {
      if (plugin.runCommand === run) plugin.runCommand = null;
    };
  }, [newTab, plugin]);

  useEffect(() => {
    if (pendingCommandPromptRef.current && activeTabId !== pendingCommandFromTabRef.current) {
      const text = pendingCommandPromptRef.current;
      pendingCommandPromptRef.current = null;
      pendingCommandFromTabRef.current = null;
      sendMessage(text);
    }
  }, [activeTabId, sendMessage]);

  // Speak Chad's reply AS IT STREAMS (ElevenLabs). On each streamed update we
  // take the conversational text so far (with [SCREEN] detail stripped —
  // that's shown, not spoken), and speak whatever complete sentences are new
  // since last time. On finish we flush the trailing bit.
  // GPT-Live: the voice gets Claude's finished reply once (finishReply).
  const prevGeneratingRef = useRef(activeGenerating);
  const prevTabIdRef = useRef(activeTabId);
  // The text we've already spoken this turn — tracked as a string (not a char
  // offset) so it stays aligned even when the reply arrives partly streamed and
  // partly as a completed message that REPLACES the content.
  const spokenSoFarRef = useRef("");
  const speakTurnRef = useRef(-1);
  const { enqueueSpeech, stopAudio, finishReply } = voiceMode;
  useEffect(() => {
    const tabChanged = prevTabIdRef.current !== activeTabId;
    const startedGenerating = !prevGeneratingRef.current && activeGenerating;
    const finishedGenerating = prevGeneratingRef.current && !activeGenerating;
    prevGeneratingRef.current = activeGenerating;
    prevTabIdRef.current = activeTabId;
    if (tabChanged || !activeVoiceMode) return;

    // Index of the assistant message this turn is about.
    let idx = -1;
    for (let i = activeMessages.length - 1; i >= 0; i--) {
      const m = activeMessages[i];
      if (m.role === "assistant" && !m.isCompaction && !m.voiceCall) {
        idx = i;
        break;
      }
    }
    if (idx === -1) return;

    if (voiceMode.isLive) {
      if (finishedGenerating && speakTurnRef.current !== idx) {
        speakTurnRef.current = idx;
        finishReply(activeMessages[idx].content || "", !!activeMessages[idx].selfStarted);
      }
      return;
    }
    if (!plugin.settings.voiceAutoSpeak) return;
    // A new turn interrupts any speech still playing from the last one.
    if (startedGenerating) {
      stopAudio();
      spokenSoFarRef.current = "";
    }
    if (speakTurnRef.current !== idx) {
      speakTurnRef.current = idx;
      spokenSoFarRef.current = "";
    }
    const spoken = parseVoiceResponse(activeMessages[idx].content || "").spoken;
    // Re-anchor: how much of the current text have we already spoken?
    const prev = spokenSoFarRef.current;
    const max = Math.min(prev.length, spoken.length);
    let base = 0;
    while (base < max && prev[base] === spoken[base]) base++;
    const remainder = spoken.slice(base);
    // While streaming, only speak up to the last complete sentence; on
    // finish, flush everything that's left.
    const cut = finishedGenerating ? remainder.length : lastSentenceBoundary(remainder) + 1;
    if (cut > 0) {
      const chunk = remainder.slice(0, cut).trim();
      if (chunk) enqueueSpeech(chunk);
      spokenSoFarRef.current = spoken.slice(0, base + cut);
    }
    if (finishedGenerating && spoken.trim()) voiceMode.recordTurn("agent", spoken);
  }, [
    activeGenerating,
    activeVoiceMode,
    activeMessages,
    activeTabId,
    enqueueSpeech,
    stopAudio,
    finishReply,
    plugin.settings.voiceAutoSpeak,
    voiceMode.isLive,
    voiceMode.recordTurn,
  ]);

  // Stop audio when switching or closing tabs
  useEffect(() => {
    voiceMode.stopAudio();
  }, [activeTabId]);

  // Slash command state (checks both .claude/skills and skills/)
  const skills = useSkills(workingDirectory);

  // Full-text search for the history screen — reads the session files off
  // disk, scoped to the sessions already in the list.
  const searchPastText = useCallback(
    async (query: string) =>
      searchSessionText(
        workingDirectory,
        pastSessions.map((s) => s.id),
        query
      ),
    [workingDirectory, pastSessions]
  );
  const [slashMenuOpen, setSlashMenuOpen] = useState(false);
  const [slashFilter, setSlashFilter] = useState("");
  const [slashSelectedIdx, setSlashSelectedIdx] = useState(0);
  const slashMenuRef = useRef<HTMLDivElement>(null);

  // Built-in CLI commands the CLI actually honours over stream-json. Verified
  // one by one against the CLI rather than taken from its full command list:
  // /status, /memory and /skills refuse outright ("isn't available in this
  // environment"), and /doctor is worse — it falls through to the model, which
  // invents a plausible health check.
  //
  // /mcp is left out for a different reason: the status read works, but its own
  // reply instructs the user to "Reply /mcp reconnect all here to retry", and
  // that subcommand fails with "MCP controls aren't available right now". We
  // can't edit the CLI's output, so listing it means advertising a dead end.
  const BUILTIN_COMMANDS = useMemo(() => [
    { name: "compact", description: "Summarise and compress conversation history", builtin: true },
    { name: "context", description: "Show current context window usage breakdown", builtin: true },
    { name: "usage", description: "Your plan limits — session, weekly, and Fable", builtin: true },
    { name: "cost", description: "What this conversation has cost so far", builtin: true },
    { name: "goal", description: "Set what this session is working towards", builtin: true },
  ], []);

  // Unified slash items: builtins first, then skills
  const slashItems = useMemo(() => {
    const filter = slashFilter.toLowerCase();
    const builtins = BUILTIN_COMMANDS.filter((c) => !filter || c.name.includes(filter));
    // The skills bundled inside the CLI aren't on disk, so the folder scan
    // can't see them — they're merged in here so they're findable.
    const all = withBundledSkills(skills);
    const filtered = all.filter((s) => !filter || s.name.toLowerCase().includes(filter));
    return [...builtins, ...filtered];
  }, [skills, slashFilter, BUILTIN_COMMANDS]);

  // Reset textarea height when switching tabs
  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.style.height = "auto";
    }
    setSlashMenuOpen(false);
  }, [activeTabId]);

  // Close attach popup on outside click
  useEffect(() => {
    if (!attachPopupOpen) return;
    const handler = (e: MouseEvent) => {
      if (attachBtnRef.current && !attachBtnRef.current.contains(e.target as Node)) {
        setAttachPopupOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [attachPopupOpen]);

  // Scroll selected skill into view
  useEffect(() => {
    if (slashMenuRef.current && slashSelectedIdx >= 0) {
      const item = slashMenuRef.current.children[slashSelectedIdx] as HTMLElement;
      if (item) item.scrollIntoView({ block: "nearest" });
    }
  }, [slashSelectedIdx]);

  const handleModelChange = useCallback(
    async (model: string) => {
      setTabModel(model);
    },
    [setTabModel]
  );

  const handleEffortChange = useCallback(
    async (effort: string) => {
      setTabEffort(effort);
    },
    [setTabEffort]
  );

  // Custom models added via the picker's "Custom model ID" field. Kept in
  // React state so the picker re-renders when one is added; the source of
  // truth is plugin.settings.customModels (removed in the settings panel).
  const [customModels, setCustomModels] = useState<string[]>(
    plugin.settings.customModels ?? []
  );

  // Re-sync when a custom model is removed in Settings (settings-changed event)
  useEffect(() => {
    const sync = () => setCustomModels([...(plugin.settings.customModels ?? [])]);
    window.addEventListener("hyo-settings-changed", sync);
    return () => window.removeEventListener("hyo-settings-changed", sync);
  }, [plugin]);

  const handleAddCustomModel = useCallback(
    async (rawId: string) => {
      const id = rawId.trim();
      if (!id) return;
      const isBuiltIn = MODEL_OPTIONS.some((m) => m.id === id);
      const isKnown = plugin.settings.customModels.includes(id);
      if (!isBuiltIn && !isKnown) {
        plugin.settings.customModels = [...plugin.settings.customModels, id];
        setCustomModels(plugin.settings.customModels);
      }
      setTabModel(id);
      await plugin.saveSettings();
    },
    [setTabModel, plugin]
  );

  const handlePermissionModeChange = useCallback(
    async (mode: string) => {
      setTabPermissionMode(mode);
    },
    [setTabPermissionMode]
  );

  const addFile = useCallback((file: AttachedFile) => {
    setAttachedFilesMap((prev) => {
      const tabFiles = prev[activeTabId] ?? [];
      if (tabFiles.find((f) => f.name === file.name)) return prev;
      return { ...prev, [activeTabId]: [...tabFiles, file] };
    });
  }, [activeTabId]);

  const readAndAddFile = useCallback((file: File) => {
    const ext = "." + (file.name.split(".").pop() ?? "").toLowerCase();

    // Images — base64 as image content blocks
    if (file.type.startsWith("image/")) {
      const reader = new FileReader();
      reader.onload = (ev) => {
        const dataUrl = ev.target?.result as string;
        const [header, data] = dataUrl.split(",");
        const mediaType = header.split(":")[1].split(";")[0];
        addFile({ name: file.name, fileType: "image", mediaType, data });
      };
      reader.readAsDataURL(file);
      return;
    }

    // PDFs — base64 as document content blocks (Claude API native support)
    if (ext === ".pdf" || file.type === "application/pdf") {
      const reader = new FileReader();
      reader.onload = (ev) => {
        const dataUrl = ev.target?.result as string;
        const data = dataUrl.split(",")[1];
        addFile({ name: file.name, fileType: "pdf", mediaType: "application/pdf", data });
      };
      reader.readAsDataURL(file);
      return;
    }

    // Excel — parse to CSV text via exceljs
    if (ext === ".xlsx" || ext === ".xls" || ext === ".xlsm") {
      const reader = new FileReader();
      reader.onload = async (ev) => {
        try {
          const buf = ev.target?.result as ArrayBuffer;
          const ExcelJS = await import("exceljs");
          const workbook = new ExcelJS.Workbook();
          await workbook.xlsx.load(buf);
          const parts: string[] = [];
          workbook.eachSheet((sheet) => {
            parts.push(`# Sheet: ${sheet.name}`);
            sheet.eachRow({ includeEmpty: false }, (row) => {
              const values = (row.values as any[]).slice(1).map((v) =>
                v === null || v === undefined ? "" : String(v)
              );
              parts.push(values.join(","));
            });
            parts.push("");
          });
          addFile({ name: file.name, fileType: "text", content: parts.join("\n") });
        } catch (err) {
          console.error("[hyo] Failed to parse Excel file:", err);
          new Notice(`Could not read "${file.name}" — file may be corrupt or password-protected`);
        }
      };
      reader.readAsArrayBuffer(file);
      return;
    }

    // Word — pull the body text out of word/document.xml
    if (ext === ".docx") {
      const reader = new FileReader();
      reader.onload = async (ev) => {
        try {
          const buf = ev.target?.result as ArrayBuffer;
          const { docxToText } = await import("../docx");
          const content = await docxToText(buf);
          if (!content.trim()) {
            new Notice(`"${file.name}" has no text Hyo can read`);
            return;
          }
          addFile({ name: file.name, fileType: "text", content });
        } catch (err) {
          console.error("[hyo] Failed to parse Word file:", err);
          new Notice(`Could not read "${file.name}" — file may be corrupt or password-protected`);
        }
      };
      reader.readAsArrayBuffer(file);
      return;
    }

    // Text files — check extension
    const textExtensions = new Set([
      ".txt", ".md", ".markdown", ".json", ".csv", ".yaml", ".yml",
      ".toml", ".xml", ".html", ".htm", ".css", ".js", ".jsx",
      ".ts", ".tsx", ".py", ".rb", ".go", ".rs", ".sh", ".log",
      ".env", ".ini", ".cfg", ".conf", ".sql", ".graphql", ".mdx",
    ]);
    if (!textExtensions.has(ext) && !file.type.startsWith("text/")) {
      new Notice(`Cannot attach "${file.name}" — unsupported file type`);
      return;
    }
    const reader = new FileReader();
    reader.onload = (ev) => {
      const content = ev.target?.result as string;
      addFile({ name: file.name, fileType: "text", content });
    };
    reader.readAsText(file);
  }, [addFile]);

  const removeFile = useCallback((name: string) => {
    setAttachedFilesMap((prev) => {
      const tabFiles = prev[activeTabId] ?? [];
      return { ...prev, [activeTabId]: tabFiles.filter((f) => f.name !== name) };
    });
  }, [activeTabId]);

  const handleAttachCurrentFile = useCallback(async () => {
    setAttachPopupOpen(false);
    const file = app.workspace.getActiveFile();
    if (!file) return;
    try {
      const content = await app.vault.read(file);
      addFile({ name: file.name, fileType: "text", content, vaultPath: file.path });
    } catch (e) {
      console.error("[hyo] Failed to read file:", e);
    }
  }, [app, addFile]);

  const handleUploadFromComputer = useCallback(() => {
    setAttachPopupOpen(false);
    fileInputRef.current?.click();
  }, []);

  const handleFileInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files || []);
      files.forEach(readAndAddFile);
      e.target.value = "";
    },
    [readAndAddFile]
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    // Only files get the drop-zone treatment — dragging a tab across the panel
    // shouldn't light up the attachment overlay.
    if (!e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    setDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) {
      setDragging(false);
    }
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    Array.from(e.dataTransfer.files).forEach(readAndAddFile);
  }, [readAndAddFile]);

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const files = Array.from(e.clipboardData.files || []);
    if (files.length > 0) {
      e.preventDefault();
      files.forEach(readAndAddFile);
    }
  }, [readAndAddFile]);

  // Commands that need no argument. /goal takes one, so it prefills the input
  // and waits for the user instead of firing immediately.
  const SEND_DIRECTLY = ["context", "usage", "cost"];

  const selectSlashItem = useCallback(
    (item: { name: string; builtin?: boolean }) => {
      setSlashMenuOpen(false);
      if (item.builtin && item.name === "compact") {
        setInputValues((prev) => ({ ...prev, [activeTabId]: "" }));
        compact();
        return;
      }
      // Commands the CLI answers itself — send straight through rather than
      // prefilling the input, since there's nothing for the user to add.
      if (item.builtin && SEND_DIRECTLY.includes(item.name)) {
        setInputValues((prev) => ({ ...prev, [activeTabId]: "" }));
        sendMessage(`/${item.name}`);
        return;
      }
      setInputValues((prev) => ({ ...prev, [activeTabId]: `/${item.name} ` }));
      inputRef.current?.focus();
    },
    [activeTabId, compact, sendMessage]
  );

  const handleInput = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const el = e.target;
      const val = el.value;
      setInputValues((prev) => ({ ...prev, [activeTabId]: val }));
      el.style.height = "auto";
      el.style.height = Math.min(el.scrollHeight, 150) + "px";

      // Slash command detection: only when input is exactly /word (no spaces, no newlines)
      if (val.startsWith("/") && !val.includes(" ") && !val.includes("\n")) {
        setSlashFilter(val.slice(1));
        setSlashMenuOpen(true);
        setSlashSelectedIdx(0);
      } else {
        setSlashMenuOpen(false);
      }
    },
    [activeTabId]
  );

  const handleSend = useCallback(() => {
    const text = (inputValues[activeTabId] ?? "").trim();
    if (!text && attachedFiles.length === 0) return;
    setInputValues((prev) => ({ ...prev, [activeTabId]: "" }));
    if (inputRef.current) {
      inputRef.current.style.height = "auto";
    }
    setSlashMenuOpen(false);
    const meta = attachedFiles.length > 0
      ? { displayText: text, attachedFileNames: attachedFiles.map((f) => f.name) }
      : undefined;

    const textFiles = attachedFiles.filter((f) => f.fileType === "text");
    const imageFiles = attachedFiles.filter((f) => f.fileType === "image");
    const pdfFiles = attachedFiles.filter((f) => f.fileType === "pdf");

    // Split text files: small ones go inline, large ones get written to disk
    // and Claude reads them via the Read tool.
    const smallTextFiles = textFiles.filter((f) => shouldInline(f.content || ""));
    const largeTextFiles = textFiles.filter((f) => !shouldInline(f.content || ""));

    const references: { name: string; tokens: number; filePath: string }[] = [];
    for (const f of largeTextFiles) {
      try {
        const filePath = writeAttachmentToDisk(attachmentsDir, f.name, f.content || "");
        references.push({
          name: f.name,
          tokens: estimateTokens(f.content || ""),
          filePath,
        });
      } catch (e) {
        console.error("[hyo] Failed to write attachment:", e);
        new Notice(`Could not save "${f.name}" for reference — sending inline instead`);
        // Fall back to inline
        smallTextFiles.push(f);
      }
    }

    const textParts: string[] = [];
    if (text) textParts.push(text);
    for (const f of smallTextFiles) {
      textParts.push(`[File: ${f.vaultPath || f.name}]\n${f.content}`);
    }
    if (references.length > 0) {
      const refList = references
        .map((r) => `- ${r.name} (~${r.tokens.toLocaleString()} tokens) — ${r.filePath}`)
        .join("\n");
      textParts.push(
        `I've attached the following files. Use the Read tool to access their contents when needed:\n\n${refList}`
      );
    }
    const messageText = textParts.join("\n\n");

    setAttachedFilesMap((prev) => ({ ...prev, [activeTabId]: [] }));

    if (imageFiles.length > 0 || pdfFiles.length > 0) {
      const blocks: any[] = [];
      if (messageText) blocks.push({ type: "text", text: messageText });
      for (const img of imageFiles) {
        blocks.push({ type: "image", source: { type: "base64", media_type: img.mediaType, data: img.data } });
      }
      for (const pdf of pdfFiles) {
        blocks.push({ type: "document", source: { type: "base64", media_type: pdf.mediaType, data: pdf.data } });
      }
      sendToClaude(blocks as any, meta);
    } else {
      sendToClaude(messageText, meta);
    }
  }, [inputValues, activeTabId, attachedFiles, sendToClaude, attachmentsDir]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (slashMenuOpen && slashItems.length > 0) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setSlashSelectedIdx((i) => Math.min(i + 1, slashItems.length - 1));
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setSlashSelectedIdx((i) => Math.max(i - 1, 0));
          return;
        }
        if (e.key === "Enter" || e.key === "Tab") {
          e.preventDefault();
          selectSlashItem(slashItems[slashSelectedIdx]);
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          setSlashMenuOpen(false);
          return;
        }
      }

      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [slashMenuOpen, slashItems, slashSelectedIdx, selectSlashItem, handleSend]
  );

  // --- The call ---

  // Claude's work while it answers a hand-off: each tool call, once its
  // input is in, becomes a short silent progress note for the voice (paced
  // in LiveCall), and the latest one shows in the call bar.
  const described = useRef<{ idx: number; tools: Set<string>; texts: Set<number> }>({ idx: -1, tools: new Set(), texts: new Set() });
  const [callStep, setCallStep] = useState("");
  const { notifyProgress } = voiceMode;
  useEffect(() => {
    if (!inVoiceView || !activeGenerating) {
      if (!activeGenerating) setCallStep("");
      return;
    }
    let idx = -1;
    for (let i = activeMessages.length - 1; i >= 0; i--) {
      const m = activeMessages[i];
      if (m.role === "assistant" && !m.isCompaction && !m.voiceCall) {
        idx = i;
        break;
      }
    }
    if (idx === -1) return;
    if (described.current.idx !== idx) described.current = { idx, tools: new Set(), texts: new Set() };
    const msg = activeMessages[idx];
    const blocks = msg.orderedBlocks || [];
    const tools = msg.toolCalls || [];
    blocks.forEach((b, bi) => {
      if (b.type === "tool" && b.toolId && !described.current.tools.has(b.toolId)) {
        const t = tools.find((x) => x.id === b.toolId);
        if (!t) return;
        const ready = t.result !== null || (t.input && Object.keys(t.input).length > 0);
        if (!ready) return;
        described.current.tools.add(b.toolId);
        const label = describeStep(t.name, t.input);
        if (label) {
          notifyProgress(label);
          setCallStep(label.charAt(0).toUpperCase() + label.slice(1));
        }
      }
    });
  }, [activeMessages, activeGenerating, inVoiceView, notifyProgress]);

  // A permission ask or a question on screen during a call: a chime, and on
  // a live call the voice tells her too — she may not be looking. The ask
  // itself shows in the chat as usual.
  let attentionId: string | null = null;
  let attentionText = "";
  if (inVoiceView) {
    for (let i = activeMessages.length - 1; i >= 0 && !attentionId; i--) {
      const pending = activeMessages[i].permissionRequests?.find((r) => !r.resolved);
      if (pending) {
        attentionId = pending.requestId;
        attentionText = attentionLine("permission", pending.toolName, pending.input);
      }
    }
    if (!attentionId) {
      for (let i = activeMessages.length - 1; i >= 0; i--) {
        const q = activeMessages[i].askQuestion;
        if (q) {
          attentionId = q.id;
          attentionText = attentionLine("question");
          break;
        }
      }
    }
  }
  const { notifyAttention } = voiceMode;
  useEffect(() => {
    if (attentionId && attentionId !== prevPermIdRef.current && inVoiceView) {
      playPermissionChime();
      if (attentionText) notifyAttention(attentionText);
    }
    prevPermIdRef.current = attentionId;
  }, [attentionId, inVoiceView, attentionText, notifyAttention]);

  // What the call bar says the agent is doing.
  let callWorking = "";
  if (inVoiceView && activeGenerating) {
    const last = activeMessages[activeMessages.length - 1];
    const agentCall = [...(last?.toolCalls || [])].reverse().find((t) => (t.name === "Agent" || t.name === "Task") && t.result === null);
    const desc = String(agentCall?.input?.description || "").trim();
    callWorking = agentCall ? (desc ? `Sub-agent: ${desc}` : "Sub-agent running") : callStep || "Working on it";
  }

  // The empty-box button starts a call (voice mode on for this tab). With
  // no voice key yet, it says where to add one and opens the settings.
  const startCallFromInput = () => {
    if (!hasVoiceApiKey) {
      new Notice(
        voiceEngine === "gpt-live"
          ? "Hyo voice: add your OpenAI API key in Settings → Hyo → Voice to start a call."
          : "Hyo voice: add your ElevenLabs API key in Settings → Hyo → Voice to start a call.",
        6000
      );
      openVoiceSettings();
      return;
    }
    if (!activeVoiceMode) toggleVoiceMode();
  };

  // Hang up: the call ends (its line goes into the chat) and voice mode goes
  // off. Anything Claude is still doing carries on and posts to the chat.
  const endVoice = () => {
    voiceMode.stopConversation();
    toggleVoiceMode();
  };
  // The call bar's orb and status. GPT-Live: the real audio level and who's
  // talking. ElevenLabs: who's talking, from the speech loop.
  const elSide = voiceMode.voiceState === "speaking" ? "agent" : voiceMode.voiceState === "listening" ? "user" : null;
  const callConnecting = voiceMode.isLive ? voiceMode.liveStatus !== "live" : !voiceMode.conversationActive;

  return (
    <div
      className={`hyo-chat-panel${dragging ? " hyo-drag-over" : ""}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {inVoiceView ? (
        <CallBar
          startedAt={callStartedAt}
          connecting={callConnecting}
          side={voiceMode.isLive ? voiceMode.liveSide : elSide}
          level={voiceMode.isLive ? voiceMode.liveLevel : elSide ? 0.35 : 0}
          working={callWorking}
          muted={voiceMode.micMuted}
          onToggleMute={voiceMode.toggleMute}
          onEnd={endVoice}
          onSettings={openVoiceSettings}
          onOrbClick={!voiceMode.isLive && voiceMode.voiceState === "speaking" ? voiceMode.stopAudio : undefined}
        />
      ) : (
        <ConversationSwitcher
          tasks={boardTasks}
          tabIds={tabIds}
          activeTabId={activeTabId}
          placement="top"
          onSwitch={switchTab}
          onClose={closeTabSafely}
          onRename={renameTab}
          onNew={newTab}
          onOpenTask={handleOpenTask}
          onTogglePin={handleTogglePin}
          onPanelOpen={refreshPastSessions}
          onSearchText={searchPastText}
          onRefresh={refreshPastSessions}
        />
      )}

      {showReleaseCard && (
        <ReleaseCard
          sinceVersion={plugin.settings.lastSeenVersion}
          version={currentVersion}
          onDismiss={dismissReleaseCard}
          onOpenNotes={() => setShowReleaseNotes(true)}
        />
      )}

      {showUpdateBanner && !inVoiceView && (
        <ClaudeUpdateCard
          key={updateKey}
          banner
          required={updateRequired!}
          onUpdate={runClaudeUpdate}
          onDismiss={() => setDismissedUpdateKey(updateKey)}
        />
      )}

      {showReleaseNotes && (
        <ReleaseNotes onClose={() => setShowReleaseNotes(false)} />
      )}

      {activeMessages.length > 0 ? (
        <ChatMessages
          messages={activeMessages}
          scrollRef={scrollRef}
          onPermissionResponse={answerPermission}
          onQuestionAnswer={sendQuestionAnswer}
          onClaudeUpdate={runClaudeUpdate}
          onClaudeSignIn={runClaudeSignIn}
          onOpenCall={setOpenCall}
          onRecover={() => {
            const result = recoverSession(activeTabId);
            if (result.success) {
              if (result.capturedUserText) {
                setInputValues((prev) => ({
                  ...prev,
                  [activeTabId]: result.capturedUserText!,
                }));
                setTimeout(() => inputRef.current?.focus(), 50);
              }
              new Notice(
                `Session recovered (${result.linesRemoved} corrupt entries removed). Review your message and send.`
              );
            } else {
              new Notice(
                `Couldn't recover session: ${result.reason || "unknown error"}`
              );
            }
          }}
        />
      ) : (
        <div className="hyo-messages">
          <div className="hyo-empty-state">
            <p>Start a conversation with Claude</p>
          </div>
        </div>
      )}

      <BackgroundJobs jobs={activeJobs} />

      {activeClosedElsewhere && (
        <div className="hyo-closed-elsewhere">
          Closed on your other device. It stays open here while there's text in the box; send it and it opens everywhere again.
        </div>
      )}

      <div className="hyo-input-area">
        {/* Slash command menu — floats above input */}
        {slashMenuOpen && slashItems.length > 0 && (
          <div className="hyo-slash-menu" ref={slashMenuRef}>
            {slashItems.map((skill, i) => (
              <div
                key={skill.name}
                className={`hyo-slash-item${i === slashSelectedIdx ? " hyo-slash-item-selected" : ""}`}
                onMouseDown={(e) => {
                  e.preventDefault();
                  selectSlashItem(skill);
                }}
              >
                <span className="hyo-slash-name">/{skill.name}</span>
                {skill.description && (
                  <span className="hyo-slash-desc">{skill.description}</span>
                )}
              </div>
            ))}
          </div>
        )}

        {(
          <>
            {attachedFiles.length > 0 && (
              <div className="hyo-attachment-chips">
                {attachedFiles.map((f) => {
                  const tokens = f.fileType === "text" ? estimateTokens(f.content || "") : 0;
                  const willReference = f.fileType === "text" && !shouldInline(f.content || "");
                  return (
                    <div
                      key={f.name}
                      className={`hyo-attachment-chip${willReference ? " hyo-attachment-chip-ref" : ""}`}
                      title={willReference ? `Large file — will be read via Claude's Read tool` : undefined}
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
                        <polyline points="14 2 14 8 20 8" />
                      </svg>
                      <span className="hyo-attachment-name">{f.name}</span>
                      {tokens > 0 && (
                        <span className="hyo-attachment-tokens">{formatTokens(tokens)}</span>
                      )}
                      <button
                        className="hyo-attachment-remove"
                        title="Remove attachment"
                        onClick={() => removeFile(f.name)}
                      >×</button>
                    </div>
                  );
                })}
              </div>
            )}
            <div className="hyo-input-row">
              <div className="hyo-attach-wrap" ref={attachBtnRef}>
                <button
                  className="hyo-attach-btn"
                  title="Attach file"
                  onClick={() => setAttachPopupOpen((v) => !v)}
                >
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
                  </svg>
                </button>
                {attachPopupOpen && (
                  <div className="hyo-attach-popup">
                    <button className="hyo-attach-popup-item" onClick={handleAttachCurrentFile}>
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
                        <polyline points="14 2 14 8 20 8" />
                      </svg>
                      Attach current file
                    </button>
                    <button className="hyo-attach-popup-item" onClick={handleUploadFromComputer}>
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                        <polyline points="17 8 12 3 7 8" />
                        <line x1="12" y1="3" x2="12" y2="15" />
                      </svg>
                      Upload from computer
                    </button>
                  </div>
                )}
              </div>

              <input
                ref={fileInputRef}
                type="file"
                style={{ display: "none" }}
                accept="image/*,.pdf,.docx,.xlsx,.xls,.xlsm,.txt,.md,.json,.csv,.yaml,.yml,.toml,.xml,.html,.css,.js,.ts,.py,.rb,.go,.rs,.sh,.log"
                multiple
                onChange={handleFileInputChange}
              />

              <textarea
                ref={inputRef}
                className="hyo-input"
                placeholder="Message Claude..."
                rows={1}
                value={inputValue}
                onChange={handleInput}
                onKeyDown={handleKeyDown}
                onPaste={handlePaste}
              />
              <SendButton
                mode={sendButtonMode({
                  generating: activeGenerating,
                  hasContent: !!inputValue.trim() || attachedFiles.length > 0,
                  inCall: inVoiceView,
                })}
                onSend={handleSend}
                onStop={stopGeneration}
                onCall={startCallFromInput}
              />
            </div>
          </>
        )}
      </div>

      <HyoStatusBar
        model={activeModel}
        effort={activeEffort}
        permissionMode={activePermissionMode}
        agent={activeAgent}
        inputTokens={activeInputTokens}
        contextWindow={activeContextWindow}
        customModels={customModels}
        onModelChange={handleModelChange}
        onEffortChange={handleEffortChange}
        onAddCustomModel={handleAddCustomModel}
        onPermissionModeChange={handlePermissionModeChange}
        onAgentChange={switchAgent}
        onCompact={compact}
      />

      {openCall && <VoiceCallSheet call={openCall} agentName={agentName} onClose={() => setOpenCall(null)} />}
    </div>
  );
}
