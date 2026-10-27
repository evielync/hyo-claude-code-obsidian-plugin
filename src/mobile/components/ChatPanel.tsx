import React, { useRef, useState, useCallback, useEffect, useLayoutEffect, useMemo } from "react";
import type { App } from "obsidian";
import { Notice } from "obsidian";
import { ChatMessages } from "./ChatMessages";
import { ConversationSwitcher } from "../../components/ConversationSwitcher";
import { BackgroundJobs } from "../../components/BackgroundJobs";
import { searchPastSessions } from "../session-parser";
import { buildTaskList, type BoardTask } from "../task-state";
import type { TaskMeta } from "../../settings";
import type { useSessionManager } from "../hooks/useSessionManager";
import { useVoiceMode } from "../hooks/useVoiceMode";
import { RecordingStore } from "../voice/recording-store";
import { parseVoiceResponse } from "../voice/voice-persona";
import { HANDOFF_NOTE } from "../../voice/voice-persona";
import { buildLiveHistory } from "../../voice/gpt-live";
import { describeStep, attentionLine } from "../../voice/voice-words";
import {
  unseenTurnsBlock,
  takeUnseenTurns,
  claudeMessageCount,
  placeAtHangUp,
  startCall,
  addTurn,
  endCall,
  callHasContent,
  type VoiceCallRecord,
} from "../../voice/voice-call";
import { debug } from "../debug";
import { CallBar } from "../../components/CallBar";
import { SendButton, sendButtonMode } from "../../components/SendButton";
import { VoiceCallSheet } from "../../components/VoiceCallLine";
import { GatewayClient, type ConnectionStatus } from "../gateway-client";
import type { ClaudeUpdateRunner } from "../../components/ClaudeUpdateCard";
import { VoiceWaveform } from "./VoiceWaveform";
import { useSkills, type Skill } from "../hooks/useSkills";
import type HyoPlugin from "../../main";
import { estimateTokens, formatTokens } from "../attachments";
import { MODEL_OPTIONS, PERMISSION_MODES as PHONE_PERMISSION_MODES, EFFORT_OPTIONS, DEFAULT_EFFORT, getContextLimit } from "../../models";
import { useAgents } from "../hooks/useAgents";
import { ReleaseCard } from "../../components/ReleaseCard";
import { ReleaseNotes } from "../../components/ReleaseNotes";

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
}

// A short two-note chime so a permission ask is noticeable when she's not
// looking at the phone. Synthesised (no asset to ship). resume() is called
// because iOS starts a fresh AudioContext suspended even when playback is
// otherwise unlocked.
function playPermissionChime() {
  try {
    const Ctx =
      window.AudioContext || (window as unknown as any).webkitAudioContext;
    const ctx = new Ctx();
    void ctx.resume?.();
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

export function ChatPanel({ sessionManager, plugin, app }: ChatPanelProps) {
  // Release card, as on the desktop: shown when the installed version is
  // newer than the last one acknowledged (the setting syncs, so seeing it on
  // one device counts for both). A fresh install gets no card.
  const currentVersion = plugin.manifest.version;
  const [showReleaseCard, setShowReleaseCard] = useState(
    () => !!plugin.settings.lastSeenVersion && plugin.settings.lastSeenVersion !== currentVersion
  );
  const [showReleaseNotes, setShowReleaseNotes] = useState(false);
  const dismissReleaseCard = useCallback(() => {
    setShowReleaseCard(false);
    plugin.settings.lastSeenVersion = currentVersion;
    void plugin.saveData(plugin.settings);
  }, [plugin, currentVersion]);
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
    activeVoiceMode,
    toggleVoiceMode,
    activeTabHasSession,
    activeAgent,
    activeModel,
    activePermissionMode,
    setTabPermissionMode,
    setTabModel,
    setTabAgent,
    setTabEffort,
    activeEffort,
    activeInputTokens,
    activeContextWindow,
    addVoiceCall,
    setVoiceEngine,
    newTab,
    closeTab,
    switchTab,
    renameTab,
    setTaskMeta,
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
    activeJobs,
    tabJobs,
    pinnedSessionIds,
    activeLoading,
    activeLoadError,
    retryLoad,
    setDraft,
    activeClosedElsewhere,
    openHints,
    loadOlder,
    activeHasOlder,
    activeLoadingOlder,
    activeOlderError,
  } = sessionManager;

  // Closing a conversation only takes it off the Open list. Its Claude
  // process lives on the Mac: a turn or background job still running
  // carries on, and is in History when it's done.
  const closeTabSafely = closeTab;
  void tabJobs;

  // "Update Claude" from the phone: the gateway Mac runs the update, then
  // this tab's message goes again. Only offered while connected to a gateway;
  // otherwise the card says to open Hyo on that Mac.
  const [gatewayStatus, setGatewayStatus] = useState<ConnectionStatus>("disconnected");
  useEffect(() => {
    const url = plugin.settings.gatewayUrl;
    if (!url) {
      setGatewayStatus("disconnected");
      return;
    }
    const client = GatewayClient.get(url);
    setGatewayStatus(client.getStatus());
    return client.onStatusChange(setGatewayStatus);
  }, [plugin.settings.gatewayUrl]);
  // The Mac out of reach for more than a moment: said plainly, so a reply
  // that stopped mid-way doesn't look like Claude giving up. (A blip of a
  // second or two, like the phone waking, isn't worth a banner.)
  const [macAway, setMacAway] = useState(false);
  useEffect(() => {
    if (!plugin.settings.gatewayUrl || gatewayStatus === "connected") {
      setMacAway(false);
      return;
    }
    const t = window.setTimeout(() => setMacAway(true), 3000);
    return () => window.clearTimeout(t);
  }, [gatewayStatus, plugin.settings.gatewayUrl]);
  const runClaudeUpdate = useMemo<ClaudeUpdateRunner | undefined>(() => {
    const url = plugin.settings.gatewayUrl;
    if (!url || gatewayStatus !== "connected") return undefined;
    return async (required, onPhase) => {
      const tabId = activeTabId;
      const r = await GatewayClient.get(url).updateClaude(required, onPhase);
      if (!r.ok) return r;
      return { ok: true, resent: retryAfterClaudeUpdate(tabId) };
    };
  }, [plugin.settings.gatewayUrl, gatewayStatus, activeTabId, retryAfterClaudeUpdate]);

  // ---- Conversations: the bar's panel (Open + History) ----

  // Pinned / closed live in the shared session metadata on the gateway, so the
  // state matches desktop and every device. Map derived from the loaded
  // sessions; writes go through the gateway and refresh the list.
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

  const boardTasks = useMemo(
    () => buildTaskList(tabs, pastSessions, taskMeta, Date.now(), openHints),
    [tabs, pastSessions, taskMeta, openHints]
  );
  const tabIds = useMemo(() => tabs.map((t) => t.id), [tabs]);
  const connectionLabel =
    gatewayStatus === "connected"
      ? "Connected"
      : gatewayStatus === "connecting"
      ? "Connecting…"
      : gatewayStatus === "reconnecting"
      ? "Reconnecting…"
      : "Disconnected";

  const [inputValues, setInputValues] = useState<Record<string, string>>({});
  const inputValue = inputValues[activeTabId] ?? "";
  // Which tabs have unsent text: a conversation closed on the Mac stays open
  // here while its box has text (see setDraft).
  useEffect(() => {
    for (const [tabId, text] of Object.entries(inputValues)) setDraft(tabId, text);
  }, [inputValues, setDraft]);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // The transcript sheet for a tapped call line.
  const [openCall, setOpenCall] = useState<VoiceCallRecord | null>(null);
  useEffect(() => setOpenCall(null), [activeTabId]);
  const [attachedFilesMap, setAttachedFilesMap] = useState<Record<string, AttachedFile[]>>({});
  const attachedFiles = attachedFilesMap[activeTabId] ?? [];
  const [attachPopupOpen, setAttachPopupOpen] = useState(false);
  const attachBtnRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  // Voice has two modes on one mic button:
  //  • Dictation (voice mode OFF) — records, transcribes, drops the text in the
  //    input box for Ev to review and send by hand. Unchanged from before.
  //  • Walkie-talkie (voice mode ON) — the loop closes itself: you talk, it
  //    auto-sends, and Chad speaks the reply back conversationally.
  // Which voice engine the desktop has set. The phone follows it: on GPT-Live
  // the desktop signs each call, so no key is needed here.
  const [liveEngine, setLiveEngine] = useState<string>(plugin.settings.voiceEngine || "elevenlabs");
  useEffect(() => {
    const url = plugin.settings.gatewayUrl;
    if (!url) return;
    let cancelled = false;
    GatewayClient.get(url)
      .liveConfig()
      .then((c) => {
        if (!cancelled) setLiveEngine(c.engine);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [plugin.settings.gatewayUrl]);
  const isLiveEngine = liveEngine === "gpt-live";
  useEffect(() => setVoiceEngine(liveEngine), [liveEngine, setVoiceEngine]);
  const hasVoiceApiKey = isLiveEngine ? !!plugin.settings.gatewayUrl : !!plugin.settings.elevenLabsApiKey;
  // Dictation follows the engine, so one key covers both: OpenAI transcribes
  // when the engine is GPT-Live, ElevenLabs otherwise.
  const dictationKey = isLiveEngine ? plugin.settings.openAiApiKey : plugin.settings.elevenLabsApiKey;
  const canDictate = !!dictationKey;
  const dictationKeyNotice = isLiveEngine
    ? "Add your OpenAI API key in Hyo settings to dictate."
    : "Add your ElevenLabs API key in Hyo settings to use voice.";

  // What a live call starts out knowing, read through refs at call start.
  const activeMessagesRef = useRef(activeMessages);
  activeMessagesRef.current = activeMessages;
  const activeAgentRef = useRef(activeAgent);
  activeAgentRef.current = activeAgent;
  const activeTabIdRef = useRef(activeTabId);
  activeTabIdRef.current = activeTabId;
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
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
  // The tab the call is in (the tab bar is hidden during a call), and what
  // was said on it that Claude hasn't seen yet — it rides along with the
  // next thing sent from that tab.
  const callTabIdRef = useRef<string | null>(null);
  const currentCallRef = useRef<() => VoiceCallRecord | null>(() => null);
  const sendToClaude = useCallback(
    (content: string | any[], meta?: { displayText?: string; attachedFileNames?: string[]; handoff?: boolean }) => {
      const tabId = activeTabIdRef.current;
      const current = callTabIdRef.current === tabId ? currentCallRef.current() : null;
      const { turns, advanced } = takeUnseenTurns(activeMessagesRef.current, current);
      for (const rec of advanced) if (rec !== current) addVoiceCall(tabId, { ...rec });
      const prefix = unseenTurnsBlock(turns);
      if (!prefix) return sendMessage(content, meta);
      if (typeof content === "string") {
        return sendMessage(`${prefix}\n\n${content}`, { ...meta, displayText: meta?.displayText ?? content });
      }
      return sendMessage([{ type: "text", text: prefix }, ...content], meta);
    },
    [sendMessage, addVoiceCall]
  );
  // A call ended: one line in the thread where it started, saved via the
  // gateway. A dropped call leaves voice mode so the bar goes.
  const onCallEnded = useCallback(
    (record: VoiceCallRecord | null, reason: string) => {
      const tabId = callTabIdRef.current;
      const tab = tabsRef.current.find((t) => t.id === tabId);
      if (record && tabId) {
        // The line goes where the call ended, after the work done on it.
        placeAtHangUp(record, tab?.messages || []);
        addVoiceCall(tabId, record);
      }
      if (reason !== "hung-up" && tab?.voiceMode && tabId === activeTabIdRef.current) toggleVoiceMode();
    },
    [addVoiceCall, toggleVoiceMode]
  );
  // Walkie-talkie (ElevenLabs) calls keep the same one-line record.
  const elCallRef = useRef<VoiceCallRecord | null>(null);

  // Dictations are saved here as they're recorded, so none is ever lost.
  const recordingStore = useMemo(
    () =>
      new RecordingStore(
        app.vault.adapter,
        plugin.manifest.dir || `${app.vault.configDir}/plugins/${plugin.manifest.id}`
      ),
    [app, plugin.manifest.dir, plugin.manifest.id]
  );

  const voiceMode = useVoiceMode({
    store: recordingStore,
    apiKey: plugin.settings.elevenLabsApiKey,
    stt: { provider: isLiveEngine ? "openai" : "elevenlabs", apiKey: dictationKey },
    voiceId: plugin.settings.voiceId,
    playbackSpeed: plugin.settings.voicePlaybackSpeed,
    isVoiceMode: activeVoiceMode,
    autoSpeak: activeVoiceMode,
    live: {
      enabled: isLiveEngine,
      exchangeSdp: (sdp, agent, history) =>
        GatewayClient.get(plugin.settings.gatewayUrl).liveSdp(sdp, agent, history),
      getContext: () => {
        const messages = activeMessagesRef.current;
        return {
          agent: activeAgentRef.current || "",
          history: buildLiveHistory(messages),
          after: claudeMessageCount(messages),
        };
      },
      onCallEnded,
      onHandoff: (prompt, said) => sendToClaude(prompt, { displayText: said, handoff: true }),

    },
    onTranscript: (text: string) => {
      if (activeVoiceMode) {
        // Walkie-talkie: send straight away — no glancing at the box, no
        // keyboard. Chad's reply gets spoken back by the effect below.
        if (elCallRef.current) addTurn(elCallRef.current, "user", text);
        sendMessage(text);
        return;
      }
      // Dictation: append to whatever's in the box (typed or a previous take)
      // rather than replacing it, so multiple takes stack. Deliberately do NOT
      // focus the textarea — focusing re-summons the iOS keyboard after every
      // take, the opposite of a hands-free flow.
      setInputValues((prev) => {
        const existing = prev[activeTabId] ?? "";
        const joined = existing.trim() ? `${existing.trimEnd()} ${text}` : text;
        return { ...prev, [activeTabId]: joined };
      });
    },
  });

  currentCallRef.current = voiceMode.currentCall;
  notifyPermRef.current = voiceMode.notifyPermissionAnswered;

  // Walkie-talkie: speak Chad's reply once it finishes generating. Strip any
  // [SCREEN] detail so only the spoken summary is read aloud — the full reply
  // still shows in the chat. Whole-reply for now; streaming sentence-by-sentence
  // is a follow-up. Guarded to the voice-mode tab so text chats never speak.
  const prevGeneratingRef = useRef(false);
  const { speakResponse, finishReply } = voiceMode;
  useEffect(() => {
    const finished = prevGeneratingRef.current && !activeGenerating;
    prevGeneratingRef.current = activeGenerating;
    if (!finished || !activeVoiceMode) return;
    let last: { role: string; content?: string; isCompaction?: boolean; voiceCall?: VoiceCallRecord; selfStarted?: boolean } | undefined;
    for (let i = activeMessages.length - 1; i >= 0; i--) {
      const m = activeMessages[i];
      if (m.role === "assistant" && !m.isCompaction && !m.voiceCall) {
        last = m;
        break;
      }
    }
    if (!last) return;
    if (voiceMode.isLive) {
      // Live call: the voice says the opening and points to the chat.
      finishReply(last.content || "", !!last.selfStarted);
      return;
    }
    const parsed = parseVoiceResponse(last.content || "");
    if (parsed.spoken) {
      if (elCallRef.current) addTurn(elCallRef.current, "agent", parsed.spoken);
      speakResponse(parsed.spoken);
    }
  }, [activeGenerating, activeVoiceMode, activeMessages, speakResponse, finishReply, voiceMode.isLive]);

  // Live call: start when the voice view opens, end when it closes.
  const startLiveRef = useRef(voiceMode.startLive);
  const stopLiveRef = useRef(voiceMode.stopLive);
  startLiveRef.current = voiceMode.startLive;
  stopLiveRef.current = voiceMode.stopLive;
  const callOpen = activeVoiceMode && hasVoiceApiKey;
  const liveViewOpen = callOpen && voiceMode.isLive;
  const [callStartedAt, setCallStartedAt] = useState<number | null>(null);
  useEffect(() => {
    if (!callOpen) return;
    callTabIdRef.current = activeTabIdRef.current;
    setCallStartedAt(Date.now());
    if (liveViewOpen) {
      void startLiveRef.current();
      return () => {
        stopLiveRef.current();
        setCallStartedAt(null);
      };
    }
    // Walkie-talkie: the record runs from voice on to voice off.
    elCallRef.current = startCall("elevenlabs", claudeMessageCount(activeMessagesRef.current));
    return () => {
      const call = elCallRef.current;
      elCallRef.current = null;
      setCallStartedAt(null);
      if (call) {
        endCall(call, "hung-up");
        onCallEnded(callHasContent(call) ? call : null, "hung-up");
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [callOpen, liveViewOpen]);

  // The voice overhears Claude's work: each tool call, once its input is in,
  // in plain words. The latest shows in the call bar.
  const described = useRef<{ idx: number; tools: Set<string>; texts: Set<number> }>({ idx: -1, tools: new Set(), texts: new Set() });
  const [callStep, setCallStep] = useState("");
  const { notifyProgress, notifyAttention } = voiceMode;
  useEffect(() => {
    if (!voiceMode.isLive || !activeGenerating) {
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
        if (t.result === null && !(t.input && Object.keys(t.input).length > 0)) return;
        described.current.tools.add(b.toolId);
        const label = describeStep(t.name, t.input);
        if (label) {
          notifyProgress(label);
          setCallStep(label.charAt(0).toUpperCase() + label.slice(1));
        }
      }
    });
  }, [activeMessages, activeGenerating, voiceMode.isLive, notifyProgress]);


  // The mic button reads BOTH gestures off one press, so you can hold-to-talk
  // (walkie-talkie) or tap-to-toggle (start, tap again to stop) — Ev asked for
  // both. On press we start recording and note the time; on release we decide:
  // held long enough → it was a hold, stop and send; a quick tap → leave it
  // recording so the next tap stops it. Non-idle states (transcribing, speaking,
  // error) keep their existing tap behaviour.
  const pressStartRef = useRef(0);
  const heldCycleRef = useRef(false);
  const HOLD_MS = 350;

  const handleMicPointerDown = useCallback(() => {
    if (!canDictate) {
      new Notice(dictationKeyNotice);
      return;
    }
    if (voiceMode.voiceState === "idle") {
      pressStartRef.current = Date.now();
      heldCycleRef.current = true;
      voiceMode.startRecording();
    }
  }, [canDictate, dictationKeyNotice, voiceMode]);

  const handleMicPointerUp = useCallback(() => {
    const st = voiceMode.voiceState;
    // End of a press that started recording: hold vs tap.
    if (heldCycleRef.current && st === "listening") {
      const held = Date.now() - pressStartRef.current;
      heldCycleRef.current = false;
      if (held >= HOLD_MS) {
        voiceMode.stopRecording(); // hold-release → send
      }
      // else: quick tap → keep recording, next tap stops it
      return;
    }
    heldCycleRef.current = false;
    // A tap while already recording (from an earlier tap-start) → stop + send.
    if (st === "listening") {
      voiceMode.stopRecording();
      return;
    }
    // Transcribing / speaking / error → existing tap semantics (retry, stop TTS…).
    if (st !== "idle") {
      if (!canDictate) return;
      voiceMode.handleRecordClick();
    }
  }, [canDictate, voiceMode]);

  // A dictation in progress (recording or transcribing) owns the mic: the
  // voice-mode toggle is dimmed and inert until it lands, so a stray tap can't
  // throw the take away by switching modes.
  const dictating = voiceMode.voiceState === "listening" || voiceMode.voiceState === "thinking";

  const handleVoiceModeToggle = useCallback(() => {
    if (dictating) return;
    if (!hasVoiceApiKey) {
      new Notice(
        isLiveEngine
          ? "Connect to your desktop gateway in Hyo settings to use voice."
          : "Add your ElevenLabs API key in Hyo settings to use voice."
      );
      return;
    }
    toggleVoiceMode();
  }, [dictating, hasVoiceApiKey, isLiveEngine, toggleVoiceMode]);

  // Ask First toggle (plugin setting, sent with every prompt to the gateway)
  const handleAskFirstToggle = useCallback(() => {
    plugin.settings.askFirst = !plugin.settings.askFirst;
    void plugin.saveSettings();
  }, [plugin]);

  // Session settings chip — agent, model and permissions in one panel,
  // replacing the standalone Ask First toggle in the input bar. On a phone
  // there's no room for separate pickers, so they live behind one chip.
  const agents = useAgents(plugin.settings.gatewayUrl);

  // Full-text search for the history screen — the gateway reads the files.
  const searchPastText = useCallback(
    (query: string) => searchPastSessions(plugin.settings.gatewayUrl, query),
    [plugin.settings.gatewayUrl]
  );
  const [sessionPanelOpen, setSessionPanelOpen] = useState(false);
  const [customModel, setCustomModel] = useState("");
  const [customModelsVersion, setCustomModelsVersion] = useState(0);
  // What the conversation in view really runs with: its process's own model,
  // agent and permission mode once the Mac has said, else what this phone
  // would start it with.
  const currentAgent = activeAgent || plugin.settings.defaultAgent || agents[0]?.name || "default";
  const currentModel = activeModel || plugin.settings.model || "claude-sonnet-5-5";
  // Each choice here is for the conversation in view, exactly as the same
  // control does it on the desktop (see the session manager).
  const setAgent = useCallback(
    (name: string) => {
      if (!setTabAgent(name)) {
        new Notice("Background jobs are still running in this conversation. Switch agents once they've finished.", 6000);
      }
    },
    [setTabAgent]
  );
  const setModel = useCallback((value: string) => setTabModel(value), [setTabModel]);
  // Built-in models plus the ones added by ID (kept in Settings, shared with
  // the desktop), the same list the desktop's picker shows.
  const allModelOpts = useMemo(
    () => [
      ...MODEL_OPTIONS,
      ...(plugin.settings.customModels || []).filter((id) => !MODEL_OPTIONS.some((m) => m.id === id)).map((id) => ({ id, name: id, context: "" })),
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [plugin.settings.customModels, customModelsVersion]
  );
  const addCustomModel = useCallback(
    (raw: string) => {
      const id = raw.trim();
      if (!id) return;
      if (!MODEL_OPTIONS.some((m) => m.id === id) && !(plugin.settings.customModels || []).includes(id)) {
        plugin.settings.customModels = [...(plugin.settings.customModels || []), id];
        void plugin.saveSettings();
        setCustomModelsVersion((v) => v + 1);
      }
      setTabModel(id);
    },
    [plugin, setTabModel]
  );
  // Effort falls back to the default rather than echoing an unknown value, as on the desktop.
  const effortOpt = EFFORT_OPTIONS.find((e) => e.id === activeEffort) || EFFORT_OPTIONS.find((e) => e.id === DEFAULT_EFFORT)!;
  // The context gauge, worked out as the desktop's is.
  const contextLimit = Math.max(activeContextWindow ?? 0, getContextLimit(currentModel));
  const contextPct = activeInputTokens > 0 ? Math.min(100, (activeInputTokens / contextLimit) * 100) : 0;
  const contextBarClass = contextPct > 80 ? "danger" : contextPct > 50 ? "warning" : "";
  const setMode = useCallback((mode: string) => setTabPermissionMode(mode), [setTabPermissionMode]);

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

  // Slash command state — the gateway lists the Mac's skills.
  const skills = useSkills(plugin.settings.gatewayUrl);
  const [slashMenuOpen, setSlashMenuOpen] = useState(false);
  const [slashFilter, setSlashFilter] = useState("");
  const [slashSelectedIdx, setSlashSelectedIdx] = useState(0);
  const slashMenuRef = useRef<HTMLDivElement>(null);

  const BUILTIN_COMMANDS = useMemo(() => [
    { name: "compact", description: "Summarise and compress conversation history", builtin: true },
    { name: "context", description: "Show current context window usage breakdown", builtin: true },
  ], []);

  // Unified slash items: builtins first, then skills
  const slashItems = useMemo(() => {
    const filter = slashFilter.toLowerCase();
    const builtins = BUILTIN_COMMANDS.filter((c) => !filter || c.name.includes(filter));
    const filtered = skills.filter((s) => !filter || s.name.toLowerCase().includes(filter));
    return [...builtins, ...filtered];
  }, [skills, slashFilter, BUILTIN_COMMANDS]);

  // The box fits its text: one line when empty, growing with every line up to
  // the cap, then scrolling. Driven off the value itself so typing, dictation,
  // keyboard dictation, paste and switching to a tab with a long draft all
  // size it the same way.
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 200) + "px";
  }, [inputValue, activeTabId]);

  useEffect(() => {
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
          const { docxToText } = await import("../../docx");
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

  const selectSlashItem = useCallback(
    (item: { name: string; builtin?: boolean }) => {
      setSlashMenuOpen(false);
      if (item.builtin && item.name === "compact") {
        setInputValues((prev) => ({ ...prev, [activeTabId]: "" }));
        compact();
        return;
      }
      if (item.builtin && item.name === "context") {
        setInputValues((prev) => ({ ...prev, [activeTabId]: "" }));
        sendMessage("/context");
        return;
      }
      setInputValues((prev) => ({ ...prev, [activeTabId]: `/${item.name} ` }));
      inputRef.current?.focus();
    },
    [activeTabId, compact]
  );

  const handleInput = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const el = e.target;
      const val = el.value;
      setInputValues((prev) => ({ ...prev, [activeTabId]: val }));

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

    // Desktop wrote large text files to disk and pointed Claude at them via
    // the Read tool. There's no disk to write to on mobile (and no gateway
    // RPC for it), so every text attachment is inlined regardless of size.
    const textParts: string[] = [];
    if (text) textParts.push(text);
    for (const f of textFiles) {
      textParts.push(`[File: ${f.vaultPath || f.name}]\n${f.content}`);
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
      sendMessage(blocks as any, meta);
    } else {
      sendMessage(messageText, meta);
    }
  }, [inputValues, activeTabId, attachedFiles, sendMessage]);

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
  const inVoiceView = callOpen;

  // A permission ask or question during a call: a chime, and on a live call
  // the voice says so — she may not be looking at the phone. The ask itself
  // shows in the chat.
  let attentionId: string | null = null;
  let attentionText = "";
  if (inVoiceView) {
    outer: for (let i = activeMessages.length - 1; i >= 0; i--) {
      for (const pr of activeMessages[i].permissionRequests || []) {
        if (pr.resolved) continue;
        attentionId = pr.requestId;
        attentionText = attentionLine("permission", pr.toolName, pr.input);
        break outer;
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
  const prevAttentionRef = useRef<string | null>(null);
  useEffect(() => {
    if (attentionId && attentionId !== prevAttentionRef.current && inVoiceView) {
      playPermissionChime();
      if (attentionText) notifyAttention(attentionText);
    }
    prevAttentionRef.current = attentionId;
  }, [attentionId, inVoiceView, attentionText, notifyAttention]);

  // What the call bar says the agent is doing.
  let callWorking = "";
  if (inVoiceView && activeGenerating) {
    const last = activeMessages[activeMessages.length - 1];
    const agentCall = [...(last?.toolCalls || [])].reverse().find((t) => (t.name === "Agent" || t.name === "Task") && t.result === null);
    const desc = String(agentCall?.input?.description || "").trim();
    callWorking = agentCall ? (desc ? `Sub-agent: ${desc}` : "Sub-agent running") : callStep || "Working on it";
  }
  const elSide = voiceMode.voiceState === "speaking" ? "agent" : voiceMode.voiceState === "listening" ? "user" : null;
  const endCallNow = () => {
    voiceMode.stopAudio();
    if (voiceMode.isLive) voiceMode.stopLive();
    toggleVoiceMode();
  };

  return (
    <div
      className={`hyo-chat-panel${dragging ? " hyo-drag-over" : ""}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {inVoiceView && (
        <CallBar
          startedAt={callStartedAt}
          connecting={voiceMode.isLive ? voiceMode.liveStatus !== "live" : false}
          side={voiceMode.isLive ? voiceMode.liveSide : elSide}
          level={voiceMode.isLive ? voiceMode.liveLevel : elSide ? 0.35 : 0}
          working={callWorking}
          muted={voiceMode.isLive ? voiceMode.liveMuted : false}
          onToggleMute={voiceMode.isLive ? voiceMode.toggleLiveMute : undefined}
          onEnd={endCallNow}
          onSettings={() => {
            const setting = (app as any).setting;
            setting?.open();
            setting?.openTabById?.(plugin.manifest.id);
          }}
          onOrbClick={!voiceMode.isLive && voiceMode.voiceState === "speaking" ? voiceMode.stopAudio : undefined}
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
      {showReleaseNotes && <ReleaseNotes onClose={() => setShowReleaseNotes(false)} />}

      {activeMessages.length > 0 ? (
        <ChatMessages
          messages={activeMessages}
          scrollRef={scrollRef}
          onPermissionResponse={answerPermission}
          onQuestionAnswer={sendQuestionAnswer}
          onClaudeUpdate={runClaudeUpdate}
          onOpenCall={setOpenCall}
          hasOlder={activeHasOlder}
          loadingOlder={activeLoadingOlder}
          olderError={activeOlderError}
          onLoadOlder={() => loadOlder(activeTabId)}
          onRecover={async () => {
            const result = await recoverSession(activeTabId);
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
      ) : activeLoading ? (
        // An earlier conversation on its way from the Mac.
        <div className="hyo-messages">
          <div className="hyo-empty-state hyo-convo-loading" role="status">
            <span className="hyo-convo-spinner" aria-hidden="true" />
            <p>Loading conversation…</p>
          </div>
        </div>
      ) : activeLoadError ? (
        <div className="hyo-messages">
          <div className="hyo-empty-state hyo-convo-load-error" role="alert">
            <p>
              Couldn't load this conversation. {activeLoadError.replace(/\.?$/, ".")} Check the Mac is on and Hyo
              is open there, then try again.
            </p>
            <button className="hyo-convo-retry" onClick={() => retryLoad(activeTabId)}>
              Try again
            </button>
          </div>
        </div>
      ) : (
        <div className="hyo-messages">
          <div className="hyo-empty-state">
            <p>Start a conversation</p>
          </div>
        </div>
      )}

      <BackgroundJobs jobs={activeJobs} />

      {macAway && (
        <div className="hyo-mac-away" role="status">
          Can't reach your Mac right now. Anything running there carries on; Hyo reconnects by itself, and what you send waits until then.
        </div>
      )}
      {activeClosedElsewhere && (
        <div className="hyo-closed-elsewhere">
          Closed on your Mac. It stays open here while there's text in the box; send it and it opens everywhere again.
        </div>
      )}

      {!inVoiceView && (
        <ConversationSwitcher
          tasks={boardTasks}
          tabIds={tabIds}
          activeTabId={activeTabId}
          placement="bottom"
          swipeToClose
          // The gateway connection: green connected, amber (re)connecting,
          // red disconnected. The only trace of connection health in the UI.
          leading={
            <span
              className={`hyo-conn-dot hyo-conn-dot-${gatewayStatus}`}
              title={`Gateway: ${connectionLabel}`}
            />
          }
          onSwitch={switchTab}
          onClose={closeTabSafely}
          onRename={renameTab}
          onNew={newTab}
          onOpenTask={handleOpenTask}
          onTogglePin={handleTogglePin}
          onPanelOpen={refreshPastSessions}
          onSearchText={searchPastText}
          onRefresh={refreshPastSessions}
          refreshTitle="Refresh — pick up conversations started on the desktop"
          // Search and refresh both go through the gateway.
          searchAvailable={gatewayStatus === "connected"}
        />
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

        {attachedFiles.length > 0 && (
          <div className="hyo-attachment-chips">
            {attachedFiles.map((f) => {
              const tokens = f.fileType === "text" ? estimateTokens(f.content || "") : 0;
              return (
                <div
                  key={f.name}
                  className="hyo-attachment-chip"
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
        {voiceMode.voiceState === "listening" && (
          <VoiceWaveform getWaveform={voiceMode.getWaveform} />
        )}
        {voiceMode.voiceState === "thinking" && (
          <div className="hyo-transcribing-status" role="status" aria-live="polite">
            <svg
              className="hyo-transcribing-spinner"
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
            >
              <path d="M12 3a9 9 0 1 0 9 9" />
            </svg>
            <span>Transcribing your note…</span>
          </div>
        )}
        {voiceMode.voiceState === "error" && (
          <div className="hyo-transcribing-status error" role="status" aria-live="polite">
            <svg
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="12" />
              <line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
            <span>
              {voiceMode.errorMessage || "Transcription failed"} — tap the mic to retry
            </span>
            <button
              className="hyo-transcribing-dismiss"
              title="Discard this recording"
              onClick={voiceMode.dismissError}
            >
              ×
            </button>
          </div>
        )}
        <div className="hyo-input-card">
          <textarea
            ref={inputRef}
            className="hyo-input"
            placeholder="Message Hyo…"
            rows={1}
            value={inputValue}
            onChange={handleInput}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
          />

          <div className="hyo-input-controls">
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
                    Photo or file
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


            {/* On a live call the mic is the call's; dictation waits. */}
            {!liveViewOpen && (
            <button
              className={`hyo-mic-btn${voiceMode.voiceState === "listening" ? " recording" : ""}${voiceMode.voiceState === "thinking" ? " thinking" : ""}${voiceMode.voiceState === "error" ? " error" : ""}`}
              title={
                !canDictate
                  ? "Set up voice in Hyo settings"
                  : voiceMode.voiceState === "listening"
                  ? "Tap to stop, or release if holding"
                  : voiceMode.voiceState === "thinking"
                  ? "Transcribing…"
                  : voiceMode.voiceState === "error"
                  ? "Tap to retry"
                  : activeVoiceMode
                  ? "Hold to talk, or tap to start/stop"
                  : "Hold or tap to dictate"
              }
              disabled={voiceMode.voiceState === "thinking"}
              onPointerDown={handleMicPointerDown}
              onPointerUp={handleMicPointerUp}
              onPointerCancel={handleMicPointerUp}
            >
              {voiceMode.voiceState === "thinking" ? (
                <svg
                  className="hyo-mic-spinner"
                  width="15"
                  height="15"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                >
                  <path d="M12 3a9 9 0 1 0 9 9" />
                </svg>
              ) : voiceMode.voiceState === "error" ? (
                <svg
                  width="15"
                  height="15"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M3 2v6h6" />
                  <path d="M3.51 15a9 9 0 1 0 2.13-9.36L3 8" />
                </svg>
              ) : voiceMode.voiceState === "listening" ? (
                <svg width="15" height="15" viewBox="0 0 24 24">
                  <rect x="4" y="4" width="16" height="16" rx="2" fill="currentColor" />
                </svg>
              ) : (
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
                  <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                  <line x1="12" y1="19" x2="12" y2="23" />
                  <line x1="8" y1="23" x2="16" y2="23" />
                </svg>
              )}
            </button>
            )}

            <button
              className="hyo-session-chip"
              title="Agent, model and permissions"
              onClick={() => setSessionPanelOpen(true)}
            >
              <span className="hyo-session-chip-dot" />
              <span className="hyo-session-chip-name">{currentAgent}</span>
              <svg className="hyo-session-chip-tune" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M4 6h10M18 6h2M4 12h2M10 12h10M4 18h7M15 18h5" />
                <circle cx="16" cy="6" r="2" /><circle cx="8" cy="12" r="2" /><circle cx="13" cy="18" r="2" />
              </svg>
            </button>

            <span className="hyo-input-controls-spacer" />

            <SendButton
              mode={sendButtonMode({
                generating: activeGenerating,
                hasContent: !!inputValue.trim() || attachedFiles.length > 0,
                inCall: inVoiceView,
              })}
              onSend={handleSend}
              onStop={stopGeneration}
              onCall={() => {
                if (!activeVoiceMode) handleVoiceModeToggle();
              }}
            />
          </div>
        </div>
      </div>
      {sessionPanelOpen && (
        <>
          <div className="hyo-session-scrim" onClick={() => setSessionPanelOpen(false)} />
          <div className="hyo-session-sheet" role="dialog" aria-label="Session settings">
            <div className="hyo-session-grab" />
            <div className="hyo-session-sec">
              <div className="hyo-session-sec-label">Agent</div>
              {agents.map((a) => (
                <button key={a.name} className={`hyo-session-opt${currentAgent === a.name ? " sel" : ""}`} onClick={() => setAgent(a.name)}>
                  <span className="hyo-session-opt-dot" style={{ background: a.color }} />
                  <span className="hyo-session-opt-name">{a.name}</span>
                  {currentAgent === a.name && <span className="hyo-session-opt-tick">✓</span>}
                </button>
              ))}
            </div>
            <div className="hyo-session-sec">
              <div className="hyo-session-sec-label">Model</div>
              {allModelOpts.map((m) => (
                <button key={m.id} className={`hyo-session-opt${currentModel === m.id ? " sel" : ""}`} onClick={() => setModel(m.id)}>
                  <span className="hyo-session-opt-name">{m.name}</span>
                  {m.context && <span className="hyo-session-opt-desc">{m.context}</span>}
                  {currentModel === m.id && <span className="hyo-session-opt-tick">✓</span>}
                </button>
              ))}
              {!allModelOpts.some((m) => m.id === currentModel) && (
                <button className="hyo-session-opt sel">
                  <span className="hyo-session-opt-name">{currentModel}</span>
                  <span className="hyo-session-opt-tick">✓</span>
                </button>
              )}
              <form
                className="hyo-session-custom"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (customModel.trim()) {
                    addCustomModel(customModel);
                    setCustomModel("");
                  }
                }}
              >
                <input className="hyo-session-custom-input" placeholder="Custom model ID…" value={customModel} onChange={(e) => setCustomModel(e.target.value)} />
                <button type="submit" className="hyo-session-custom-btn" disabled={!customModel.trim()}>
                  Use
                </button>
              </form>
            </div>
            <div className="hyo-session-sec">
              <div className="hyo-session-sec-label">Effort</div>
              {EFFORT_OPTIONS.map((o) => (
                <button key={o.id} className={`hyo-session-opt${effortOpt.id === o.id ? " sel" : ""}`} onClick={() => setTabEffort(o.id)}>
                  <span className="hyo-session-opt-text">
                    <span className="hyo-session-opt-name">
                      {o.name}
                      {o.id === DEFAULT_EFFORT && <span className="hyo-session-opt-badge">Default</span>}
                    </span>
                    <span className="hyo-session-opt-desc">{o.desc}</span>
                  </span>
                  {effortOpt.id === o.id && <span className="hyo-session-opt-tick">✓</span>}
                </button>
              ))}
            </div>
            <div className="hyo-session-sec">
              <div className="hyo-session-sec-label">Permissions</div>
              {PHONE_PERMISSION_MODES.map((m) => (
                <button key={m.id} className={`hyo-session-opt${activePermissionMode === m.id ? " sel" : ""}`} onClick={() => setMode(m.id)}>
                  <span className="hyo-session-opt-name">{m.name}</span>
                  {activePermissionMode === m.id && <span className="hyo-session-opt-tick">✓</span>}
                </button>
              ))}
            </div>
            {activeInputTokens > 0 && (
              <div className="hyo-session-sec">
                <div className="hyo-session-sec-label">Context window</div>
                <div className="hyo-session-context">
                  <div className="hyo-session-context-row">
                    <span>Used</span>
                    <span>
                      {formatTokens(activeInputTokens)} / {formatTokens(contextLimit)}
                    </span>
                  </div>
                  <div className="hyo-usage-bar-inline">
                    <div className={`hyo-usage-bar-inline-fill ${contextBarClass}`} style={{ width: contextPct + "%" }} />
                  </div>
                  <div className="hyo-session-context-row small">
                    <span>Remaining until auto-compact</span>
                    <span>{Math.max(0, 100 - Math.round(contextPct))}%</span>
                  </div>
                  <button
                    className="hyo-session-compact"
                    onClick={() => {
                      compact();
                      setSessionPanelOpen(false);
                    }}
                  >
                    Compact now
                  </button>
                </div>
              </div>
            )}
          </div>
        </>
      )}
      {openCall && <VoiceCallSheet call={openCall} agentName={activeAgent ? activeAgent.charAt(0).toUpperCase() + activeAgent.slice(1) : "Agent"} onClose={() => setOpenCall(null)} />}
    </div>
  );
}
