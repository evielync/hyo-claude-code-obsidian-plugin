import React, { useEffect, useState } from "react";
import { VoiceOrb } from "./VoiceOrb";
import { formatCallDuration } from "../voice/voice-call";

/**
 * The call bar: a voice call sits at the top of the chat panel like a phone
 * call, and the chat stays visible underneath. The orb (the live-call orb,
 * small, driven by the real audio level), a timer with what the agent is
 * doing, and settings / mute / end. Shared by desktop and the phone.
 *
 * Design: chad/assets/hyo-call-bar-mockup.html (22 Oct 2026).
 */

export interface CallBarProps {
  /** When the call started (ms); the timer counts from here. Null while connecting. */
  startedAt: number | null;
  connecting: boolean;
  side: "user" | "agent" | null;
  level: number;
  /** What the agent is doing on a hand-off, in plain words. Empty when nothing. */
  working: string;
  muted: boolean;
  /** Absent where there's nothing to mute (phone walkie-talkie). */
  onToggleMute?: () => void;
  onEnd: () => void;
  onSettings?: () => void;
  /** Tapping the orb (ElevenLabs: stop it talking). */
  onOrbClick?: () => void;
}

export function CallBar({ startedAt, connecting, side, level, working, muted, onToggleMute, onEnd, onSettings, onOrbClick }: CallBarProps) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (connecting || !startedAt) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [connecting, startedAt]);

  const time = startedAt ? formatCallDuration(now - startedAt) : "";
  const detail = connecting ? "Connecting…" : muted ? "Muted" : working;

  return (
    <div className="hyo-callbar-wrap">
      <div className={`hyo-callbar${connecting ? " connecting" : ""}`} role="region" aria-label="Voice call">
        <div
          className={`hyo-callbar-orb${onOrbClick ? " clickable" : ""}`}
          onClick={onOrbClick}
          title={onOrbClick ? "Stop talking" : undefined}
        >
          <VoiceOrb side={side} level={level} working={!side && !!working && !connecting} connecting={connecting} size={40} />
        </div>
        <div className="hyo-callbar-text">
          <div className="hyo-callbar-title">
            Voice chat {!connecting && <span className="hyo-callbar-live" aria-hidden="true" />}
          </div>
          <div className="hyo-callbar-status">
            {time && !connecting && <b>{time}</b>}
            {time && !connecting && detail ? " · " : ""}
            {detail}
          </div>
        </div>
        {onSettings && (
          <button className="hyo-callbar-btn" title="Voice settings" aria-label="Voice settings" onClick={onSettings}>
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68 1.65 1.65 0 0 0 10 3.17V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </button>
        )}
        {onToggleMute && <button
          className={`hyo-callbar-btn${muted ? " muted" : ""}`}
          title={muted ? "Unmute" : "Mute"}
          aria-label={muted ? "Unmute" : "Mute"}
          aria-pressed={muted}
          onClick={onToggleMute}
        >
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <rect x="9" y="2" width="6" height="12" rx="3" />
            <path d="M19 10v1a7 7 0 0 1-14 0v-1" />
            <line x1="12" y1="18" x2="12" y2="22" />
            {muted && <line x1="3" y1="3" x2="21" y2="21" strokeWidth="2" />}
          </svg>
        </button>}
        <button className="hyo-callbar-end" title="End the call" aria-label="End the call" onClick={onEnd}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M12 9.5c-2.6 0-5.1.5-7.3 1.5-.7.3-1.2 1-1.2 1.8v2.1c0 .9.8 1.6 1.7 1.4l3-.6c.7-.1 1.2-.7 1.2-1.4v-1.6c1.7-.4 3.5-.4 5.2 0v1.6c0 .7.5 1.3 1.2 1.4l3 .6c.9.2 1.7-.5 1.7-1.4v-2.1c0-.8-.5-1.5-1.2-1.8-2.2-1-4.7-1.5-7.3-1.5z" />
          </svg>
        </button>
      </div>
    </div>
  );
}
