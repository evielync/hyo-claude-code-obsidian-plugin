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
}: VoiceViewProps) {
  const showRing = state === "listening" || state === "speaking";
  const dimmed = !!permission || !!question;
  return (
    <div className="hyo-voiceview">
      <div className="hyo-vv-topbar">
        <button
          className="hyo-vv-newbtn"
          title="Start a new conversation"
          onClick={onNewConversation}
        >
          + New
        </button>
      </div>

      <div className="hyo-vv-stage">
        <div className={`hyo-blob ${state}${dimmed ? " dim" : ""}`}>
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
            <span className="hyo-vv-overlay-badge">Chad's asking</span>
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
    </div>
  );
}
