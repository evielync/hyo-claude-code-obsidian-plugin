import React, { useRef, useState, useCallback, useEffect, useMemo } from "react";
import type { App } from "obsidian";
import { Notice } from "obsidian";
import { ChatMessages } from "./ChatMessages";
import { ChatTabs } from "./ChatTabs";
import { TaskScreen } from "./TaskScreen";
import type { BoardTask } from "../task-state";
import type { TaskMeta } from "../../settings";
import type { useSessionManager } from "../hooks/useSessionManager";
import { useVoiceMode } from "../hooks/useVoiceMode";
import { parseVoiceResponse } from "../voice/voice-persona";
import { VoiceView, type BlobState, type VoicePermission } from "./VoiceView";
import { VoiceWaveform } from "./VoiceWaveform";
import { useSkills, type Skill } from "../hooks/useSkills";
import type HyoPlugin from "../../main";
import { estimateTokens, formatTokens } from "../attachments";
import { MODEL_OPTIONS } from "../../models";
import { useAgents } from "../hooks/useAgents";

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
  const {
    tabs,
    activeTabId,
    activeMessages,
    activeGenerating,
    activeVoiceMode,
    toggleVoiceMode,
    activeTabHasSession,
    newTab,
    closeTab,
    switchTab,
    renameTab,
    renamePastSession,
    setTaskMeta,
    setTaskMetaMany,
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
  } = sessionManager;

  // ---- Task mode (the History screen) ----
  const [viewMode, setViewMode] = useState<"chat" | "tasks">("chat");

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
    return m;
  }, [pastSessions]);

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

  // Close everything currently on the board. The list Hyo builds on a fresh
  // install is every conversation the CLI has ever written to disk, so the
  // first job is usually clearing the whole backlog at once. Reversible one at
  // a time: opening a closed conversation reopens it.
  const handleCloseAllTasks = useCallback(
    (tasks: BoardTask[]) => {
      const ids = tasks
        .map((t) => t.cliSessionId)
        .filter((id): id is string => !!id);
      if (ids.length)
        setTaskMetaMany(ids, {
          closed: true,
          lastActive: new Date().toISOString(),
        });
    },
    [setTaskMetaMany]
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

  const switchToChatTab = useCallback(
    (id: string) => {
      switchTab(id);
      setViewMode("chat");
    },
    [switchTab]
  );

  const [inputValues, setInputValues] = useState<Record<string, string>>({});
  const inputValue = inputValues[activeTabId] ?? "";
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // Voice-first view: flip to the transcript, and remember a dismissed overlay.
  const [showTranscript, setShowTranscript] = useState(false);
  const [dismissedScreenIdx, setDismissedScreenIdx] = useState(-1);
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
  const hasVoiceApiKey = !!plugin.settings.elevenLabsApiKey;
  const voiceMode = useVoiceMode({
    apiKey: plugin.settings.elevenLabsApiKey,
    voiceId: plugin.settings.voiceId,
    playbackSpeed: plugin.settings.voicePlaybackSpeed,
    isVoiceMode: activeVoiceMode,
    autoSpeak: activeVoiceMode,
    onTranscript: (text: string) => {
      if (activeVoiceMode) {
        // Walkie-talkie: send straight away — no glancing at the box, no
        // keyboard. Chad's reply gets spoken back by the effect below.
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
      setTimeout(() => {
        const el = inputRef.current;
        if (!el) return;
        el.style.height = "auto";
        el.style.height = Math.min(el.scrollHeight, 150) + "px";
      }, 50);
    },
  });

  // Walkie-talkie: speak Chad's reply once it finishes generating. Strip any
  // [SCREEN] detail so only the spoken summary is read aloud — the full reply
  // still shows in the chat. Whole-reply for now; streaming sentence-by-sentence
  // is a follow-up. Guarded to the voice-mode tab so text chats never speak.
  const prevGeneratingRef = useRef(false);
  const { speakResponse } = voiceMode;
  useEffect(() => {
    const finished = prevGeneratingRef.current && !activeGenerating;
    prevGeneratingRef.current = activeGenerating;
    if (!finished || !activeVoiceMode) return;
    let last: { role: string; content?: string; isCompaction?: boolean } | undefined;
    for (let i = activeMessages.length - 1; i >= 0; i--) {
      const m = activeMessages[i];
      if (m.role === "assistant" && !m.isCompaction) {
        last = m;
        break;
      }
    }
    if (!last) return;
    const spoken = parseVoiceResponse(last.content || "").spoken;
    if (spoken) speakResponse(spoken);
  }, [activeGenerating, activeVoiceMode, activeMessages, speakResponse]);

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
    if (!hasVoiceApiKey) {
      new Notice("Add your ElevenLabs API key in Hyo settings to use voice.");
      return;
    }
    if (voiceMode.voiceState === "idle") {
      pressStartRef.current = Date.now();
      heldCycleRef.current = true;
      voiceMode.startRecording();
    }
  }, [hasVoiceApiKey, voiceMode]);

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
      if (!hasVoiceApiKey) return;
      voiceMode.handleRecordClick();
    }
  }, [hasVoiceApiKey, voiceMode]);

  const handleVoiceModeToggle = useCallback(() => {
    if (!hasVoiceApiKey) {
      new Notice("Add your ElevenLabs API key in Hyo settings to use voice.");
      return;
    }
    toggleVoiceMode();
  }, [hasVoiceApiKey, toggleVoiceMode]);

  // Ask First toggle (plugin setting, sent with every prompt to the gateway)
  const handleAskFirstToggle = useCallback(() => {
    plugin.settings.askFirst = !plugin.settings.askFirst;
    void plugin.saveSettings();
  }, [plugin]);

  // Session settings chip — agent, model and permissions in one panel,
  // replacing the standalone Ask First toggle in the input bar. On a phone
  // there's no room for separate pickers, so they live behind one chip.
  const agents = useAgents(plugin.settings.gatewayUrl);
  const [sessionPanelOpen, setSessionPanelOpen] = useState(false);
  const currentAgent = plugin.settings.defaultAgent || agents[0]?.name || "default";
  const currentModel = plugin.settings.model || "claude-sonnet-5";
  const setAgent = useCallback((name: string) => {
    plugin.settings.defaultAgent = name;
    void plugin.saveSettings();
  }, [plugin]);
  const setModel = useCallback((value: string) => {
    plugin.settings.model = value;
    void plugin.saveSettings();
  }, [plugin]);
  const setAskFirst = useCallback((val: boolean) => {
    plugin.settings.askFirst = val;
    void plugin.saveSettings();
  }, [plugin]);

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

  // Slash command state (checks both .claude/skills and skills/)
  const skills = useSkills("");
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

  // --- Voice-first view derivations ---
  const inVoiceView = activeVoiceMode && hasVoiceApiKey;

  // The Blob's colour = state. Chad working (incl. transcribing / a running
  // sub-agent) beats "listening", so the Blob reads busy rather than waiting.
  const blobState: BlobState =
    voiceMode.voiceState === "speaking"
      ? "speaking"
      : activeGenerating || voiceMode.voiceState === "thinking"
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
      ? "Tap or release to send"
      : blobState === "thinking"
      ? "Working…"
      : blobState === "speaking"
      ? "Tap to stop"
      : voiceMode.voiceState === "error"
      ? voiceMode.errorMessage || "Didn't catch that — tap to try again"
      : "Hold to talk, or tap to start";
  // Can't talk over Chad while he's working (half-duplex). Speaking stays
  // enabled so a tap can stop playback and barge in.
  const talkDisabled = blobState === "thinking";

  // Latest assistant turn drives the on-screen overlay.
  let lastAssistantIdx = -1;
  for (let i = activeMessages.length - 1; i >= 0; i--) {
    const m = activeMessages[i];
    if (m.role === "assistant" && !m.isCompaction) {
      lastAssistantIdx = i;
      break;
    }
  }
  const lastScreens =
    inVoiceView && lastAssistantIdx >= 0
      ? parseVoiceResponse(activeMessages[lastAssistantIdx].content || "").screens
      : [];
  const screensDismissed =
    lastScreens.length > 0 && lastAssistantIdx === dismissedScreenIdx;
  const vvScreens = screensDismissed ? [] : lastScreens;

  // Latest unresolved permission / question, surfaced in the view so they
  // can't get buried while the transcript is hidden.
  let vvPermission: VoicePermission | null = null;
  let vvQuestion: typeof activeMessages[number]["askQuestion"] = null;
  if (inVoiceView) {
    outer: for (let i = activeMessages.length - 1; i >= 0; i--) {
      const prs = activeMessages[i].permissionRequests;
      if (!prs) continue;
      for (const pr of prs) {
        if (pr.resolved) continue;
        const cmd = (pr.input as any)?.command;
        vvPermission = {
          requestId: pr.requestId,
          description:
            pr.toolName === "Bash" && cmd
              ? `Hyo wants to run: ${cmd}`
              : `Hyo wants to use ${pr.toolName}.`,
        };
        break outer;
      }
    }
    for (let i = activeMessages.length - 1; i >= 0; i--) {
      const q = activeMessages[i].askQuestion;
      if (q) {
        vvQuestion = q;
        break;
      }
    }
  }

  // Chime when a NEW permission ask or question appears in voice mode — she may
  // not be looking at the phone.
  const attentionId = vvPermission?.requestId ?? vvQuestion?.id ?? null;
  const prevAttentionRef = useRef<string | null>(null);
  useEffect(() => {
    if (attentionId && attentionId !== prevAttentionRef.current && inVoiceView) {
      playPermissionChime();
    }
    prevAttentionRef.current = attentionId;
  }, [attentionId, inVoiceView]);

  // Task mode: the full-screen history view, with the bottom tab bar kept so
  // the clock/chat button can toggle back. Opening a task drops into it.
  if (viewMode === "tasks" && !inVoiceView) {
    return (
      <div className="hyo-chat-panel">
        <TaskScreen
          tabs={tabs}
          pastSessions={pastSessions}
          tasks={taskMeta}
          onOpenTask={handleOpenTask}
          onCloseTask={handleCloseTask}
          onCloseAllTasks={handleCloseAllTasks}
          onTogglePin={handleTogglePin}
          onRenameTask={handleRenameTask}
        />
        <ChatTabs
          tabs={tabs}
          activeTabId={activeTabId}
          onSwitch={switchToChatTab}
          onClose={closeTab}
          onRename={renameTab}
          pastSessions={pastSessions}
          tasks={taskMeta}
          onOpenTaskScreen={toggleTaskScreen}
          taskMode
          onRefreshPastSessions={refreshPastSessions}
          onNewTab={handleNewTask}
          gatewayUrl={plugin.settings.gatewayUrl}
        />
      </div>
    );
  }

  return (
    <div
      className={`hyo-chat-panel${dragging ? " hyo-drag-over" : ""}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {inVoiceView && !showTranscript ? (
        <VoiceView
          state={blobState}
          stateLabel={vvStateLabel}
          doingLabel={vvDoingLabel}
          screens={vvScreens}
          onDismissScreens={() => setDismissedScreenIdx(lastAssistantIdx)}
          hasHiddenScreens={screensDismissed}
          onShowScreens={() => setDismissedScreenIdx(-1)}
          permission={vvPermission}
          onPermission={sendPermissionResponse}
          question={vvQuestion ?? null}
          onAnswer={sendQuestionAnswer}
          onNewConversation={() => {
            newTab();
            toggleVoiceMode();
          }}
          onTalkPointerDown={handleMicPointerDown}
          onTalkPointerUp={handleMicPointerUp}
          talkDisabled={talkDisabled}
          onToggleTranscript={() => setShowTranscript(true)}
          onEndVoice={() => {
            voiceMode.stopAudio();
            setShowTranscript(false);
            toggleVoiceMode();
          }}
        />
      ) : (
        <>
          {inVoiceView && showTranscript && (
            <div className="hyo-vv-backbar">
              <a role="button" onClick={() => setShowTranscript(false)}>
                ‹ Back to voice
              </a>
              <span>Transcript</span>
            </div>
          )}
          {activeMessages.length > 0 ? (
            <ChatMessages
              messages={activeMessages}
              scrollRef={scrollRef}
              onPermissionResponse={sendPermissionResponse}
              onQuestionAnswer={sendQuestionAnswer}
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
                <p>Start a conversation</p>
              </div>
            </div>
          )}
        </>
      )}

      {!inVoiceView && (
        <ChatTabs
          tabs={tabs}
          activeTabId={activeTabId}
          onSwitch={switchTab}
          onClose={closeTab}
          onRename={renameTab}
          pastSessions={pastSessions}
          tasks={taskMeta}
          onOpenTaskScreen={toggleTaskScreen}
          onRefreshPastSessions={refreshPastSessions}
          onNewTab={newTab}
          gatewayUrl={plugin.settings.gatewayUrl}
        />
      )}

      <div className="hyo-input-area" style={inVoiceView ? { display: "none" } : undefined}>
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

            <button
              className={`hyo-voicemode-toggle${activeVoiceMode ? " active" : ""}`}
              title={
                activeVoiceMode
                  ? "Voice conversation on — talk and Hyo talks back. Tap to turn off."
                  : "Turn on voice conversation — Hyo speaks replies back to you"
              }
              onClick={handleVoiceModeToggle}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M2 10v4" />
                <path d="M6 6v12" />
                <path d="M10 3v18" />
                <path d="M14 8v8" />
                <path d="M18 5v14" />
                <path d="M22 10v4" />
              </svg>
            </button>

            <button
              className={`hyo-mic-btn${voiceMode.voiceState === "listening" ? " recording" : ""}${voiceMode.voiceState === "thinking" ? " thinking" : ""}${voiceMode.voiceState === "error" ? " error" : ""}`}
              title={
                !hasVoiceApiKey
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
              {MODEL_OPTIONS.map((m) => (
                <button key={m.id} className={`hyo-session-opt${currentModel === m.id ? " sel" : ""}`} onClick={() => setModel(m.id)}>
                  <span className="hyo-session-opt-name">{m.name}</span>
                  {currentModel === m.id && <span className="hyo-session-opt-tick">✓</span>}
                </button>
              ))}
            </div>
            <div className="hyo-session-sec">
              <div className="hyo-session-sec-label">Permissions</div>
              <button className={`hyo-session-opt${plugin.settings.askFirst ? " sel" : ""}`} onClick={() => setAskFirst(true)}>
                <span className="hyo-session-opt-name">Ask first</span>
                {plugin.settings.askFirst && <span className="hyo-session-opt-tick">✓</span>}
              </button>
              <button className={`hyo-session-opt${!plugin.settings.askFirst ? " sel" : ""}`} onClick={() => setAskFirst(false)}>
                <span className="hyo-session-opt-name">Auto-approve</span>
                {!plugin.settings.askFirst && <span className="hyo-session-opt-tick">✓</span>}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
