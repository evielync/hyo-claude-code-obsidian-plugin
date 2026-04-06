import React, { useState, useEffect } from "react";
import type { App } from "obsidian";
import type HyoPlugin from "../main";
import { ChatPanel } from "./ChatPanel";
import { useSessionManager } from "../hooks/useSessionManager";
import { checkCliExists } from "../claude-transport";

interface HyoAppProps {
  app: App;
  plugin: HyoPlugin;
}

export function HyoApp({ app, plugin }: HyoAppProps) {
  const [cliFound, setCliFound] = useState<boolean | null>(null);
  const vaultPath = (app.vault.adapter as any).basePath as string;

  useEffect(() => {
    setCliFound(checkCliExists(plugin.settings.cliPath));
  }, [plugin.settings.cliPath]);

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
    permissionMode: plugin.settings.permissionMode,
  });

  if (cliFound === null) {
    return (
      <div className="hyo-app">
        <div className="hyo-loading">Loading...</div>
      </div>
    );
  }

  if (!cliFound) {
    const platform = process.platform;
    const isMac = platform === "darwin";
    const isWindows = platform === "win32";

    const installCommand = isWindows
      ? "irm https://claude.ai/install.ps1 | iex"
      : "curl -fsSL https://claude.ai/install.sh | bash";

    const terminalName = isWindows ? "PowerShell" : "Terminal";
    const openInstructions = isMac
      ? "Press Cmd+Space, type 'Terminal', and press Enter"
      : isWindows
      ? "Press the Windows key, type 'PowerShell', and press Enter"
      : "Open your terminal application";

    const pasteInstructions = isWindows
      ? "Right-click in the PowerShell window to paste"
      : "Press Cmd+V to paste";

    return (
      <div className="hyo-app">
        <div className="hyo-onboarding">
          <h3>Welcome to Hyo</h3>
          <p className="hyo-onboarding-intro">
            Hyo needs Claude Code installed to work. This is a one-time setup
            that takes about 2 minutes.
          </p>

          <div className="hyo-onboarding-steps">
            <div className="hyo-onboarding-step">
              <strong>Step 1: Open {terminalName}</strong>
              <p className="hyo-step-instruction">{openInstructions}</p>
              <p className="hyo-step-note">
                Don't worry — you won't need to use {terminalName} after this
                initial setup.
              </p>
            </div>

            <div className="hyo-onboarding-step">
              <strong>Step 2: Install Claude Code</strong>
              <p className="hyo-step-instruction">
                Copy this command by clicking the code box:
              </p>
              <code
                className="hyo-install-command"
                onClick={(e) => {
                  navigator.clipboard.writeText(installCommand);
                  e.currentTarget.classList.add("copied");
                  setTimeout(
                    () => e.currentTarget.classList.remove("copied"),
                    2000
                  );
                }}
                title="Click to copy"
              >
                {installCommand}
              </code>
              <p className="hyo-step-instruction">
                {pasteInstructions}, then press Enter.
              </p>
              <p className="hyo-step-note">
                You'll see text appear — this is normal. The installation takes
                about 30 seconds.
              </p>
            </div>

            <div className="hyo-onboarding-step">
              <strong>Step 3: Start Claude Code</strong>
              <p className="hyo-step-instruction">
                When the installation finishes, type <code>claude</code> and
                press Enter.
              </p>
              <p className="hyo-step-note">
                Your browser will open asking you to log in with your Anthropic
                account (the same one you use for Claude.ai).
              </p>
            </div>

            <div className="hyo-onboarding-step">
              <strong>Step 4: Reload Hyo</strong>
              <p className="hyo-step-instruction">
                Close and reopen this panel using the Hyo icon in the sidebar.
              </p>
            </div>
          </div>

          <details className="hyo-onboarding-troubleshooting">
            <summary>Troubleshooting</summary>
            <div className="hyo-troubleshooting-content">
              <p>
                <strong>Command not found after installation?</strong>
              </p>
              <p>
                Close {terminalName} completely, then open it again. The{" "}
                <code>claude</code> command will be available in the new window.
              </p>
              <p>
                <strong>Claude installed in a different location?</strong>
              </p>
              <p>
                Go to Settings → Hyo Plugin and update the CLI path to where
                Claude Code is installed on your machine.
              </p>
              <p>
                <strong>Need a Claude account?</strong>
              </p>
              <p>
                Claude Code requires a Pro, Max, Team, or Enterprise account.
                Sign up at{" "}
                <a href="https://claude.ai" target="_blank" rel="noopener">
                  claude.ai
                </a>
                .
              </p>
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
