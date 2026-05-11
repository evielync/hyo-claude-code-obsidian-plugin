import * as fs from "fs";

// Detects and repairs the "thinking block poisoning" failure mode.
//
// Trigger: a single assistant turn hits the output token cap mid-stream.
// Claude Code writes the truncated turn's signed `thinking` block to the .jsonl
// even though the turn never completed. The orphan stays in the conversation
// history forever, and every subsequent API call rejects with:
//   messages.N.content.M: `thinking` or `redacted_thinking` blocks in the
//   latest assistant message cannot be modified.
//
// Repair: drop the orphan + the cap-error marker + any failed retries that
// followed, repair parent UUID linkage, return the user text from the first
// failed retry so the UI can prefill the input.

export const THINKING_BLOCK_ERROR_RE =
  /`?thinking`? or `?redacted_thinking`? blocks in the latest assistant message cannot be modified/i;

export const OUTPUT_CAP_RE = /exceeded the \d+ output token maximum/i;

export interface RepairResult {
  success: boolean;
  linesRemoved: number;
  capturedUserText: string | null;
  reason?: string;
}

interface JsonlEntry {
  type?: string;
  uuid?: string;
  parentUuid?: string;
  message?: {
    id?: string;
    role?: string;
    content?: any;
  };
}

function parseLine(line: string): JsonlEntry | null {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function getAssistantText(d: JsonlEntry): string {
  const content = d.message?.content;
  if (!Array.isArray(content)) return "";
  for (const b of content) {
    if (b && b.type === "text" && typeof b.text === "string") return b.text;
  }
  return "";
}

function getUserText(d: JsonlEntry): string {
  const content = d.message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  for (const b of content) {
    if (b && b.type === "text" && typeof b.text === "string") return b.text;
  }
  return "";
}

function isCapError(d: JsonlEntry): boolean {
  return d.type === "assistant" && OUTPUT_CAP_RE.test(getAssistantText(d));
}

function isThinkingBlockError(d: JsonlEntry): boolean {
  return (
    d.type === "assistant" && THINKING_BLOCK_ERROR_RE.test(getAssistantText(d))
  );
}

function isOrphanedThinking(d: JsonlEntry): boolean {
  // An assistant line whose ONLY content block is `thinking`. In a healthy
  // turn, thinking is always followed by text or tool_use blocks before the
  // turn ends. A standalone thinking line is the residue of a truncated turn.
  if (d.type !== "assistant") return false;
  const content = d.message?.content;
  if (!Array.isArray(content) || content.length !== 1) return false;
  return content[0]?.type === "thinking";
}

function stripUserMessageNoise(text: string): string {
  // Remove system-injected wrappers so the prefilled input shows what the
  // user actually typed.
  return text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
    .replace(/<ide_[^>]*>[\s\S]*?<\/ide_[^>]*>/g, "")
    .replace(/<local-command-[^>]*>[\s\S]*?<\/local-command-[^>]*>/g, "")
    .trim();
}

// Walk the file and identify lines to drop:
// 1. Orphaned `thinking`-only assistant lines that immediately precede a cap-error
// 2. The cap-error marker itself
// 3. Failed retry user/assistant pairs after the corruption (where the assistant
//    response is a thinking-block API error)
// Also captures the *first* failed retry's user text so we can prefill the input.
export function analyzeJsonl(jsonlPath: string):
  | {
      removeIndices: Set<number>;
      capturedUserText: string | null;
      hasCorruption: boolean;
    }
  | null {
  if (!fs.existsSync(jsonlPath)) return null;

  const lines = fs.readFileSync(jsonlPath, "utf8").split("\n");
  const removeIndices = new Set<number>();
  let capturedUserText: string | null = null;
  let hasCorruption = false;

  // Pass 1: find orphaned thinking + cap-error pairs.
  // Pattern: assistant(thinking-only) immediately followed by assistant(cap-error).
  for (let i = 0; i < lines.length - 1; i++) {
    if (!lines[i].trim()) continue;
    const cur = parseLine(lines[i]);
    if (!cur) continue;

    if (isOrphanedThinking(cur)) {
      // Look ahead for the cap-error within the next few lines (skipping non-assistant entries)
      for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
        const next = parseLine(lines[j]);
        if (!next) continue;
        if (isCapError(next)) {
          removeIndices.add(i);
          removeIndices.add(j);
          hasCorruption = true;
          break;
        }
        // If we hit another regular assistant or user line first, this thinking
        // wasn't from a cap-truncated turn.
        if (next.type === "user" || next.type === "assistant") break;
      }
    }
  }

  // Pass 2: find failed retry pairs (user message followed by thinking-block API error).
  for (let i = 0; i < lines.length - 1; i++) {
    if (!lines[i].trim()) continue;
    const cur = parseLine(lines[i]);
    if (!cur || cur.type !== "user") continue;

    // Look at the next assistant entry
    for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
      const next = parseLine(lines[j]);
      if (!next) continue;
      if (next.type === "assistant" && isThinkingBlockError(next)) {
        // Capture the FIRST failed user retry text for prefill
        if (capturedUserText === null) {
          const text = stripUserMessageNoise(getUserText(cur));
          if (text) capturedUserText = text;
        }
        removeIndices.add(i);
        removeIndices.add(j);
        hasCorruption = true;
        break;
      }
      if (next.type === "user" || next.type === "assistant") break;
    }
  }

  // Pass 3: also drop trailing queue-operation/progress entries that were
  // tied to the failed retries. These have no message content, but they
  // pollute the file. Only drop them if they're after the last surviving
  // real message AND we already detected corruption.
  if (hasCorruption) {
    let lastSurvivingMessage = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (removeIndices.has(i)) continue;
      const d = parseLine(lines[i]);
      if (!d) continue;
      if (d.type === "user" || d.type === "assistant") {
        lastSurvivingMessage = i;
        break;
      }
    }
    for (let i = lastSurvivingMessage + 1; i < lines.length; i++) {
      if (!lines[i].trim()) continue;
      const d = parseLine(lines[i]);
      if (!d) continue;
      if (d.type === "queue-operation" || d.type === "progress") {
        removeIndices.add(i);
      }
    }
  }

  return { removeIndices, capturedUserText, hasCorruption };
}

export function repairSession(jsonlPath: string): RepairResult {
  const analysis = analyzeJsonl(jsonlPath);
  if (!analysis) {
    return { success: false, linesRemoved: 0, capturedUserText: null, reason: "Session file not found" };
  }
  if (!analysis.hasCorruption) {
    return { success: false, linesRemoved: 0, capturedUserText: null, reason: "No corruption detected" };
  }

  // Backup before modifying
  const backupPath = `${jsonlPath}.bak-${Date.now()}`;
  try {
    fs.copyFileSync(jsonlPath, backupPath);
  } catch (e: any) {
    return { success: false, linesRemoved: 0, capturedUserText: null, reason: `Backup failed: ${e.message}` };
  }

  const lines = fs.readFileSync(jsonlPath, "utf8").split("\n");

  // Map original uuid -> kept index (so we can repair parent links)
  const kept: { idx: number; line: string; entry: JsonlEntry | null }[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (analysis.removeIndices.has(i)) continue;
    if (!lines[i].trim()) continue;
    kept.push({ idx: i, line: lines[i], entry: parseLine(lines[i]) });
  }

  const survivingUuids = new Set<string>();
  for (const k of kept) {
    if (k.entry?.uuid) survivingUuids.add(k.entry.uuid);
  }

  // Repair parent linkage: any kept entry whose parentUuid points to a removed
  // line gets repointed to the previous kept line's uuid.
  const repaired: string[] = [];
  let prevUuid: string | undefined;
  for (const k of kept) {
    let line = k.line;
    if (k.entry) {
      const parent = k.entry.parentUuid;
      if (parent && !survivingUuids.has(parent) && prevUuid) {
        const patched = { ...k.entry, parentUuid: prevUuid };
        line = JSON.stringify(patched);
      }
      if (k.entry.uuid) prevUuid = k.entry.uuid;
    }
    repaired.push(line);
  }

  try {
    fs.writeFileSync(jsonlPath, repaired.join("\n") + "\n", "utf8");
  } catch (e: any) {
    return {
      success: false,
      linesRemoved: 0,
      capturedUserText: null,
      reason: `Write failed: ${e.message}`,
    };
  }

  return {
    success: true,
    linesRemoved: analysis.removeIndices.size,
    capturedUserText: analysis.capturedUserText,
  };
}

export function isThinkingBlockApiError(errorText: string): boolean {
  return THINKING_BLOCK_ERROR_RE.test(errorText);
}
