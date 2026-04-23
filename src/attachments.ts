import * as fs from "fs";
import * as path from "path";

// Rough heuristic: 1 token ≈ 4 characters (English/code).
// Good enough for chip display and inline/reference routing.
const TOKEN_CHAR_RATIO = 4;

// Files under this estimated size get inlined into the message text.
// Files over this size get written to disk; Claude reads them via the Read tool.
export const INLINE_THRESHOLD_TOKENS = 5000;

export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / TOKEN_CHAR_RATIO);
}

export function formatTokens(tokens: number): string {
  if (tokens < 1000) return `~${tokens}t`;
  return `~${(tokens / 1000).toFixed(tokens < 10000 ? 1 : 0)}kt`;
}

export function shouldInline(content: string): boolean {
  return estimateTokens(content) < INLINE_THRESHOLD_TOKENS;
}

export function writeAttachmentToDisk(
  attachmentsDir: string,
  filename: string,
  content: string
): string {
  fs.mkdirSync(attachmentsDir, { recursive: true });
  const timestamp = Date.now();
  const safeName = filename.replace(/[^a-zA-Z0-9.\-_]/g, "_");
  const filePath = path.join(attachmentsDir, `${timestamp}-${safeName}`);
  fs.writeFileSync(filePath, content, "utf-8");
  return filePath;
}

// Delete attachment files older than maxAgeDays. Safe because active sessions
// touch files far more recently than this; only stale files get removed.
export function cleanupOldAttachments(attachmentsDir: string, maxAgeDays = 1): void {
  if (!fs.existsSync(attachmentsDir)) return;
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  let removed = 0;
  try {
    for (const entry of fs.readdirSync(attachmentsDir)) {
      const filePath = path.join(attachmentsDir, entry);
      try {
        const stat = fs.statSync(filePath);
        if (stat.isFile() && stat.mtimeMs < cutoff) {
          fs.unlinkSync(filePath);
          removed++;
        }
      } catch {
        // Skip unreadable entries
      }
    }
    if (removed > 0) {
      console.log(`[hyo] Cleaned up ${removed} old attachment file(s)`);
    }
  } catch (e) {
    console.error("[hyo] Attachment cleanup failed:", e);
  }
}
