import * as fs from "fs";
import * as path from "path";
import * as os from "os";

export interface PastSession {
  id: string;
  title: string;
  date: Date;
  size: number;
}

export function getProjectDir(cwd: string): string {
  const hash = cwd.replace(/\//g, "-");
  return path.join(os.homedir(), ".claude", "projects", hash);
}

function getMetadataPath(cwd: string): string {
  return path.join(getProjectDir(cwd), "session-metadata.json");
}

interface SessionMetadata {
  [sessionId: string]: {
    customTitle?: string;
  };
}

function loadMetadata(cwd: string): SessionMetadata {
  const metaPath = getMetadataPath(cwd);
  try {
    if (fs.existsSync(metaPath)) {
      return JSON.parse(fs.readFileSync(metaPath, "utf-8"));
    }
  } catch (e) {
    console.error("[hyo] Failed to load metadata:", e);
  }
  return {};
}

function saveMetadata(cwd: string, metadata: SessionMetadata): void {
  const metaPath = getMetadataPath(cwd);
  try {
    fs.writeFileSync(metaPath, JSON.stringify(metadata, null, 2), "utf-8");
  } catch (e) {
    console.error("[hyo] Failed to save metadata:", e);
  }
}

export function saveCustomTitle(cwd: string, sessionId: string, title: string): void {
  const metadata = loadMetadata(cwd);
  if (!metadata[sessionId]) metadata[sessionId] = {};
  metadata[sessionId].customTitle = title;
  saveMetadata(cwd, metadata);
}

function getCustomTitle(cwd: string, sessionId: string): string | null {
  const metadata = loadMetadata(cwd);
  return metadata[sessionId]?.customTitle || null;
}

export function listPastSessions(cwd: string): PastSession[] {
  const dir = getProjectDir(cwd);
  try {
    if (!fs.existsSync(dir)) return [];
  } catch {
    return [];
  }

  let entries: { name: string; fullPath: string; stat: fs.Stats }[];
  try {
    entries = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => {
        const fullPath = path.join(dir, f);
        return { name: f, fullPath, stat: fs.statSync(fullPath) };
      })
      .filter((f) => f.stat.size > 500);
  } catch {
    return [];
  }

  entries.sort((a, b) => b.stat.mtime.getTime() - a.stat.mtime.getTime());
  entries = entries.slice(0, 50);

  return entries.map((f) => {
    const sessionId = f.name.replace(".jsonl", "");
    const customTitle = getCustomTitle(cwd, sessionId);
    const title = customTitle || extractTitle(f.fullPath) || "Untitled";

    return {
      id: sessionId,
      title,
      date: f.stat.mtime,
      size: f.stat.size,
    };
  });
}

export interface HistoryMessage {
  role: "user" | "assistant";
  content: string;
  displayText?: string;
  attachments?: { type: string; name: string }[];
  thinking?: string;
  toolCalls?: { id: string; name: string; input: any; result: string | null }[];
  orderedBlocks?: { type: "text" | "thinking" | "tool"; content?: string; toolId?: string; turnIndex: number }[];
}

export function loadSessionHistory(cwd: string, sessionId: string): HistoryMessage[] {
  const dir = getProjectDir(cwd);
  const filePath = path.join(dir, `${sessionId}.jsonl`);
  try {
    if (!fs.existsSync(filePath)) return [];
  } catch {
    return [];
  }

  const messages: HistoryMessage[] = [];
  const pendingToolResults = new Map<string, string>();

  try {
    const text = fs.readFileSync(filePath, "utf8");
    const lines = text.split("\n");

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const d = JSON.parse(line);

        if (d.type === "user") {
          const content = d.message?.content;
          if (!content) continue;

          // Check if this is a tool_result message
          if (Array.isArray(content) && content.some((c: any) => c.type === "tool_result")) {
            for (const c of content) {
              if (c.type === "tool_result" && c.tool_use_id) {
                const result = typeof c.content === "string" ? c.content : JSON.stringify(c.content);
                pendingToolResults.set(c.tool_use_id, result);
              }
            }
            // Wire results to previous assistant's tool calls
            for (let i = messages.length - 1; i >= 0; i--) {
              if (messages[i].role === "assistant" && messages[i].toolCalls?.length) {
                for (const tc of messages[i].toolCalls!) {
                  const result = pendingToolResults.get(tc.id);
                  if (result !== undefined) tc.result = result;
                }
                break;
              }
            }
            pendingToolResults.clear();
            continue;
          }

          // Regular user message
          let rawText = "";
          const attachments: { type: string; name: string }[] = [];

          if (Array.isArray(content)) {
            // Extract text blocks
            rawText = content
              .filter((c: any) => c.type === "text")
              .map((c: any) => c.text || "")
              .join("")
              .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
              .replace(/<ide_[^>]*>[\s\S]*?<\/ide_[^>]*>/g, "")
              .trim();

            // Extract file attachments from document blocks (Claude Code desktop format)
            for (const c of content) {
              if (c.type === "document" && c.title) {
                attachments.push({ type: "file", name: c.title });
              } else if (c.type === "image") {
                attachments.push({ type: "image", name: "image" });
              }
            }
          } else if (typeof content === "string") {
            rawText = content.trim();
          }

          // Extract file names from inline markers (Hyo plugin format)
          // New format: <file name="filename.md">content</file>
          // Old format: [File: filename.md]\ncontent
          const xmlFileRegex = /<file\s+name="([^"]+)">[\s\S]*?<\/file>/g;
          const oldFileRegex = /\[File:\s*([^\]]+)\]/g;

          let match;
          while ((match = xmlFileRegex.exec(rawText)) !== null) {
            attachments.push({ type: "file", name: match[1].trim() });
          }
          while ((match = oldFileRegex.exec(rawText)) !== null) {
            attachments.push({ type: "file", name: match[1].trim() });
          }

          // Extract displayText: remove file blocks
          let displayText = rawText;
          if (attachments.length > 0) {
            // Remove XML-style file blocks
            displayText = displayText.replace(/<file\s+name="[^"]+">[\s\S]*?<\/file>/g, "");

            // Remove old [File: ...] style blocks
            // Handle both formats:
            // New: <user message>\n\n[File: name]\n<content> (message first)
            // Old: [File: name]\n<content>\n\n<user message> (files first)

            if (displayText.trim().startsWith("[File:")) {
              // Old format: files first, message at end
              // Remove markers, take last paragraph
              const withoutMarkers = displayText.replace(/\[File:[^\]]+\]\n/g, "");
              const parts = withoutMarkers.split(/\n\n+/).filter(p => p.trim());
              displayText = parts.length > 0 ? parts[parts.length - 1].trim() : "";
            } else {
              // New format: message first
              // Take everything before first [File: marker
              const firstFileIndex = displayText.indexOf("[File:");
              if (firstFileIndex !== -1) {
                displayText = displayText.substring(0, firstFileIndex).trim();
              }
            }
          }

          if (displayText || attachments.length > 0) {
            messages.push({
              role: "user",
              content: displayText,
              displayText: displayText,
              attachments: attachments.length > 0 ? attachments : undefined,
            });
          }
        }

        if (d.type === "assistant") {
          const content = d.message?.content || [];
          const textParts: string[] = [];
          const thinkingParts: string[] = [];
          const toolCalls: HistoryMessage["toolCalls"] = [];
          const orderedBlocks: HistoryMessage["orderedBlocks"] = [];
          let turnIndex = 0;

          for (const block of content) {
            if (block.type === "text" && block.text) {
              textParts.push(block.text);
              orderedBlocks!.push({ type: "text", content: block.text, turnIndex });
            } else if (block.type === "thinking" && block.thinking) {
              thinkingParts.push(block.thinking);
              orderedBlocks!.push({ type: "thinking", content: block.thinking, turnIndex });
            } else if (block.type === "tool_use") {
              toolCalls!.push({
                id: block.id,
                name: block.name,
                input: block.input,
                result: null,
              });
              orderedBlocks!.push({ type: "tool", toolId: block.id, turnIndex });
            }
          }

          const text = textParts.join("");
          if (text || toolCalls!.length > 0) {
            messages.push({
              role: "assistant",
              content: text,
              thinking: thinkingParts.join(""),
              toolCalls,
              orderedBlocks,
            });
          }
        }
      } catch {
        continue;
      }
    }
  } catch {
    // ignore
  }

  return messages;
}

function extractTitle(filePath: string): string | null {
  try {
    const fd = fs.openSync(filePath, "r");
    const buf = Buffer.alloc(10240);
    const bytesRead = fs.readSync(fd, buf, 0, 10240, 0);
    fs.closeSync(fd);

    const text = buf.toString("utf8", 0, bytesRead);
    const lines = text.split("\n");

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const d = JSON.parse(line);
        if (d.type === "user") {
          const content = d.message?.content;
          let textTitle: string | null = null;
          let fileNames: string[] = [];

          if (Array.isArray(content)) {
            let rawText = "";
            // Extract text blocks
            for (const c of content) {
              if (c.type === "text" && c.text) {
                rawText = c.text
                  .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
                  .replace(/<ide_[^>]*>[\s\S]*?<\/ide_[^>]*>/g, "")
                  .trim();
              }
              // Extract file names from document blocks (Claude Code desktop)
              if (c.type === "document" && c.title) {
                fileNames.push(c.title);
              }
            }

            // Extract file names from inline markers (Hyo plugin)
            // New format: <file name="filename.md">content</file>
            // Old format: [File: filename.md]
            const xmlFileRegex = /<file\s+name="([^"]+)">[\s\S]*?<\/file>/g;
            const oldFileRegex = /\[File:\s*([^\]]+)\]/g;

            let match;
            while ((match = xmlFileRegex.exec(rawText)) !== null) {
              fileNames.push(match[1].trim());
            }
            while ((match = oldFileRegex.exec(rawText)) !== null) {
              fileNames.push(match[1].trim());
            }

            // Extract displayText (user's actual message without file content)
            if (rawText) {
              // Remove XML-style file blocks first
              let cleaned = rawText.replace(/<file\s+name="[^"]+">[\s\S]*?<\/file>/g, "");

              // Simple extraction: take everything before first [File: marker
              const firstFileIndex = cleaned.indexOf("[File:");
              if (firstFileIndex > 0) {
                textTitle = cleaned.substring(0, firstFileIndex).replace(/^#+\s*/gm, "").trim();
              } else {
                textTitle = cleaned.replace(/^#+\s*/gm, "").trim();
              }
            }

            // Prefer text title, fall back to first file name
            if (textTitle) {
              return textTitle.slice(0, 60).replace(/\n/g, " ").trim();
            }
            if (fileNames.length > 0) {
              return fileNames[0].slice(0, 60);
            }
          } else if (typeof content === "string") {
            return content.slice(0, 60).replace(/\n/g, " ").trim();
          }
        }
      } catch {
        continue;
      }
    }
  } catch {
    // ignore
  }
  return null;
}
