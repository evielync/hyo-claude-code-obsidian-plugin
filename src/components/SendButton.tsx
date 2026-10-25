import React from "react";

/**
 * The one round button at the end of the input box, as Grok Bot does it:
 *   - Claude is answering → stop;
 *   - there's something to send → send;
 *   - the box is empty → start a voice call.
 * Typing swaps call → send; clearing swaps back. During a call the call bar
 * is the control, so the button stays send. Shared by desktop and the phone.
 */

export type SendButtonMode = "stop" | "send" | "call";

export function sendButtonMode(opts: { generating: boolean; hasContent: boolean; inCall: boolean }): SendButtonMode {
  if (opts.generating) return "stop";
  if (opts.hasContent || opts.inCall) return "send";
  return "call";
}

export function SendButton({
  mode,
  onSend,
  onStop,
  onCall,
}: {
  mode: SendButtonMode;
  onSend: () => void;
  onStop: () => void;
  onCall: () => void;
}) {
  if (mode === "stop") {
    return (
      <button className="hyo-send-btn hyo-stop" title="Stop generation" aria-label="Stop generation" onClick={onStop}>
        <svg width="16" height="16" viewBox="0 0 16 16">
          <rect x="3" y="3" width="10" height="10" rx="1" fill="currentColor" />
        </svg>
      </button>
    );
  }
  if (mode === "call") {
    return (
      <button className="hyo-send-btn hyo-call" title="Start a voice call" aria-label="Start a voice call" onClick={onCall}>
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 10v4" />
          <path d="M7.5 6.5v11" />
          <path d="M12 3.5v17" />
          <path d="M16.5 7.5v9" />
          <path d="M21 10v4" />
        </svg>
      </button>
    );
  }
  return (
    <button className="hyo-send-btn" title="Send (Enter)" aria-label="Send" onClick={onSend}>
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <path d="M8 14V2M8 2L3 7M8 2L13 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  );
}
