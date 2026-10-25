import React, { useEffect } from "react";
import { formatCallDuration, endReasonLabel, type VoiceCallRecord } from "../voice/voice-call";

/**
 * A voice call in the chat: one line, "Voice chat · 01:38", where the call
 * started. Tapping it opens that call's transcript (VoiceCallSheet).
 * Shared by desktop and the phone.
 */

function clockTime(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }).toLowerCase();
}

function dayAndTime(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const today = new Date();
  const y = new Date(today);
  y.setDate(today.getDate() - 1);
  const same = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  const day = same(d, today)
    ? "Today"
    : same(d, y)
    ? "Yesterday"
    : d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
  return `${day}, ${clockTime(iso)}`;
}

const MicIcon = ({ size = 13 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="9" y="2" width="6" height="12" rx="3" />
    <path d="M19 10v1a7 7 0 0 1-14 0v-1" />
    <line x1="12" y1="18" x2="12" y2="22" />
  </svg>
);

export function VoiceCallLine({ call, onOpen }: { call: VoiceCallRecord; onOpen: (call: VoiceCallRecord) => void }) {
  return (
    <button className="hyo-callline" onClick={() => onOpen(call)} title="Show what was said on this call">
      <span className="hyo-callline-icon">
        <MicIcon />
      </span>
      <span className="hyo-callline-label">Voice chat</span>
      <span className="hyo-callline-dur">· {formatCallDuration(call.durationMs)}</span>
      <span className="hyo-callline-when">{clockTime(call.startedAt)}</span>
      <span className="hyo-callline-chev" aria-hidden="true">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="9 6 15 12 9 18" />
        </svg>
      </span>
    </button>
  );
}

/**
 * The transcript of one call: every spoken turn, and each hand-off where it
 * happened, in a sheet over the chat with a close button. `agentName` labels
 * the voice's turns.
 */
export function VoiceCallSheet({ call, agentName, onClose }: { call: VoiceCallRecord; agentName: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Turns and hand-offs, in the order they happened.
  type Item = { at: number; kind: "turn"; side: "user" | "agent"; text: string } | { at: number; kind: "handoff"; text: string; afterCall?: boolean };
  const items: Item[] = [
    ...call.turns.map((t) => ({ at: Date.parse(t.at), kind: "turn" as const, side: t.side, text: t.text })),
    ...call.handoffs.map((h) => ({ at: Date.parse(h.at), kind: "handoff" as const, text: h.request, afterCall: h.afterCall })),
  ].sort((a, b) => a.at - b.at);
  const who = agentName || "Agent";

  return (
    <div className="hyo-callsheet-backdrop" onClick={onClose}>
      <div className="hyo-callsheet" role="dialog" aria-label="Voice chat transcript" onClick={(e) => e.stopPropagation()}>
        <div className="hyo-callsheet-grip" aria-hidden="true" />
        <div className="hyo-callsheet-head">
          <div>
            <div className="hyo-callsheet-title">Voice chat</div>
            <div className="hyo-callsheet-sub">
              {dayAndTime(call.startedAt)} · {formatCallDuration(call.durationMs)} · {endReasonLabel(call.endReason)}
            </div>
          </div>
          <button className="hyo-callsheet-close" title="Close" aria-label="Close" onClick={onClose}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="6" y1="6" x2="18" y2="18" />
              <line x1="18" y1="6" x2="6" y2="18" />
            </svg>
          </button>
        </div>
        <div className="hyo-callsheet-body">
          {items.length === 0 && <div className="hyo-callsheet-end">Nothing was said on this call.</div>}
          {items.map((it, i) =>
            it.kind === "turn" ? (
              it.side === "user" ? (
                <div key={i} className="hyo-callsheet-user">{it.text}</div>
              ) : (
                <div key={i} className="hyo-callsheet-agent">
                  <div className="hyo-callsheet-who">{who}</div>
                  {it.text}
                </div>
              )
            ) : (
              <div key={i} className="hyo-callsheet-handoff" title={it.text}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <line x1="7" y1="17" x2="17" y2="7" />
                  <polyline points="7 7 17 7 17 17" />
                </svg>
                <span>
                  Asked {who}: {it.text}
                  {it.afterCall ? " (finished in the chat)" : ""}
                </span>
              </div>
            )
          )}
          <div className="hyo-callsheet-end">Call ended · {formatCallDuration(call.durationMs)}</div>
        </div>
      </div>
    </div>
  );
}
