import React, { useState, useCallback } from "react";
import { Platform } from "obsidian";
import type { CodeNeeded } from "../cli-probe";

export type ClaudeSignInRunner = (
  onPhase: (message: string) => void,
  onCodeNeeded: CodeNeeded
) => Promise<{ ok: boolean; error?: string; resent?: boolean }>;

interface ClaudeSignInCardProps {
  /** Runs the sign-in, then resends the message. Absent on the phone. */
  onSignIn?: ClaudeSignInRunner;
  /** Already signed in again (the message was resent or the card is old). */
  signedIn?: boolean;
}

/**
 * "Claude needs you to sign in again" — shown in place of the raw
 * "Failed to authenticate" a turn ends on when Claude's login has expired.
 * Same shape as ClaudeUpdateCard: one button, progress on the card, then the
 * failed message goes again.
 *
 * Sign-in runs in the background (see signIn in cli-probe). The only thing the
 * person sees is the browser tab to approve, plus a box for the code in case
 * the browser shows one instead of handing straight back.
 */
export function ClaudeSignInCard({ onSignIn, signedIn }: ClaudeSignInCardProps) {
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<string | null>(signedIn ? "You're signed in." : null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(!!signedIn);
  const [submitCode, setSubmitCode] = useState<((code: string) => void) | null>(null);
  const [code, setCode] = useState("");
  const [pageUrl, setPageUrl] = useState<string | null>(null);

  const run = useCallback(async () => {
    if (!onSignIn || busy) return;
    setBusy(true);
    setError(null);
    setCode("");
    setSubmitCode(null);
    setPageUrl(null);
    setPhase("Starting sign-in…");
    try {
      const r = await onSignIn(
        (m) => setPhase(m),
        (submit, url) => {
          setSubmitCode(() => submit);
          setPageUrl(url || null);
        }
      );
      setSubmitCode(null);
      if (r.ok) {
        setDone(true);
        setPhase(
          r.resent
            ? "Signed in. Sending your message again…"
            : "Signed in. Send your message again to carry on."
        );
      } else {
        setPhase(null);
        setError(r.error || "Sign-in didn't finish. Try again.");
      }
    } catch (e: any) {
      console.error("[hyo] sign-in failed:", e);
      setSubmitCode(null);
      setPhase(null);
      setError((e?.message || "Sign-in didn't finish. Try again.").toString());
    }
    setBusy(false);
  }, [onSignIn, busy]);

  const sendCode = () => {
    if (!submitCode || !code.trim()) return;
    submitCode(code);
    setCode("");
  };

  const canRun = !!onSignIn && !Platform.isMobile;
  const body = canRun
    ? "Your Claude login has expired. Sign in again and Hyo will send your message for you."
    : "Your Claude login has expired on your Mac. Open Hyo there and click Sign in to Claude on the message.";

  return (
    <div className="hyo-claude-update-card">
      <div className="hyo-claude-update-head">
        <span className="hyo-claude-update-title">
          {done ? "Signed in to Claude" : "Claude needs you to sign in again"}
        </span>
      </div>
      {!done && <div className="hyo-claude-update-text">{body}</div>}
      {canRun && !done && (
        <button className="mod-cta hyo-claude-update-button" onClick={run} disabled={busy}>
          {busy ? "Signing in…" : error ? "Try again" : "Sign in to Claude"}
        </button>
      )}
      {phase && <div className="hyo-claude-update-status">{phase}</div>}
      {busy && submitCode && (
        <div className="hyo-claude-signin-code">
          <div className="hyo-claude-update-status">
            {pageUrl ? (
              <>
                Browser didn't open? <a href={pageUrl}>Open the sign-in page</a>, approve it, and
                paste the code it shows you below.
              </>
            ) : (
              "If your browser shows a code instead of returning here, paste it below."
            )}
          </div>
          <div className="hyo-claude-signin-code-row">
            <input
              type="text"
              value={code}
              placeholder="Paste the code"
              spellCheck={false}
              autoComplete="off"
              onChange={(e) => setCode(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") sendCode();
              }}
            />
            <button onClick={sendCode} disabled={!code.trim()}>
              Submit
            </button>
          </div>
        </div>
      )}
      {error && <div className="hyo-claude-update-status hyo-claude-update-error">{error}</div>}
    </div>
  );
}
