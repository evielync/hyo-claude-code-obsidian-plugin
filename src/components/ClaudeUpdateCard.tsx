import React, { useState, useCallback } from "react";
import { Platform } from "obsidian";

export type ClaudeUpdateRunner = (
  required: string,
  onPhase: (message: string) => void
) => Promise<{ ok: boolean; error?: string; resent?: boolean }>;

interface ClaudeUpdateCardProps {
  /** The Claude Code version the model needs. */
  required: string;
  /** Runs the update, then retries or respawns. Absent means nothing to run. */
  onUpdate?: ClaudeUpdateRunner;
  /** Shown as the startup banner rather than inside a message. */
  banner?: boolean;
  onDismiss?: () => void;
  /** Already updated (e.g. a reopened conversation): no button, just say so. */
  updated?: boolean;
}

/**
 * "Claude needs an update" — shown in place of the raw 400 a model gives when
 * the installed Claude Code is too old for it, and as a banner when Hyo spots
 * the mismatch before anything is sent. Same card, same button, both places.
 *
 * The update runs in the background (see updateClaude in cli-probe), so the
 * person never sees a terminal: just progress on the card, then either their
 * message going through or one plain line saying what went wrong.
 */
export function ClaudeUpdateCard({ required, onUpdate, banner, onDismiss, updated }: ClaudeUpdateCardProps) {
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<string | null>(updated ? "Claude has been updated." : null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(!!updated);

  const run = useCallback(async () => {
    if (!onUpdate || busy) return;
    setBusy(true);
    setError(null);
    setPhase("Updating Claude…");
    try {
      const r = await onUpdate(required, (m) => setPhase(m));
      if (r.ok) {
        setDone(true);
        setPhase(
          r.resent
            ? "Claude is up to date. Sending your message again…"
            : banner
              ? "Claude is up to date. You're all set."
              : "Claude is up to date. Send your message again to carry on."
        );
      } else {
        setPhase(null);
        console.error("[hyo] Claude update failed:", r.error);
        setError("fail");
      }
    } catch (e: any) {
      setPhase(null);
      console.error("[hyo] Claude update failed:", e);
      setError("fail");
    }
    setBusy(false);
  }, [onUpdate, busy, required, banner]);

  const body = Platform.isMobile
    ? "Open Hyo on your computer and it will update Claude for you. Then this model will work here too."
    : `This model needs Claude ${required} or newer. Hyo can update it for you in the background, and it only takes a minute.`;

  return (
    <div className={`hyo-claude-update-card${banner ? " hyo-claude-update-banner" : ""}`}>
      <div className="hyo-claude-update-head">
        <span className="hyo-claude-update-title">
          {done ? "Claude is up to date" : "Claude needs an update to use this model"}
        </span>
        {banner && onDismiss && !busy && (
          <button
            className="hyo-release-card-dismiss"
            onClick={onDismiss}
            aria-label="Dismiss"
            title="Dismiss"
          >
            ×
          </button>
        )}
      </div>
      {!done && <div className="hyo-claude-update-text">{body}</div>}
      {!Platform.isMobile && onUpdate && !done && (
        <button className="mod-cta hyo-claude-update-button" onClick={run} disabled={busy}>
          {busy ? "Updating…" : "Update Claude"}
        </button>
      )}
      {phase && <div className="hyo-claude-update-status">{phase}</div>}
      {error && (
        <div className="hyo-claude-update-status hyo-claude-update-error">
          The update didn't go through. Check you're online and try again.
        </div>
      )}
    </div>
  );
}
