import React, { useRef, useState, useCallback, useEffect, useMemo } from "react";
import type { App } from "obsidian";
import { Notice } from "obsidian";
import { ChatMessages } from "./ChatMessages";
import { ChatTabs } from "./ChatTabs";
import { SessionDropdown } from "./SessionDropdown";
import { HyoStatusBar } from "./HyoStatusBar";
import type { useSessionManager } from "../hooks/useSessionManager";
import { useSkills, type Skill } from "../hooks/useSkills";
import type HyoPlugin from "../main";
import {
  estimateTokens,
  formatTokens,
  shouldInline,
  writeAttachmentToDisk,
} from "../attachments";
import * as path from "path";

interface AttachedFile {
  name: string;
  fileType: "text" | "image" | "pdf";
  content?: string;       // text files
  mediaType?: string;     // image files / pdf
  data?: string;          // image files / pdf — base64
}

interface ChatPanelProps {
  sessionManager: ReturnType<typeof useSessionManager>;
  plugin: HyoPlugin;
  app: App;
}

export function ChatPanel({ sessionManager, plugin, app }: ChatPanelProps) {
  const {
    tabs,
    activeTabId,
    activeMessages,
    activeGenerating,
    activeModel,
    activePermissionMode,
    activeAgent,
    activeTabHasSession,
    activeInputTokens,
    activeContextWindow,
    newTab,
    closeTab,
    switchTab,
    renameTab,
    setTabModel,
    setTabPermissionMode,
    setTabAgent,
    sendMessage,
    sendPermissionResponse,
    sendQuestionAnswer,
    stopGeneration,
    compact,
    pastSessions,
    openPastSession,
    refreshPastSessions,
    scrollRef,
  } = sessionManager;

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

  // Slash command state (checks both .claude/skills and skills/)
  const skills = useSkills(workingDirectory);
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

  const handleModelChange = useCallback(
    async (model: string) => {
      setTabModel(model);
      plugin.settings.model = model;
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
      addFile({ name: file.name, content });
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
      textParts.push(`[File: ${f.name}]\n${f.content}`);
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
      sendMessage(blocks as any, meta);
    } else {
      sendMessage(messageText, meta);
    }
  }, [inputValues, activeTabId, attachedFiles, sendMessage, attachmentsDir]);

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

  return (
    <div
      className={`hyo-chat-panel${dragging ? " hyo-drag-over" : ""}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <ChatTabs
        tabs={tabs}
        activeTabId={activeTabId}
        onSwitch={switchTab}
        onClose={closeTab}
        onRename={renameTab}
        pastSessions={pastSessions}
        onOpenPastSession={openPastSession}
        onRefreshPastSessions={refreshPastSessions}
        onNewTab={newTab}
      />

      {activeMessages.length > 0 ? (
        <ChatMessages
          messages={activeMessages}
          scrollRef={scrollRef}
          onPermissionResponse={sendPermissionResponse}
          onQuestionAnswer={sendQuestionAnswer}
        />
      ) : (
        <div className="hyo-messages">
          <div className="hyo-empty-state">
            <p>Start a conversation with Claude</p>
          </div>
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
      </div>

      <HyoStatusBar
        model={activeModel}
        permissionMode={activePermissionMode}
        agent={activeAgent}
        inputTokens={activeInputTokens}
        contextWindow={activeContextWindow}
        onModelChange={handleModelChange}
        onPermissionModeChange={handlePermissionModeChange}
        onAgentChange={setTabAgent}
        onCompact={compact}
      />
    </div>
  );
}
