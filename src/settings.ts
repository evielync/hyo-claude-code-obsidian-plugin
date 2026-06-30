import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import type HyoPlugin from "./main";

export interface HyoSettings {
  cliPath: string;
  model: string;
  permissionMode: string;
  workingDirectory: string;
  defaultAgent: string;
  maxOutputTokens: number;
  autoGenerateTitles: boolean;
  // Voice
  elevenLabsApiKey: string;
  voiceId: string;
  voiceName: string;
  voicePlaybackSpeed: number;
  voiceAutoSpeak: boolean;
}

export const DEFAULT_SETTINGS: HyoSettings = {
  cliPath: "/usr/local/bin/claude",
  model: "claude-sonnet-4-5-20250929",
  permissionMode: "default",
  workingDirectory: "",
  defaultAgent: "",
  maxOutputTokens: 64000,
  autoGenerateTitles: true,
  // Voice
  elevenLabsApiKey: "",
  voiceId: "",
  voiceName: "",
  voicePlaybackSpeed: 1.25,
  voiceAutoSpeak: true,
};

export function dispatchSettingsChanged(): void {
  window.dispatchEvent(new CustomEvent("hyo-settings-changed"));
}

export class HyoSettingTab extends PluginSettingTab {
  plugin: HyoPlugin;
  private savedIndicator: HTMLElement | null = null;
  private savedTimeout: ReturnType<typeof setTimeout> | null = null;

  constructor(app: App, plugin: HyoPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  private showSaved(): void {
    if (this.savedIndicator) {
      if (this.savedTimeout) clearTimeout(this.savedTimeout);
      this.savedIndicator.style.opacity = "1";
      this.savedTimeout = setTimeout(() => {
        if (this.savedIndicator) this.savedIndicator.style.opacity = "0";
      }, 1500);
    }
  }

  private showSavedNear(nameEl: HTMLElement): void {
    this.showSaved();
    const existing = nameEl.querySelector(".hyo-setting-saved");
    if (existing) existing.remove();
    const badge = nameEl.createSpan({
      cls: "hyo-setting-saved",
      text: "✓ Saved",
    });
    badge.style.cssText =
      "margin-left: 8px; font-size: 0.8em; color: var(--color-green); opacity: 1; transition: opacity 0.5s;";
    setTimeout(() => (badge.style.opacity = "0"), 1200);
    setTimeout(() => badge.remove(), 1800);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    const header = containerEl.createEl("div", {
      attr: { style: "display: flex; align-items: baseline; gap: 12px; margin-bottom: 0;" },
    });
    header.createEl("h2", { text: "Hyo Plugin", attr: { style: "margin: 0;" } });
    this.savedIndicator = header.createEl("span", {
      text: "Saved",
      attr: {
        style: "font-size: 0.8em; color: var(--color-green); opacity: 0; transition: opacity 0.3s;",
      },
    });

    const guideLink = containerEl.createEl("p", { attr: { style: "margin: 0 0 20px;" } });
    guideLink.createEl("a", {
      text: "Watch the user guide →",
      href: "https://www.loom.com/share/349eaac59e514142bc47b10469287db0",
      attr: { target: "_blank", rel: "noopener" },
    });

    // Model
    new Setting(containerEl)
      .setName("Model")
      .setDesc("Default model for new conversations")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("claude-opus-4-7", "Opus 4.7 (200K)")
          .addOption("claude-opus-4-6[1m]", "Opus 4.6 (1M)")
          .addOption("claude-opus-4-6", "Opus 4.6 (200K)")
          .addOption("claude-sonnet-5", "Sonnet 5 (1M)")
          .addOption("claude-sonnet-4-6[1m]", "Sonnet 4.6 (1M)")
          .addOption("claude-sonnet-4-6", "Sonnet 4.6 (200K)")
          .addOption("claude-haiku-4-5-20251001", "Haiku 4.5 (200K)")
          .setValue(this.plugin.settings.model)
          .onChange(async (value) => {
            this.plugin.settings.model = value;
            await this.plugin.saveSettings();
            this.showSaved();
          })
      );

    // Permission mode
    new Setting(containerEl)
      .setName("Permission mode")
      .setDesc("How Claude handles tool permissions")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("default", "Default (ask for each)")
          .addOption("acceptEdits", "Accept edits")
          .addOption("bypassPermissions", "Bypass all")
          .addOption("plan", "Plan mode")
          .setValue(this.plugin.settings.permissionMode)
          .onChange(async (value) => {
            this.plugin.settings.permissionMode = value;
            await this.plugin.saveSettings();
            this.showSaved();
          })
      );

    // Auto-generate titles
    new Setting(containerEl)
      .setName("Auto-generate conversation titles")
      .setDesc(
        "Uses a small Claude Haiku call after your first message to name the conversation. Uses your Claude subscription."
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.autoGenerateTitles)
          .onChange(async (value) => {
            this.plugin.settings.autoGenerateTitles = value;
            await this.plugin.saveSettings();
            this.showSaved();
          })
      );

    // Default agent — only show if agent files exist
    const agentDir = path.join(os.homedir(), ".claude", "agents");
    let agentFiles: string[] = [];
    try {
      if (fs.existsSync(agentDir)) {
        agentFiles = fs
          .readdirSync(agentDir)
          .filter((f) => f.endsWith(".md"))
          .map((f) => f.replace(/\.md$/, "").toLowerCase())
          .sort();
      }
    } catch {}

    if (agentFiles.length > 0) {
      const agentSetting = new Setting(containerEl)
        .setName("Default agent")
        .setDesc("Which agent to use when starting new conversations")
        .addDropdown((dropdown) => {
          dropdown.addOption("", "Default (no agent)");
          agentFiles.forEach((name) => dropdown.addOption(name, name));
          dropdown.setValue(this.plugin.settings.defaultAgent || "");
          dropdown.onChange(async (value) => {
            this.plugin.settings.defaultAgent = value;
            await this.plugin.saveSettings();
            this.showSavedNear(
              agentSetting.nameEl as HTMLElement
            );
          });
        });
    }

    // Voice Settings
    containerEl.createEl("h3", {
      text: "Voice",
      attr: { style: "margin-top: 24px; margin-bottom: 12px;" },
    });
    containerEl.createEl("p", {
      text: "Connect ElevenLabs to enable voice mode — speak to Claude and hear responses read aloud.",
      attr: { style: "margin: 0 0 16px; color: var(--text-muted); font-size: 0.9em;" },
    });

    const apiKeySetting = new Setting(containerEl)
      .setName("ElevenLabs API key")
      .setDesc("Get your API key from elevenlabs.io/app/settings/api-keys")
      .addText((text) => {
        text.inputEl.type = "password";
        text.inputEl.style.width = "240px";
        return text
          .setPlaceholder("xi_...")
          .setValue(this.plugin.settings.elevenLabsApiKey)
          .onChange(async (value) => {
            this.plugin.settings.elevenLabsApiKey = value.trim();
            await this.plugin.saveSettings();
            this.showSavedNear(apiKeySetting.nameEl as HTMLElement);
            dispatchSettingsChanged();
          });
      });

    const voiceSetting = new Setting(containerEl)
      .setName("Voice")
      .setDesc("Select a voice from your ElevenLabs library")
      .addDropdown((dropdown) => {
        // Start with current selection or placeholder
        if (this.plugin.settings.voiceId) {
          dropdown.addOption(this.plugin.settings.voiceId, this.plugin.settings.voiceName || "Selected voice");
        } else {
          dropdown.addOption("", "Select a voice...");
        }
        dropdown.setValue(this.plugin.settings.voiceId);

        dropdown.onChange(async (value) => {
          if (!value) return;
          // Find the voice name from the dropdown's display text
          const selectEl = dropdown.selectEl;
          const selectedOption = selectEl.options[selectEl.selectedIndex];
          this.plugin.settings.voiceId = value;
          this.plugin.settings.voiceName = selectedOption?.text || "";
          await this.plugin.saveSettings();
          this.showSavedNear(voiceSetting.nameEl as HTMLElement);
          dispatchSettingsChanged();
        });

        // Async-load voices from ElevenLabs when API key exists
        const apiKey = this.plugin.settings.elevenLabsApiKey;
        if (apiKey) {
          import("./voice/elevenlabs-api").then(({ listVoices }) =>
            listVoices(apiKey).then((voices) => {
              // Clear and repopulate
              const selectEl = dropdown.selectEl;
              const currentValue = this.plugin.settings.voiceId;
              selectEl.empty();

              if (!currentValue) {
                const placeholder = selectEl.createEl("option", { text: "Select a voice...", value: "" });
                placeholder.disabled = true;
                placeholder.selected = true;
              }

              for (const v of voices) {
                const opt = selectEl.createEl("option", { text: v.name, value: v.voice_id });
                if (v.voice_id === currentValue) opt.selected = true;
              }
            }).catch(() => {
              new Notice("Could not load voices — check your ElevenLabs API key");
            })
          );
        }
      });

    new Setting(containerEl)
      .setName("Playback speed")
      .setDesc("How fast Hyo reads responses aloud")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("1", "1.0×")
          .addOption("1.25", "1.25×")
          .addOption("1.5", "1.5×")
          .addOption("2", "2.0×")
          .setValue(String(this.plugin.settings.voicePlaybackSpeed))
          .onChange(async (value) => {
            this.plugin.settings.voicePlaybackSpeed = parseFloat(value);
            await this.plugin.saveSettings();
            this.showSaved();
            dispatchSettingsChanged();
          })
      );

    new Setting(containerEl)
      .setName("Auto-speak responses")
      .setDesc("Automatically read responses aloud when voice mode is active")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.voiceAutoSpeak)
          .onChange(async (value) => {
            this.plugin.settings.voiceAutoSpeak = value;
            await this.plugin.saveSettings();
            this.showSaved();
            dispatchSettingsChanged();
          })
      );

    // Advanced Settings
    containerEl.createEl("h3", {
      text: "Advanced",
      attr: { style: "margin-top: 24px; margin-bottom: 12px;" },
    });
    containerEl.createEl("p", {
      text: "Optional settings for custom configurations.",
      attr: { style: "margin: 0 0 16px; color: var(--text-muted); font-size: 0.9em;" },
    });

    // Working directory
    const workingDirSetting = new Setting(containerEl)
      .setName("Working directory")
      .setDesc(
        "Claude's home folder — where it looks for your CLAUDE.md and starts working from. Defaults to your current Obsidian vault. Set this to a different folder if your Claude project lives outside your vault."
      )
      .addText((text) =>
        text
          .setPlaceholder("Leave blank for current vault")
          .setValue(this.plugin.settings.workingDirectory)
          .onChange(async (value) => {
            this.plugin.settings.workingDirectory = value;
            await this.plugin.saveSettings();
            this.showSavedNear(workingDirSetting.nameEl as HTMLElement);
          })
      );

    workingDirSetting.addButton((button) =>
      button.setButtonText("Browse...").onClick(async () => {
        // @ts-ignore
        // @ts-ignore
        const { dialog } = require("electron").remote;
        const result = await dialog.showOpenDialog({
          properties: ["openDirectory"],
          defaultPath: this.plugin.settings.workingDirectory || os.homedir(),
        });
        if (!result.canceled && result.filePaths.length > 0) {
          this.plugin.settings.workingDirectory = result.filePaths[0];
          await this.plugin.saveSettings();
          this.display();
        }
      })
    );

    // Max output tokens
    const maxTokensSetting = new Setting(containerEl)
      .setName("Max output tokens")
      .setDesc(
        "Cap on response length per turn. Default 64000 works for Sonnet. Lower to 32000 if using Opus models."
      )
      .addText((text) =>
        text
          .setPlaceholder("64000")
          .setValue(String(this.plugin.settings.maxOutputTokens))
          .onChange(async (value) => {
            const n = parseInt(value, 10);
            if (!isNaN(n) && n >= 1024) {
              this.plugin.settings.maxOutputTokens = n;
              await this.plugin.saveSettings();
              this.showSavedNear(maxTokensSetting.nameEl as HTMLElement);
            }
          })
      );

    // CLI path
    const cliPathSetting = new Setting(containerEl)
      .setName("Claude Code CLI path")
      .setDesc(
        "Where Claude Code is installed on your machine. Click 'Auto-detect' to find it automatically."
      )
      .addText((text) =>
        text
          .setPlaceholder("/usr/local/bin/claude")
          .setValue(this.plugin.settings.cliPath)
          .onChange(async (value) => {
            this.plugin.settings.cliPath = value;
            await this.plugin.saveSettings();
            this.showSavedNear(cliPathSetting.nameEl as HTMLElement);
          })
      );

    cliPathSetting.addButton((button) =>
      button.setButtonText("Auto-detect").onClick(async () => {
        const { execSync } = require("child_process");
        const home = os.homedir();
        const isWindows = process.platform === "win32";

        // Try login shell first (picks up full PATH including nvm, npm-global, etc.)
        const shellCmds = isWindows
          ? ["where claude"]
          : [
              "bash -lc 'which claude'",
              "zsh -lc 'which claude'",
            ];

        // Also probe common install locations directly
        const commonPaths = isWindows
          ? []
          : [
              `${home}/.npm-global/bin/claude`,
              "/usr/local/bin/claude",
              "/usr/bin/claude",
              `${home}/.local/bin/claude`,
            ];

        let detected = "";

        for (const cmd of shellCmds) {
          try {
            const result = execSync(cmd, { encoding: "utf8", timeout: 5000 }).trim();
            if (result) { detected = result; break; }
          } catch {}
        }

        if (!detected) {
          for (const p of commonPaths) {
            try {
              if (fs.existsSync(p)) { detected = p; break; }
            } catch {}
          }
        }

        if (detected) {
          this.plugin.settings.cliPath = detected;
          await this.plugin.saveSettings();
          this.display();
          new Notice(`✓ Found Claude at ${detected}`);
        } else {
          new Notice("Could not find Claude CLI. Check the install guide or set the path manually.");
        }
      })
    );

    cliPathSetting.addButton((button) =>
      button.setButtonText("Browse...").onClick(async () => {
        // @ts-ignore
        // @ts-ignore
        const { dialog } = require("electron").remote;
        const result = await dialog.showOpenDialog({
          properties: ["openFile"],
          defaultPath: path.dirname(this.plugin.settings.cliPath || "/usr/local/bin"),
        });
        if (!result.canceled && result.filePaths.length > 0) {
          this.plugin.settings.cliPath = result.filePaths[0];
          await this.plugin.saveSettings();
          this.display();
        }
      })
    );
  }
}
