// Rough heuristic: 1 token ≈ 4 characters (English/code).
// Good enough for chip display and inline/reference routing.
const TOKEN_CHAR_RATIO = 4;

// Files under this estimated size get inlined into the message text.
// Desktop wrote files over this size to disk instead and pointed Claude at
// them via the Read tool. There's no disk to write to on mobile (and no
// gateway RPC for it), so this threshold is currently informational only —
// see ChatPanel.tsx, which now always inlines text attachments.
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
