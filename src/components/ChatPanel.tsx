import React, { useRef, useState, useCallback, useEffect, useMemo } from "react";
import type { App } from "obsidian";
import { Notice } from "obsidian";
import { ChatMessages } from "./ChatMessages";
import { ChatTabs } from "./ChatTabs";
import { TaskScreen } from "./TaskScreen";
import { searchSessionText } from "../session-parser";
import type { BoardTask } from "../task-state";
import type { TaskMeta } from "../settings";
import { HyoStatusBar } from "./HyoStatusBar";
import { ReleaseCard } from "./ReleaseCard";
import { ReleaseNotes } from "./ReleaseNotes";
import { MODEL_OPTIONS, claudeUpdateNeeded } from "../models";
import { ClaudeUpdateCard, type ClaudeUpdateRunner } from "./ClaudeUpdateCard";
import { VoiceControls } from "./VoiceControls";
import { VoiceView, type BlobState, type VoicePermission } from "./VoiceView";
import type { AskQuestionData } from "../hooks/useChatEngine";
import type { useSessionManager } from "../hooks/useSessionManager";
import { useVoiceMode } from "../hooks/useVoiceMode";
import { parseVoiceResponse, lastSentenceBoundary, HANDOFF_NOTE } from "../voice/voice-persona";
import { ensureVoiceAssets } from "../voice/voice-assets";
import { describeToolForVoice } from "../voice/gpt-live";
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

export function ChatPanel({ sessionManager, plugin, app, claudeVersion, onUpdateClaude }: ChatPanelProps) {
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
    pastSessions,
    openPastSession,
    refreshPastSessions,
    scrollRef,
    appendVoiceTurn,
    flushVoiceTurns,
  } = sessionManager;

  // ---- Task mode (the History screen) ----
  // The clock button opens a full screen you scroll; opening a task drops back
  // into the conversation. No Chat/Tasks toggle — the top-bar buttons switch it.
  const [viewMode, setViewMode] = useState<"chat" | "tasks">("chat");

  // Pinned / closed now live in the shared session metadata (not the plugin's
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
    return m;
  }, [pastSessions]);

  // Open a task: switch to its tab if open, otherwise resume it as a new tab.
  // Opening a closed conversation reopens it (clears the closed flag).
  const handleOpenTask = useCallback(
    (task: BoardTask) => {
      if (task.closed && task.cliSessionId)
        setTaskMeta(task.cliSessionId, { closed: false });
      if (task.tabId) switchTab(task.tabId);
      else if (task.past) openPastSession(task.past);
      setViewMode("chat");
    },
    [switchTab, openPastSession, setTaskMeta]
  );

  const handleNewTask = useCallback(() => {
    newTab();
    setViewMode("chat");
  }, [newTab]);

  const toggleTaskScreen = useCallback(() => {
    setViewMode((v) => {
      if (v === "chat") refreshPastSessions();
      return v === "chat" ? "tasks" : "chat";
    });
  }, [refreshPastSessions]);

  // In task mode, clicking a tab in the top bar takes you into that conversation.
  const switchToChatTab = useCallback(
    (id: string) => {
      switchTab(id);
      setViewMode("chat");
    },
    [switchTab]
  );

  // Close: done, nothing needed either way. Stays in the list, marked Closed.
  const handleCloseTask = useCallback(
    (task: BoardTask) => {
      if (task.cliSessionId)
        setTaskMeta(task.cliSessionId, {
          closed: true,
          lastActive: new Date().toISOString(),
        });
    },
    [setTaskMeta]
  );

  const handleTogglePin = useCallback(
    (task: BoardTask) => {
      if (task.cliSessionId)
        setTaskMeta(task.cliSessionId, { pinned: !task.pinned });
    },
    [setTaskMeta]
  );

  const handleRenameTask = useCallback(
    (task: BoardTask, title: string) => {
      if (task.tabId) renameTab(task.tabId, title);
      else if (task.cliSessionId) renamePastSession(task.cliSessionId, title);
    },
    [renameTab, renamePastSession]
  );

  const [inputValues, setInputValues] = useState<Record<string, string>>({});
  const inputValue = inputValues[activeTabId] ?? "";
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [attachedFilesMap, setAttachedFilesMap] = useState<Record<string, AttachedFile[]>>({});
  const attachedFiles = attachedFilesMap[activeTabId] ?? [];
  const [attachPopupOpen, setAttachPopupOpen] = useState(false);
  const attachBtnRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  // Auto-detect skills from working directory
  const vaultPath = (app.vault.adapter as any).basePath as string;
  const workingDirectory = plugin.settings.workingDirectory
    ? plugin.settings.workingDirectory.replace(
        /^~/,
        process.env.HOME || process.env.USERPROFILE || ""
      )
    : vaultPath;

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
  // Stable so the hands-free loop's callbacks don't churn every render.
  // Anything said on a live call that Claude hasn't seen yet: the voice turns
  // sitting after the last message that went to Claude. Whatever goes to
  // Claude next (a hand-off or a typed message) carries them, so it can pick
  // up the thread; after that they're behind a Claude message and count as seen.
  const activeMessagesRef = useRef(activeMessages);
  activeMessagesRef.current = activeMessages;
  const unseenVoiceBlock = useCallback((): string => {
    const msgs = activeMessagesRef.current;
    const lines: string[] = [];
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (!m.voice) break;
      lines.unshift(`${m.role === "user" ? "User" : "You (voice)"}: ${m.content}`);
    }
    if (!lines.length) return "";
    return `[Said on a voice call just now — your voice model handled these turns; you haven't seen them yet]\n${lines.join("\n")}\n[End of voice call excerpt]`;
  }, []);
  const sendToClaude = useCallback(
    (content: string | any[], meta?: { displayText?: string; attachedFileNames?: string[]; handoff?: boolean }) => {
      const prefix = unseenVoiceBlock();
      if (!prefix) return sendMessage(content, meta);
      if (typeof content === "string") {
        return sendMessage(`${prefix}\n\n${content}`, { ...meta, displayText: meta?.displayText ?? content });
      }
      return sendMessage([{ type: "text", text: prefix }, ...content], meta);
    },
    [sendMessage, unseenVoiceBlock]
  );

  // A hand-off from the live call. The spoken turn is already in the thread as
  // a voice message, so the Claude message shows as a short pointer, and the
  // reply that follows shows only its work (the voice speaks the words).
  // displayText is the spoken request itself so titles and search see what
  // was asked; the thread draws hand-offs as the "↗ Handed to Claude" pointer.
  const handleTranscript = useCallback(
    (text: string) =>
      sendToClaude(`${text}\n\n${HANDOFF_NOTE}`, {
        displayText: text,
        handoff: true,
      }),
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
  const liveCtxRef = useRef({
    agent: activeAgent || plugin.settings.defaultAgent || "",
    personality: plugin.settings.voicePersonality,
    messages: activeMessages,
  });
  liveCtxRef.current = {
    agent: activeAgent || plugin.settings.defaultAgent || "",
    personality: plugin.settings.voicePersonality,
    messages: activeMessages,
  };
  const getLiveContext = useCallback(() => liveCtxRef.current, []);

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
    gptLiveVoice: plugin.settings.gptLiveVoice,
    getLiveContext,
    onVoiceTurn: appendVoiceTurn,
    debugLog: !!plugin.settings.voiceDebugLog,
  });

  // Voice view UI state: whether the transcript is flipped open, and which
  // assistant turn's on-screen overlay has been dismissed.
  const [showTranscript, setShowTranscript] = useState(false);
  const [dismissedScreenIdx, setDismissedScreenIdx] = useState(-1);
  const inVoiceView = activeVoiceMode && hasVoiceApiKey;

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
  useEffect(() => {
    if (!inVoiceView) return;
    void startConvRef.current();
    return () => stopConvRef.current();
  }, [inVoiceView]);

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
  useEffect(() => {
    const run = (prompt: string, notePath?: string) => {
      let text = prompt;
      if (notePath) {
        text += `\n\nUse the note at \`${notePath}\` as the source for this task.`;
      }
      pendingCommandPromptRef.current = text;
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
    if (pendingCommandPromptRef.current) {
      const text = pendingCommandPromptRef.current;
      pendingCommandPromptRef.current = null;
      sendMessage(text);
    }
  }, [activeTabId, sendMessage]);

  // Speak Chad's reply AS IT STREAMS. On each streamed update we take the
  // conversational text so far (with [SCREEN] detail stripped — that's shown,
  // not spoken), and speak whatever complete sentences are new since last time.
  // The ack ("let me check") gets spoken the instant it streams, before the
  // tool work runs — not 30 seconds later at the end. On finish we flush the
  // trailing bit that had no closing punctuation.
  const prevGeneratingRef = useRef(activeGenerating);
  const prevTabIdRef = useRef(activeTabId);
  // The text we've already spoken this turn — tracked as a string (not a char
  // offset) so it stays aligned even when the reply arrives partly streamed and
  // partly as a completed message that REPLACES the content. We re-anchor to
  // the current text each tick via a common-prefix match, so speech can never
  // start mid-sentence.
  const spokenSoFarRef = useRef("");
  const speakTurnRef = useRef(-1);
  const { enqueueSpeech, stopAudio } = voiceMode;
  useEffect(() => {
    const tabChanged = prevTabIdRef.current !== activeTabId;
    const startedGenerating = !prevGeneratingRef.current && activeGenerating;
    const finishedGenerating = prevGeneratingRef.current && !activeGenerating;

    if (
      !tabChanged &&
      activeVoiceMode &&
      plugin.settings.voiceAutoSpeak
    ) {
      // A new turn interrupts any speech still playing from the last one.
      if (startedGenerating) {
        stopAudio();
        spokenSoFarRef.current = "";
      }

      // Index of the assistant message currently being spoken. Voice turns are
      // what the call already said — never fed back to be spoken again.
      let idx = -1;
      for (let i = activeMessages.length - 1; i >= 0; i--) {
        const m = activeMessages[i];
        if (m.role === "assistant" && !m.isCompaction && !m.voice) {
          idx = i;
          break;
        }
      }

      if (idx !== -1 && voiceMode.isLive) {
        // Live call: the voice gets Claude's whole reply once, when it's done,
        // followed by a "that's complete" note. Sentence-by-sentence pieces
        // left it believing the hand-off was still running whenever the user
        // talked over the first one.
        if (finishedGenerating && speakTurnRef.current !== idx) {
          speakTurnRef.current = idx;
          const parsed = parseVoiceResponse(activeMessages[idx].content || "");
          const spoken = parsed.spoken.trim();
          voiceMode.finishHandoff(
            spoken || (parsed.screens.length ? "It's on screen now." : "Done.")
          );
        }
      } else if (idx !== -1) {
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
        const cut = finishedGenerating
          ? remainder.length
          : lastSentenceBoundary(remainder) + 1;
        if (cut > 0) {
          const chunk = remainder.slice(0, cut).trim();
          if (chunk) {
            enqueueSpeech(chunk);
          }
          spokenSoFarRef.current = spoken.slice(0, base + cut);
        }
      }
    }

    prevGeneratingRef.current = activeGenerating;
    prevTabIdRef.current = activeTabId;
  }, [
    activeGenerating,
    activeVoiceMode,
    activeMessages,
    activeTabId,
    enqueueSpeech,
    stopAudio,
    plugin.settings.voiceAutoSpeak,
    voiceMode.isLive,
    voiceMode.finishHandoff,
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
      plugin.settings.model = model;
      await plugin.saveSettings();
    },
    [setTabModel, plugin]
  );

  const handleEffortChange = useCallback(
    async (effort: string) => {
      setTabEffort(effort);
      plugin.settings.effortLevel = effort;
      await plugin.saveSettings();
    },
    [setTabEffort, plugin]
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
      plugin.settings.model = id;
      await plugin.saveSettings();
    },
    [setTabModel, plugin]
  );

  const handlePermissionModeChange = useCallback(
    async (mode: string) => {
      setTabPermissionMode(mode);
      plugin.settings.permissionMode = mode;
      await plugin.saveSettings();
    },
    [setTabPermissionMode, plugin]
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

  // --- Voice view derivations ---
  // The Blob's state comes from the mic/TTS state plus whether Chad is working.
  const blobState: BlobState =
    voiceMode.voiceState === "speaking"
      ? "speaking"
      : // Chad working (incl. while a sub-agent runs) beats "listening", so the
      // Blob shows it's busy rather than waiting for you.
      activeGenerating || voiceMode.voiceState === "thinking"
      ? "thinking"
      : voiceMode.voiceState === "listening"
      ? "listening"
      : "idle";

  const vvStateLabel =
    blobState === "listening"
      ? "Listening"
      : blobState === "thinking"
      ? "Thinking"
      : blobState === "speaking"
      ? "Speaking"
      : "Ready";
  const vvDoingLabel =
    blobState === "listening"
      ? "Go ahead…"
      : blobState === "thinking"
      ? "Working…"
      : blobState === "speaking"
      ? ""
      : "Tap the mic, or just talk";

  // Latest assistant turn — drives the on-screen overlay.
  let lastAssistantIdx = -1;
  for (let i = activeMessages.length - 1; i >= 0; i--) {
    const m = activeMessages[i];
    if (m.role === "assistant" && !m.isCompaction && !m.voice) {
      lastAssistantIdx = i;
      break;
    }
  }

  // Live call: each new tool call while Claude works becomes a silent
  // progress note to the voice (docs: "send an update when a step finishes
  // or a delay matters"), in plain words.
  const seenToolsRef = useRef<{ idx: number; count: number }>({ idx: -1, count: 0 });
  const { notifyProgress } = voiceMode;
  useEffect(() => {
    if (!voiceMode.isLive || !activeGenerating) return;
    let idx = -1;
    for (let i = activeMessages.length - 1; i >= 0; i--) {
      const m = activeMessages[i];
      if (m.role === "assistant" && !m.isCompaction && !m.voice) {
        idx = i;
        break;
      }
    }
    if (idx === -1) return;
    const tcs = activeMessages[idx].toolCalls || [];
    const seen = seenToolsRef.current.idx === idx ? seenToolsRef.current.count : 0;
    if (tcs.length > seen) {
      const t = tcs[tcs.length - 1];
      notifyProgress(describeToolForVoice(t.name, t.input));
    }
    seenToolsRef.current = { idx, count: tcs.length };
  }, [activeMessages, activeGenerating, voiceMode.isLive, notifyProgress]);

  // Live call: the one line under the Blob. Only while Claude has a hand-off,
  // and it says whether a sub-agent is on it.
  let vvWorking = "";
  if (voiceMode.isLive && activeGenerating) {
    vvWorking = "Working on it";
    const tcs = lastAssistantIdx >= 0 ? activeMessages[lastAssistantIdx].toolCalls || [] : [];
    const agentCall = [...tcs].reverse().find(
      (t) => (t.name === "Agent" || t.name === "Task") && t.result === null
    );
    if (agentCall) {
      const desc = String(agentCall.input?.description || "").trim();
      vvWorking = desc ? `Sub-agent running: ${desc}` : "Sub-agent running";
    }
  }
  const lastScreens =
    inVoiceView && lastAssistantIdx >= 0
      ? parseVoiceResponse(activeMessages[lastAssistantIdx].content || "").screens
      : [];
  // Dismissing hides the overlay but keeps it recoverable via a pill.
  const screensDismissed =
    lastScreens.length > 0 && lastAssistantIdx === dismissedScreenIdx;
  const vvScreens = screensDismissed ? [] : lastScreens;

  // Latest unresolved permission ask — surfaced in the voice view so it can't
  // get buried while the transcript is hidden.
  let vvPermission: VoicePermission | null = null;
  if (inVoiceView) {
    for (let i = activeMessages.length - 1; i >= 0 && !vvPermission; i--) {
      const reqs = activeMessages[i].permissionRequests;
      const pending = reqs?.find((r) => !r.resolved);
      if (pending) {
        const cmd = (pending.input as any)?.command;
        vvPermission = {
          requestId: pending.requestId,
          description:
            pending.toolName === "Bash" && cmd
              ? `Hyo wants to run: ${cmd}`
              : `Hyo wants to use ${pending.toolName}.`,
        };
      }
    }
  }

  // Pending multiple-choice question (askQuestion is cleared to null when
  // answered) — surface it in the voice view too.
  let vvQuestion: AskQuestionData | null = null;
  if (inVoiceView) {
    for (let i = activeMessages.length - 1; i >= 0; i--) {
      if (activeMessages[i].askQuestion) {
        vvQuestion = activeMessages[i].askQuestion!;
        break;
      }
    }
  }

  // Chime when a NEW permission ask OR question appears in voice mode — she may
  // not be looking at the screen.
  const attentionId = vvPermission?.requestId ?? vvQuestion?.id ?? null;
  const attentionText = vvPermission
    ? `A permission ask is on the user's screen: ${vvPermission.description} Tell them to allow or deny it on screen.`
    : vvQuestion
    ? "The agent is asking the user a multiple-choice question on screen. Tell them to answer it there."
    : "";
  const { notifyAttention } = voiceMode;
  useEffect(() => {
    if (attentionId && attentionId !== prevPermIdRef.current && inVoiceView) {
      playPermissionChime();
      // On a live call the voice can say it, too — she may not be looking.
      if (attentionText) notifyAttention(attentionText);
    }
    prevPermIdRef.current = attentionId;
  }, [attentionId, inVoiceView, attentionText, notifyAttention]);

  // The History screen is a full-panel view you scroll, reached from the clock
  // button. Side-panel width rules out split view, so opening a task drops back
  // into the conversation.
  if (viewMode === "tasks" && !inVoiceView) {
    return (
      <div className="hyo-chat-panel">
        <ChatTabs
          tabs={tabs}
          activeTabId={activeTabId}
          onSwitch={switchToChatTab}
          onClose={closeTab}
          onRename={renameTab}
          onReorder={reorderTab}
          pastSessions={pastSessions}
          tasks={taskMeta}
          onOpenTaskScreen={toggleTaskScreen}
          taskMode
          onRefreshPastSessions={refreshPastSessions}
          onNewTab={handleNewTask}
        />
        <TaskScreen
          tabs={tabs}
          pastSessions={pastSessions}
          tasks={taskMeta}
          onOpenTask={handleOpenTask}
          onCloseTask={handleCloseTask}
          onTogglePin={handleTogglePin}
          onRenameTask={handleRenameTask}
          onSearchText={searchPastText}
          onRefresh={refreshPastSessions}
        />
        {showReleaseNotes && (
          <ReleaseNotes onClose={() => setShowReleaseNotes(false)} />
        )}
      </div>
    );
  }

  // A GPT-Live call is one immersive surface: the voice view carries its own
  // controls, and the chat footer and status bar step out of the way.
  const immersiveCall = inVoiceView && voiceMode.isLive && !showTranscript;
  const endVoice = () => {
    voiceMode.stopConversation();
    // The last spoken turns land in state on the next tick; save them then.
    setTimeout(flushVoiceTurns, 50);
    setShowTranscript(false);
    toggleVoiceMode();
  };

  return (
    <div
      className={`hyo-chat-panel${dragging ? " hyo-drag-over" : ""}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {!inVoiceView && (
        <ChatTabs
          tabs={tabs}
          activeTabId={activeTabId}
          onSwitch={switchTab}
          onClose={closeTab}
          onRename={renameTab}
          onReorder={reorderTab}
          pastSessions={pastSessions}
          tasks={taskMeta}
          onOpenTaskScreen={toggleTaskScreen}
          onRefreshPastSessions={refreshPastSessions}
          onNewTab={newTab}
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

      {inVoiceView && !showTranscript ? (
        <VoiceView
          state={blobState}
          stateLabel={vvStateLabel}
          doingLabel={vvDoingLabel}
          live={
            voiceMode.isLive
              ? {
                  side: voiceMode.liveSide,
                  level: voiceMode.liveLevel,
                  // Loading from the first frame of the view until the voice
                  // has spoken; nothing in between counts as "on".
                  on: voiceMode.liveStatus === "live",
                  working: voiceMode.liveStatus !== "live" ? "Connecting…" : vvWorking,
                  muted: voiceMode.micMuted,
                  onToggleMute: voiceMode.toggleMute,
                  onToggleTranscript: () => setShowTranscript(true),
                  onEnd: endVoice,
                }
              : undefined
          }
          screens={vvScreens}
          onDismissScreens={() => setDismissedScreenIdx(lastAssistantIdx)}
          hasHiddenScreens={screensDismissed}
          onShowScreens={() => setDismissedScreenIdx(-1)}
          permission={vvPermission}
          onPermission={sendPermissionResponse}
          question={vvQuestion}
          onAnswer={sendQuestionAnswer}
          onNewConversation={() => {
            newTab();
            toggleVoiceMode();
          }}
        />
      ) : inVoiceView && showTranscript ? (
        <>
          <div className="hyo-vv-backbar">
            <a role="button" onClick={() => setShowTranscript(false)}>
              ‹ Back to voice
            </a>
            <span>Transcript</span>
          </div>
          {activeMessages.length > 0 ? (
            <ChatMessages
              messages={activeMessages}
              scrollRef={scrollRef}
              onPermissionResponse={sendPermissionResponse}
              onQuestionAnswer={sendQuestionAnswer}
              onRecover={() => recoverSession(activeTabId)}
              onClaudeUpdate={runClaudeUpdate}
            />
          ) : (
            <div className="hyo-messages">
              <div className="hyo-empty-state">
                <p>Nothing said yet</p>
              </div>
            </div>
          )}
        </>
      ) : activeMessages.length > 0 ? (
        <ChatMessages
          messages={activeMessages}
          scrollRef={scrollRef}
          onPermissionResponse={sendPermissionResponse}
          onQuestionAnswer={sendQuestionAnswer}
          onClaudeUpdate={runClaudeUpdate}
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

      {!immersiveCall && <div className="hyo-input-area">
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

        {activeVoiceMode && hasVoiceApiKey ? (
          <VoiceControls
            voiceState={voiceMode.voiceState}
            isPaused={voiceMode.isPaused}
            hasLastAudio={voiceMode.hasLastAudio}
            currentSpeed={voiceMode.currentSpeed}
            onRecordClick={voiceMode.toggleMute}
            micMuted={voiceMode.micMuted}
            live={voiceMode.isLive}
            onStop={voiceMode.stopAudio}
            onTogglePause={voiceMode.togglePause}
            onReplay={voiceMode.replay}
            onCycleSpeed={voiceMode.cycleSpeed}
            showingTranscript={showTranscript}
            onToggleTranscript={() => setShowTranscript((v) => !v)}
            onEnd={endVoice}
          />
        ) : (
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
                accept="image/*,.pdf,.xlsx,.xls,.xlsm,.txt,.md,.json,.csv,.yaml,.yml,.toml,.xml,.html,.css,.js,.ts,.py,.rb,.go,.rs,.sh,.log"
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
              {activeGenerating ? (
                <button
                  className="hyo-send-btn hyo-stop"
                  title="Stop generation"
                  onClick={stopGeneration}
                >
                  <svg width="16" height="16" viewBox="0 0 16 16">
                    <rect x="3" y="3" width="10" height="10" rx="1" fill="currentColor" />
                  </svg>
                </button>
              ) : (
                <button
                  className="hyo-send-btn"
                  title="Send (Enter)"
                  onClick={handleSend}
                >
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                    <path
                      d="M8 14V2M8 2L3 7M8 2L13 7"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </button>
              )}
            </div>
          </>
        )}
      </div>}

      {!immersiveCall && <HyoStatusBar
        model={activeModel}
        effort={activeEffort}
        permissionMode={activePermissionMode}
        agent={activeAgent}
        inputTokens={activeInputTokens}
        contextWindow={activeContextWindow}
        voiceMode={activeVoiceMode}
        hasVoiceApiKey={hasVoiceApiKey}
        customModels={customModels}
        onModelChange={handleModelChange}
        onEffortChange={handleEffortChange}
        onAddCustomModel={handleAddCustomModel}
        onPermissionModeChange={handlePermissionModeChange}
        onAgentChange={setTabAgent}
        onVoiceModeToggle={toggleVoiceMode}
        onCompact={compact}
      />}
    </div>
  );
}
