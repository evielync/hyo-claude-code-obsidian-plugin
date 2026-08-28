import React, { useState, useEffect } from "react";
import type { App } from "obsidian";
import type HyoPlugin from "../main";
import { ChatPanel } from "./ChatPanel";
import { useSessionManager } from "../hooks/useSessionManager";
import { detectCli, cliExists, ENGINE_SETUP } from "../cli-detect";
import { DEFAULT_EFFORT } from "../models";

interface HyoAppProps {
  app: App;
  plugin: HyoPlugin;
}

export function HyoApp({ app, plugin }: HyoAppProps) {
  const [cliFound, setCliFound] = useState<boolean | null>(null);
  const [settingsVersion, setSettingsVersion] = useState(0);
  const vaultPath = (app.vault.adapter as any).basePath as string;

  useEffect(() => {
    const handler = () => setSettingsVersion((v) => v + 1);
    window.addEventListener("hyo-settings-changed", handler);
    return () => window.removeEventListener("hyo-settings-changed", handler);
  }, []);

  // The "is the CLI there?" check follows the selected engine, so running Codex
  // in this vault doesn't get blocked by a missing Claude binary (and the other
  // way round).
  const engine = plugin.settings.engine || "claude";
  const activeCliPath =
    engine === "codex"
      ? plugin.settings.codexCliPath || ""
      : plugin.settings.cliPath;

  // Find the engine's binary without making anyone go looking for it. Codex
  // installs to npm's global bin, which isn't on the PATH an Obsidian window
  // inherits from the Dock, so "it's installed" and "Hyo can see it" are two
  // different things. Runs whenever the path is empty — switching engine is
  // enough to trigger it.
  useEffect(() => {
    if (activeCliPath) {
      setCliFound(cliExists(activeCliPath));
      return;
    }
    const detected = detectCli(engine);
    if (detected) {
      if (engine === "codex") plugin.settings.codexCliPath = detected;
      else plugin.settings.cliPath = detected;
      void plugin.saveSettings();
      setCliFound(true);
      return;
    }
    setCliFound(false);
  }, [activeCliPath, engine, settingsVersion, plugin]);

  // Use custom working directory if set, otherwise use vault path
  const workingDirectory = plugin.settings.workingDirectory
    ? plugin.settings.workingDirectory.replace(
        /^~/,
        process.env.HOME || process.env.USERPROFILE || ""
      )
    : vaultPath;

  const sessionManager = useSessionManager({
    engine,
    cliPath: plugin.settings.cliPath,
    codexCliPath: plugin.settings.codexCliPath,
    cwd: workingDirectory,
    model: plugin.settings.model,
    effort: plugin.settings.effortLevel || DEFAULT_EFFORT,
    permissionMode: plugin.settings.permissionMode,
    defaultAgent: plugin.settings.defaultAgent || "",
    maxOutputTokens: plugin.settings.maxOutputTokens,
    autoGenerateTitles: plugin.settings.autoGenerateTitles,
    settingsVersion,
    onSwitchEngine: (from, openTabs, to) => {
      const store = { ...(plugin.settings.openTabsByEngine || {}) };
      store[from] = openTabs;
      const restored = store[to] || [];
      plugin.settings.openTabsByEngine = store;
      void plugin.saveSettings();
      return restored;
    },
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

    const setup = ENGINE_SETUP[engine];
    const installCommand = isWindows
      ? setup.windowsInstallCommand
      : setup.installCommand;

    const terminalName = isWindows ? "PowerShell" : "Terminal";
    const openInstructions = isMac
      ? "Press Cmd+Space, type 'Terminal', and press Enter"
      : isWindows
      ? "Press the Windows key, type 'PowerShell', and press Enter"
      : "Open your terminal application";

    const pasteInstructions = isWindows
      ? "Right-click in the PowerShell window to paste"
      : "Press Cmd+V to paste";

    const which = isWindows ? "where" : "which";
    const assistantPrompt = `I need you to install ${setup.label} on my machine. Here's what to do:

1. Check if it's already installed by running: ${which} ${setup.binary}
2. If not found, install it by running: ${installCommand}
3. After install, verify it works by running: ${which} ${setup.binary}
4. Then run: ${setup.loginCommand}
   My browser will open to log in — that's expected. Once I've logged in, tell me to come back to Obsidian and reopen the Hyo panel.

Be friendly and walk me through each step. I might not be technical.`;

    return (
      <div className="hyo-app">
        <div className="hyo-onboarding">
          <h3>Welcome to Hyo</h3>
          <p className="hyo-onboarding-intro">
            Hyo needs {setup.label} installed to work. This is a one-time setup
            that takes about 2 minutes.
          </p>
          <p className="hyo-onboarding-intro">
            <a href="https://www.loom.com/share/9fecabcdda3c4e83bae142d67838c2fa" target="_blank" rel="noopener">
              Watch the install guide →
            </a>
            {" · "}
            <a href="https://www.loom.com/share/349eaac59e514142bc47b10469287db0" target="_blank" rel="noopener">
              Watch the user guide →
            </a>
          </p>

          <div className="hyo-onboarding-option-quick">
            <strong>Quickest way: let an assistant do it</strong>
            <p className="hyo-step-instruction">
              Paste this prompt into any assistant that can run commands on your
              machine — the Claude desktop app's Code tab, or a terminal agent.
              It will handle the installation for you.
            </p>
            <button
              className="hyo-copy-prompt-button"
              onClick={(e) => {
                navigator.clipboard.writeText(assistantPrompt);
                const btn = e.currentTarget;
                btn.textContent = "Copied!";
                setTimeout(() => {
                  btn.textContent = "Copy install prompt";
                }, 2000);
              }}
            >
              Copy install prompt
            </button>
            <p className="hyo-step-note">
              Once {setup.label} is installed, close and reopen this panel.
            </p>
          </div>

          <div className="hyo-onboarding-divider">
            <span>or install manually</span>
          </div>

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
              <strong>Step 2: Install {setup.label}</strong>
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
              <strong>Step 3: Sign in to {setup.label}</strong>
              <p className="hyo-step-instruction">
                When the installation finishes, type{" "}
                <code>{setup.loginCommand}</code> and press Enter.
              </p>
              <p className="hyo-step-note">
                Your browser will open asking you to log in with your{" "}
                {setup.accountName} account — the same one you already pay for.
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
                <code>{setup.binary}</code> command will be available in the new
                window.
              </p>
              <p>
                <strong>{setup.label} installed somewhere unusual?</strong>
              </p>
              <p>
                Hyo checks the common install locations itself. If yours isn't
                one of them, run <code>{isWindows ? "where" : "which"}{" "}
                {setup.binary}</code> in {terminalName} and paste the result into
                Settings → Hyo Plugin.
              </p>
              <p>
                <strong>Need an account?</strong>
              </p>
              <p>
                {setup.planNote} Sign up at{" "}
                <a href={setup.accountUrl} target="_blank" rel="noopener">
                  {setup.accountUrl.replace("https://", "")}
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
