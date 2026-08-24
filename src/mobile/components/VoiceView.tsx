import React from "react";
import { MarkdownBlock } from "./MarkdownBlock";
import { AskQuestion } from "./AskQuestion";
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
  hasHiddenScreens: boolean;
  onShowScreens: () => void;
  permission: VoicePermission | null;
  onPermission: (
    requestId: string,
    behavior: "allow" | "allow_always" | "deny"
  ) => void;
  question: AskQuestionData | null;
  onAnswer: (questionId: string, answers: Record<string, string>) => void;
  onNewConversation: () => void;
  /**
   * The Blob is the talk trigger on mobile: press to start, release decides
   * hold-vs-tap (see ChatPanel). Disabled while Chad is working (half-duplex).
   */
  onTalkPointerDown: () => void;
  onTalkPointerUp: () => void;
  talkDisabled: boolean;
  onToggleTranscript: () => void;
  onEndVoice: () => void;
}

/**
 * The mobile voice-first surface — the desktop Blob view ported across, adapted
 * to walkie-talkie triggering. The Blob is centre stage (colour = state) and IS
 * the talk button: hold it to talk, or tap to start/stop. On-screen detail
 * floats in as a frosted overlay; permission asks surface right here so they
 * can't get buried while the transcript is hidden. See [[hyo-mobile-voice]].
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
  onTalkPointerDown,
  onTalkPointerUp,
  talkDisabled,
  onToggleTranscript,
  onEndVoice,
}: VoiceViewProps) {
  const showRing = state === "listening" || state === "speaking";
  const dimmed = !!permission || !!question;
  return (
    <div className="hyo-voiceview">
      <div className="hyo-vv-stage">
        <div
          className={`hyo-blob ${state}${dimmed ? " dim" : ""}${
            talkDisabled ? " busy" : ""
          }`}
          role="button"
          aria-label="Hold to talk, or tap to start and stop"
          style={{ touchAction: "none", cursor: talkDisabled ? "default" : "pointer" }}
          onPointerDown={talkDisabled ? undefined : onTalkPointerDown}
          onPointerUp={talkDisabled ? undefined : onTalkPointerUp}
          onPointerCancel={talkDisabled ? undefined : onTalkPointerUp}
        >
          <div className="hyo-blob-glow" />
          {showRing && <div className="hyo-blob-ring" />}
          <div className="hyo-blob-core" />
        </div>
        <div className={`hyo-vv-status ${state}`}>
          <div className="hyo-vv-state">{stateLabel}</div>
          <div className="hyo-vv-doing">{doingLabel}</div>
        </div>
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

      <div className="hyo-vv-controls">
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
          className="hyo-vv-ctrl-btn"
          title="New conversation"
          aria-label="New conversation"
          onClick={onNewConversation}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </button>
        <button
          className="hyo-vv-ctrl-btn hyo-vv-ctrl-end"
          title="End voice"
          aria-label="End voice"
          onClick={onEndVoice}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="6" y1="6" x2="18" y2="18" />
            <line x1="6" y1="18" x2="18" y2="6" />
          </svg>
        </button>
      </div>
    </div>
  );
}
