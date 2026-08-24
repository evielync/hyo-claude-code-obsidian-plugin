// Detects the "thinking block poisoning" failure mode (a truncated turn
// leaves an orphaned signed `thinking` block in the session, which then
// makes every subsequent API call fail). Desktop Hyo could also REPAIR it
// by editing the session .jsonl directly via fs. On mobile there's no fs —
// the gateway server owns those files and doesn't expose a repair RPC — so
// only detection survives here. `repairSession` is stubbed to report
// clearly that recovery isn't available rather than silently doing nothing.

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

// No local fs access on mobile, and the gateway protocol doesn't expose a
// repair RPC — surgical session repair isn't possible from the client.
// Kept as a function (rather than removed outright) so the "Recover
// session" UI in ChatMessage.tsx still has something to call; it just
// reports that recovery isn't available instead of throwing.
export function repairSession(_jsonlPath: string): RepairResult {
  return {
    success: false,
    linesRemoved: 0,
    capturedUserText: null,
    reason: "Session recovery isn't available on mobile yet — start a new conversation to continue.",
  };
}
