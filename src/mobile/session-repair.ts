// Detects the "thinking block poisoning" failure mode (a truncated turn
// leaves an orphaned signed `thinking` block in the session, which then
// makes every subsequent API call fail). The repair itself runs on the Mac,
// which has the file (the gateway's repair_session).

export const THINKING_BLOCK_ERROR_RE =
  /`?thinking`? or `?redacted_thinking`? blocks in the latest assistant message cannot be modified/i;

export const OUTPUT_CAP_RE = /exceeded the \d+ output token maximum/i;

export interface RepairResult {
  success: boolean;
  linesRemoved: number;
  capturedUserText: string | null;
  reason?: string;
}

export function isThinkingBlockApiError(errorText: string): boolean {
  return THINKING_BLOCK_ERROR_RE.test(errorText);
}
