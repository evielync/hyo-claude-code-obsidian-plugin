import React, { useState, useEffect } from "react";
import type { App } from "obsidian";
import type HyoPlugin from "../main";
import { ChatPanel } from "./ChatPanel";
import { useSessionManager } from "../hooks/useSessionManager";
import { DEFAULT_EFFORT } from "../models";
import {
  detectClaude,
  installClaude,
  signIn,
  type ClaudeDetection,
} from "../cli-probe";

interface HyoAppProps {
  app: App;
  plugin: HyoPlugin;
}

export function HyoApp({ app, plugin }: HyoAppProps) {
  // null = still checking. We run Claude to find out, rather than trusting a
  // file to exist, so this reflects whether Claude actually works.
  const [detection, setDetection] = useState<ClaudeDetection | null>(null);
  const [settingsVersion, setSettingsVersion] = useState(0);
  // Setup progress shown in the first-run screen while install / sign-in run.
  const [setupMsg, setSetupMsg] = useState<string | null>(null);
  const [setupBusy, setSetupBusy] = useState(false);
  const vaultPath = (app.vault.adapter as any).basePath as string;

  useEffect(() => {
    const handler = () => setSettingsVersion((v) => v + 1);
    window.addEventListener("hyo-settings-changed", handler);
    return () => window.removeEventListener("hyo-settings-changed", handler);
  }, []);

  const runDetection = React.useCallback(() => {
    setDetection(null);
    // Defer so the "Checking…" state paints before the probe blocks the thread.
    setTimeout(async () => {
      const result = detectClaude();
      // If a working Claude turned up at a path we're not using, adopt it — so
      // the chat (and sign-in) run the one we just proved works.
      if (result.path && result.path !== plugin.settings.cliPath) {
        plugin.settings.cliPath = result.path;
        await plugin.saveSettings();
      }
      setDetection(result);
    }, 0);
  }, [plugin]);

  useEffect(() => {
    runDetection();
  }, [runDetection, settingsVersion]);

  // Install Claude in the background — no terminal, just progress text.
  const doInstall = React.useCallback(async () => {
    setSetupBusy(true);
    setSetupMsg("Installing Claude…");
    const r = await installClaude((m) => setSetupMsg(m));
    setSetupBusy(false);
    if (r.ok) {
      setSetupMsg("Installed. Now sign in.");
      runDetection();
    } else {
      setSetupMsg(`Install didn't finish: ${r.error}`);
    }
  }, [runDetection]);

  // Sign in in the background — a browser tab opens to approve, nothing else.
  const doSignIn = React.useCallback(async () => {
    if (!plugin.settings.cliPath) {
      setSetupMsg("Install Claude first.");
      return;
    }
    setSetupBusy(true);
    setSetupMsg("Starting sign-in…");
    const r = await signIn(plugin.settings.cliPath, (m) => setSetupMsg(m));
    setSetupBusy(false);
    if (r.ok) {
      setSetupMsg("Signed in. Checking…");
      runDetection();
    } else {
      setSetupMsg(`Sign-in didn't finish: ${r.error}`);
    }
  }, [plugin, runDetection]);

  // Use custom working directory if set, otherwise use vault path
  const workingDirectory = plugin.settings.workingDirectory
    ? plugin.settings.workingDirectory.replace(
        /^~/,
        process.env.HOME || process.env.USERPROFILE || ""
      )
    : vaultPath;

  const sessionManager = useSessionManager({
    cliPath: plugin.settings.cliPath,
    cwd: workingDirectory,
    model: plugin.settings.model,
    effort: plugin.settings.effortLevel || DEFAULT_EFFORT,
    permissionMode: plugin.settings.permissionMode,
    defaultAgent: plugin.settings.defaultAgent || "",
    maxOutputTokens: plugin.settings.maxOutputTokens,
    autoGenerateTitles: plugin.settings.autoGenerateTitles,
    settingsVersion,
  });

  if (detection === null) {
    return (
      <div className="hyo-app">
        <div className="hyo-loading">Checking for Claude…</div>
      </div>
    );
  }

  if (detection.state !== "ready") {
    const isWindows = process.platform === "win32";
    // Claude is on the machine but not signed in, vs nothing installed at all —
    // the two need different first moves.
    const signedOut = detection.state === "signed-out";

    // Only used in the tucked-away "do it yourself" fallback.
    const installCommand = isWindows
      ? "irm https://claude.ai/install.ps1 | iex"
      : "curl -fsSL https://claude.ai/install.sh | bash";

    return (
      <div className="hyo-app">
        <div className="hyo-onboarding">
          <h3>
            {signedOut ? "You're almost there — just sign in" : "Let's get Claude set up"}
          </h3>
          <p className="hyo-onboarding-intro">
            {signedOut
              ? "Claude is installed and working on your machine. It just needs you to sign in to your Anthropic account."
              : "Hyo runs on Claude Code. It's a one-time setup, and Hyo does it for you — no terminal, nothing to copy."}
          </p>

          <div className="hyo-onboarding-option-quick">
            <strong>{signedOut ? "Sign in" : "Set it up for you"}</strong>
            <p className="hyo-step-instruction">
              {signedOut
                ? "This opens your browser to approve. Once you're signed in, Hyo starts on its own."
                : "Install Claude, then sign in when your browser opens. Hyo handles the rest."}
            </p>
            <div className="hyo-setup-actions">
              {!signedOut && (
                <button
                  className="hyo-copy-prompt-button"
                  onClick={doInstall}
                  disabled={setupBusy}
                >
                  Install Claude
                </button>
              )}
              <button
                className="hyo-copy-prompt-button"
                onClick={doSignIn}
                disabled={setupBusy}
              >
                Sign in to Claude
              </button>
              <button
                className="hyo-copy-prompt-button"
                onClick={() => runDetection()}
                disabled={setupBusy}
              >
                Re-check
              </button>
            </div>
            {setupMsg && <p className="hyo-step-note">{setupMsg}</p>}
          </div>

          <p className="hyo-onboarding-intro">
            <a href="https://www.loom.com/share/9fecabcdda3c4e83bae142d67838c2fa" target="_blank" rel="noopener">
              Watch the install guide →
            </a>
            {" · "}
            <a href="https://www.loom.com/share/349eaac59e514142bc47b10469287db0" target="_blank" rel="noopener">
              Watch the user guide →
            </a>
          </p>

          <details className="hyo-onboarding-troubleshooting">
            <summary>Prefer to do it yourself, or having trouble?</summary>
            <div className="hyo-troubleshooting-content">
              <p>
                You'll need a Claude account (Pro, Max, Team or Enterprise) — the
                same login you use at{" "}
                <a href="https://claude.ai" target="_blank" rel="noopener">
                  claude.ai
                </a>
                .
              </p>
              <p>
                To install Claude yourself, run this in your terminal, then click
                Re-check:
              </p>
              <code
                className="hyo-install-command"
                onClick={(e) => {
                  navigator.clipboard.writeText(installCommand);
                  e.currentTarget.classList.add("copied");
                  setTimeout(() => e.currentTarget.classList.remove("copied"), 2000);
                }}
                title="Click to copy"
              >
                {installCommand}
              </code>
            </div>
          </details>
        </div>
      </div>
    );
  }

  return (
    <div className="hyo-app">
      <ChatPanel sessionManager={sessionManager} plugin={plugin} app={app} />
    </div>
  );
}
