import React from "react";
import type { VoiceState } from "../hooks/useVoiceMode";

interface VoiceControlsProps {
  voiceState: VoiceState;
  isPaused: boolean;
  hasLastAudio: boolean;
  currentSpeed: number;
  onRecordClick: () => void;
  onStop: () => void;
  onTogglePause: () => void;
  onReplay: () => void;
  onCycleSpeed: () => void;
}

export function VoiceControls({
  voiceState,
  isPaused,
  hasLastAudio,
  currentSpeed,
  onRecordClick,
  onStop,
  onTogglePause,
  onReplay,
  onCycleSpeed,
}: VoiceControlsProps) {
  const statusLabel =
    voiceState === "listening"
      ? "Listening..."
      : voiceState === "thinking"
      ? "Transcribing..."
      : voiceState === "speaking"
      ? isPaused
        ? "Paused"
        : "Speaking..."
      : "Ready";

  return (
    <div className="hyo-voice-controls">
      <div
        className={`hyo-voice-record-btn${
          voiceState === "listening" ? " recording" : ""
        }${voiceState === "thinking" ? " disabled" : ""}`}
        onClick={voiceState !== "thinking" ? onRecordClick : undefined}
        role="button"
        tabIndex={0}
        title={
          voiceState === "listening"
            ? "Stop recording"
            : voiceState === "speaking"
            ? "Stop playback"
            : "Click to speak"
        }
      >
        {voiceState === "listening" ? (
          <svg width="18" height="18" viewBox="0 0 24 24">
            <rect
              x="4"
              y="4"
              width="16"
              height="16"
              rx="2"
              fill="currentColor"
            />
          </svg>
        ) : (
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
            <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
            <line x1="12" y1="19" x2="12" y2="23" />
            <line x1="8" y1="23" x2="16" y2="23" />
          </svg>
        )}
      </div>

      <span className="hyo-voice-status-label">{statusLabel}</span>

      <div className="hyo-voice-playback">
        {voiceState === "speaking" && (
          <>
            <button
              className="hyo-voice-ctrl-btn"
              title="Stop"
              onClick={onStop}
            >
              <svg width="14" height="14" viewBox="0 0 16 16">
                <rect
                  x="3"
                  y="3"
                  width="10"
                  height="10"
                  rx="1"
                  fill="currentColor"
                />
              </svg>
            </button>
            <button
              className="hyo-voice-ctrl-btn"
              title={isPaused ? "Resume" : "Pause"}
              onClick={onTogglePause}
            >
              {isPaused ? (
                <svg width="14" height="14" viewBox="0 0 16 16">
                  <path d="M4 2L14 8L4 14Z" fill="currentColor" />
                </svg>
              ) : (
                <svg width="14" height="14" viewBox="0 0 16 16">
                  <rect
                    x="3"
                    y="2"
                    width="3.5"
                    height="12"
                    rx="1"
                    fill="currentColor"
                  />
                  <rect
                    x="9.5"
                    y="2"
                    width="3.5"
                    height="12"
                    rx="1"
                    fill="currentColor"
                  />
                </svg>
              )}
            </button>
          </>
        )}

        {hasLastAudio && voiceState === "idle" && (
          <button
            className="hyo-voice-ctrl-btn"
            title="Replay"
            onClick={onReplay}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polyline points="1 4 1 10 7 10" />
              <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
            </svg>
          </button>
        )}

        <button
          className="hyo-voice-ctrl-btn hyo-voice-speed-btn"
          title="Playback speed"
          onClick={onCycleSpeed}
        >
          {currentSpeed}×
        </button>
      </div>
    </div>
  );
}
