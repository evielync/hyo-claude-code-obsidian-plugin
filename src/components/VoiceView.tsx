import React from "react";
import { MarkdownBlock } from "./MarkdownBlock";
import { AskQuestion } from "./AskQuestion";
import { VoiceOrb } from "./VoiceOrb";
import type { AskQuestionData } from "../hooks/useChatEngine";

export type BlobState = "idle" | "listening" | "thinking" | "speaking";

export interface VoicePermission {
  requestId: string;
  description: string;
}

interface VoiceViewProps {
  state: BlobState;
  stateLabel: string;
  doingLabel: string;
  /** Inner text of the latest reply's [SCREEN] blocks — the frosted overlay. */
  screens: string[];
  onDismissScreens: () => void;
  /** The last overlay was dismissed but can be brought back. */
  hasHiddenScreens: boolean;
  onShowScreens: () => void;
  permission: VoicePermission | null;
  onPermission: (
    requestId: string,
    behavior: "allow" | "allow_always" | "deny"
  ) => void;
  /** A pending multiple-choice question to answer, surfaced in the view. */
  question: AskQuestionData | null;
  onAnswer: (questionId: string, answers: Record<string, string>) => void;
  onNewConversation: () => void;
  /**
   * GPT-Live call: no turns, so no state words. The Blob is blue while you
   * talk and amber while the agent talks, scaled by the live audio level, and
   * the only text is `working` — what Claude is doing on a hand-off, if
   * anything.
   */
  live?: {
    side: "user" | "agent" | null;
    level: number; // 0–1
    /** The session is up: idle shows as pale blue, not the grey of "off". */
    on: boolean;
    working: string;
    /**
     * The call's controls live inside the surface (mute, transcript, end) so
     * voice mode is one immersive panel, not a view with a chat footer under it.
     */
    muted: boolean;
    onToggleMute: () => void;
    onToggleTranscript: () => void;
    onEnd: () => void;
  };
}

function LiveControls({
  muted,
  onToggleMute,
  onToggleTranscript,
  onEnd,
}: {
  muted: boolean;
  onToggleMute: () => void;
  onToggleTranscript: () => void;
  onEnd: () => void;
}) {
  return (
    <div className="hyo-vv-controls hyo-vv-livebar">
      <button
        className="hyo-vv-ctrl-btn"
        title="Show transcript"
        aria-label="Show transcript"
        onClick={onToggleTranscript}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <line x1="4" y1="7" x2="20" y2="7" />
          <line x1="4" y1="12" x2="20" y2="12" />
          <line x1="4" y1="17" x2="14" y2="17" />
        </svg>
      </button>
      <button
        className={`hyo-vv-ctrl-btn hyo-vv-ctrl-mute${muted ? " muted" : ""}`}
        title={muted ? "Unmute" : "Mute"}
        aria-label={muted ? "Unmute" : "Mute"}
        onClick={onToggleMute}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
          <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
          <line x1="12" y1="19" x2="12" y2="23" />
          <line x1="8" y1="23" x2="16" y2="23" />
          {muted && <line x1="3" y1="3" x2="21" y2="21" strokeWidth="2.4" />}
        </svg>
      </button>
      <button
        className="hyo-vv-ctrl-btn hyo-vv-ctrl-end"
        title="End the call"
        aria-label="End the call"
        onClick={onEnd}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <line x1="6" y1="6" x2="18" y2="18" />
          <line x1="6" y1="18" x2="18" y2="6" />
        </svg>
      </button>
    </div>
  );
}

/**
 * The voice-first surface shown while voice mode is on. The Blob is centre
 * stage (colour = state), a text label says what's happening, on-screen detail
 * floats in as a frosted overlay, and permission asks surface right here so
 * they can't get buried. Design locked against the approved mockup — see
 * [[hyo-voice-view]].
 */
export function VoiceView({
  state,
  stateLabel,
  doingLabel,
  screens,
  onDismissScreens,
  hasHiddenScreens,
  onShowScreens,
  permission,
  onPermission,
  question,
  onAnswer,
  onNewConversation,
  live,
}: VoiceViewProps) {
  const showRing = !live && (state === "listening" || state === "speaking");
  const dimmed = !!permission || !!question;
  const blobClass = live
    ? `hyo-blob live ${live.side ? `side-${live.side}` : "side-none"}${live.on ? " on" : " connecting"}`
    : `hyo-blob ${state}`;
  const blobStyle = live
    ? ({ "--hyo-level": live.level.toFixed(3) } as React.CSSProperties)
    : undefined;
  return (
    <div className={`hyo-voiceview${live ? " live" : ""}`}>
      {/* A live call is one continuous conversation; a new one starts from
          the tab bar after the call ends, so no "+ New" here. */}
      {!live && (
        <div className="hyo-vv-topbar">
          <button
            className="hyo-vv-newbtn"
            title="Start a new conversation"
            onClick={onNewConversation}
          >
            + New
          </button>
        </div>
      )}

      <div className="hyo-vv-stage">
        {live ? (
          <div className={`hyo-orb-wrap${dimmed ? " dim" : ""}`}>
            <VoiceOrb
              side={live.side}
              level={live.level}
              working={!live.side && !!live.working && live.on}
              connecting={!live.on}
            />
          </div>
        ) : (
          <div className={`${blobClass}${dimmed ? " dim" : ""}`} style={blobStyle}>
            <div className="hyo-blob-glow" />
            {showRing && <div className="hyo-blob-ring" />}
            <div className="hyo-blob-core" />
          </div>
        )}
        {live ? (
          <div className="hyo-vv-status live">
            <div className="hyo-vv-working">{live.working}</div>
          </div>
        ) : (
          <div className={`hyo-vv-status ${state}`}>
            <div className="hyo-vv-state">{stateLabel}</div>
            <div className="hyo-vv-doing">{doingLabel}</div>
          </div>
        )}
        {hasHiddenScreens && (
          <button className="hyo-vv-showlast" onClick={onShowScreens}>
            ⤢ Show last on screen
          </button>
        )}
      </div>

      {question && (
        <div className="hyo-vv-overlay hyo-vv-question">
          <div className="hyo-vv-overlay-head">
            <span className="hyo-vv-overlay-badge">Hyo's asking</span>
          </div>
          <AskQuestion question={question} onAnswer={onAnswer} />
        </div>
      )}

      {screens.length > 0 && !permission && !question && (
        <div className="hyo-vv-overlay">
          <div className="hyo-vv-overlay-head">
            <span className="hyo-vv-overlay-badge">On screen</span>
            <span
              className="hyo-vv-overlay-close"
              role="button"
              title="Dismiss"
              onClick={onDismissScreens}
            >
              ✕
            </span>
          </div>
          {screens.map((s, i) => (
            <div className="hyo-vv-overlay-card" key={i}>
              <MarkdownBlock content={s} />
            </div>
          ))}
        </div>
      )}

      {permission && (
        <div className="hyo-vv-perm">
          <div className="hyo-vv-perm-h">Allow this?</div>
          <div className="hyo-vv-perm-txt">{permission.description}</div>
          <div className="hyo-vv-perm-btns">
            <button
              className="hyo-vv-perm-allow"
              onClick={() => onPermission(permission.requestId, "allow")}
            >
              Allow
            </button>
            <button
              className="hyo-vv-perm-always"
              onClick={() => onPermission(permission.requestId, "allow_always")}
            >
              Always
            </button>
            <button
              className="hyo-vv-perm-deny"
              onClick={() => onPermission(permission.requestId, "deny")}
            >
              Deny
            </button>
          </div>
        </div>
      )}

      {live && (
        <LiveControls
          muted={live.muted}
          onToggleMute={live.onToggleMute}
          onToggleTranscript={live.onToggleTranscript}
          onEnd={live.onEnd}
        />
      )}
    </div>
  );
}
