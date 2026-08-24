import { App, Notice, PluginSettingTab, Setting, Platform } from "obsidian";
// Node built-ins are desktop-only; deferred so this module loads on mobile.
const fs: typeof import("fs") = Platform.isMobile ? (undefined as any) : require("fs");
const path: typeof import("path") = Platform.isMobile ? (undefined as any) : require("path");
const os: typeof import("os") = Platform.isMobile ? (undefined as any) : require("os");
import type HyoPlugin from "./main";
import { MODEL_OPTIONS, EFFORT_OPTIONS, DEFAULT_EFFORT } from "./models";
import type { Skill } from "./hooks/useSkills";

// A single command: which skill it fires, what its header-menu label reads,
// and any extra instruction text appended after the skill invocation.
export interface HyoCommand {
  skill: string;
  label: string;
  extra?: string;
}

export interface HyoSettings {
  cliPath: string;
  model: string;
  effortLevel: string;
  customModels: string[];
  permissionMode: string;
  workingDirectory: string;
  defaultAgent: string;
  maxOutputTokens: number;
  autoGenerateTitles: boolean;
  // Mobile: the gateway URL the phone connects to (also what desktop hosts
  // when "enable mobile access" is on), and the permission default sent with
  // every mobile prompt.
  gatewayUrl: string;
  askFirst: boolean;
  enableMobileAccess: boolean;
  // The local port this vault's gateway listens on. Per-vault so more than one
  // vault can host mobile access at once without colliding, and so a user whose
  // 8787 is already taken can move it.
  gatewayPort: number;
  // Last version whose release card was seen. Empty on a fresh install, which
  // suppresses the card — a first-time user doesn't need to be told what
  // changed in a version they never had.
  lastSeenVersion: string;
  // Voice
  elevenLabsApiKey: string;
  voiceId: string;
  voiceName: string;
  voicePlaybackSpeed: number;
  voiceAutoSpeak: boolean;
  // Task mode — per-conversation metadata, keyed by cliSessionId. Everything
  // else about a task (its state) is derived live; only these few things need
  // to persist across reloads. See hyo-task-mode-build-spec.
  tasks: Record<string, TaskMeta>;
  // Commands — note `type` frontmatter -> the header-button commands for that
  // type. Ported from the standalone AI Commands plugin (see commandsMigrated).
  commands: Record<string, HyoCommand[]>;
  // Set once the one-time import of the standalone plugin's data.json has
  // run (successfully or not), so it's never re-attempted on every load.
  commandsMigrated: boolean;
}

// Persisted per-task metadata. Keyed by cliSessionId in settings.tasks.
export interface TaskMeta {
  pinned?: boolean; // floats to the top of the board
  closed?: boolean; // off the board, into the Closed filter
  lastActive?: string; // ISO timestamp — recency sort, updated on any turn
  title?: string; // cached so closed/background tasks have a name without parsing
}

export const DEFAULT_SETTINGS: HyoSettings = {
  cliPath: "/usr/local/bin/claude",
  // Must be a model the picker actually offers — otherwise a fresh install
  // shows a raw model ID in the status bar with nothing ticked in the picker.
  model: "claude-sonnet-5",
  effortLevel: DEFAULT_EFFORT,
  customModels: [],
  permissionMode: "manual",
  workingDirectory: "",
  defaultAgent: "",
  maxOutputTokens: 64000,
  autoGenerateTitles: true,
  gatewayUrl: "",
  askFirst: true,
  enableMobileAccess: false,
  gatewayPort: 8787,
  lastSeenVersion: "",
  // Voice
  elevenLabsApiKey: "",
  voiceId: "",
  voiceName: "",
  voicePlaybackSpeed: 1.25,
  voiceAutoSpeak: true,
  tasks: {},
  commands: {},
  commandsMigrated: false,
};

export function dispatchSettingsChanged(): void {
  window.dispatchEvent(new CustomEvent("hyo-settings-changed"));
}

export class HyoSettingTab extends PluginSettingTab {
  plugin: HyoPlugin;
  private savedIndicator: HTMLElement | null = null;
  private savedTimeout: ReturnType<typeof setTimeout> | null = null;
  // Which settings tab is showing. Survives re-renders (display() is called
  // after most edits) so adding a command doesn't bounce you back to General.
  private activeTab = "general";

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

    // One row: title, links, and the saved indicator all on the same baseline.
    const header = containerEl.createEl("div", {
      attr: {
        style: "display: flex; align-items: baseline; gap: 16px; flex-wrap: wrap; margin-bottom: 20px;",
      },
    });
    header.createEl("h2", { text: "Hyo Plugin", attr: { style: "margin: 0;" } });
    header.createEl("a", {
      text: "Read the docs →",
      href: "https://docs.gethyo.co",
      attr: { target: "_blank", rel: "noopener" },
    });
    header.createEl("a", {
      text: "Watch the user guide →",
      href: "https://www.loom.com/share/349eaac59e514142bc47b10469287db0",
      attr: { target: "_blank", rel: "noopener" },
    });
    this.savedIndicator = header.createEl("span", {
      text: "Saved",
      attr: {
        style: "font-size: 0.8em; color: var(--color-green); opacity: 0; transition: opacity 0.3s;",
      },
    });

    // Tab bar. On a phone only the tabs that apply there are shown — Commands
    // and Advanced are desktop concerns (note-header buttons, CLI paths).
    const tabs: { id: string; label: string }[] = Platform.isMobile
      ? [
          { id: "general", label: "General" },
          { id: "voice", label: "Voice" },
          { id: "mobile", label: "Mobile" },
        ]
      : [
          { id: "general", label: "General" },
          { id: "voice", label: "Voice" },
          { id: "mobile", label: "Mobile" },
          { id: "commands", label: "Commands" },
          { id: "advanced", label: "Advanced" },
        ];
    if (!tabs.some((t) => t.id === this.activeTab)) this.activeTab = "general";

    const bar = containerEl.createEl("div", {
      attr: {
        style:
          "display: flex; gap: 4px; margin-bottom: 20px; border-bottom: 1px solid var(--background-modifier-border);",
      },
    });
    for (const tab of tabs) {
      const active = tab.id === this.activeTab;
      const btn = bar.createEl("div", {
        text: tab.label,
        attr: {
          style:
            `padding: 8px 14px; cursor: pointer; font-size: 0.95em; border-bottom: 2px solid ${
              active ? "var(--interactive-accent)" : "transparent"
            }; color: ${active ? "var(--text-normal)" : "var(--text-muted)"}; font-weight: ${
              active ? "600" : "400"
            };`,
        },
      });
      btn.addEventListener("click", () => {
        this.activeTab = tab.id;
        this.display();
      });
    }

    const body = containerEl.createDiv();
    if (this.activeTab === "voice") this.renderVoice(body);
    else if (this.activeTab === "mobile") this.renderMobile(body);
    else if (this.activeTab === "commands") this.renderCommands(body);
    else if (this.activeTab === "advanced") this.renderAdvanced(body);
    else this.renderGeneral(body);
  }

  // ---- General: everyday defaults for new conversations ---------------------
  private renderGeneral(containerEl: HTMLElement): void {
    // Model
    new Setting(containerEl)
      .setName("Model")
      .setDesc("Default model for new conversations")
      .addDropdown((dropdown) => {
        // Built-in models, then any the user added via the picker's custom
        // field. Both come from the shared MODEL_OPTIONS / settings so the
        // dropdown never drifts from the picker.
        for (const m of MODEL_OPTIONS) {
          dropdown.addOption(m.id, `${m.name} (${m.context})`);
        }
        for (const id of this.plugin.settings.customModels) {
          dropdown.addOption(id, id);
        }
        // If the saved default isn't in either list (e.g. an older model kept
        // from a previous version), surface it so the dropdown reflects reality
        // instead of silently showing the first option.
        const known =
          MODEL_OPTIONS.some((m) => m.id === this.plugin.settings.model) ||
          this.plugin.settings.customModels.includes(this.plugin.settings.model);
        if (!known && this.plugin.settings.model) {
          dropdown.addOption(this.plugin.settings.model, this.plugin.settings.model);
        }
        dropdown
          .setValue(this.plugin.settings.model)
          .onChange(async (value) => {
            this.plugin.settings.model = value;
            await this.plugin.saveSettings();
            this.showSaved();
          });
      });

    // Reasoning effort
    new Setting(containerEl)
      .setName("Effort")
      .setDesc(
        "Default reasoning effort for new conversations. Higher effort means more thorough responses, but they take longer and use your limits faster."
      )
      .addDropdown((dropdown) => {
        for (const e of EFFORT_OPTIONS) {
          dropdown.addOption(e.id, e.name);
        }
        dropdown
          .setValue(this.plugin.settings.effortLevel || DEFAULT_EFFORT)
          .onChange(async (value) => {
            this.plugin.settings.effortLevel = value;
            await this.plugin.saveSettings();
            this.showSaved();
          });
      });

    // Permission mode
    new Setting(containerEl)
      .setName("Permission mode")
      .setDesc("What Claude may do without asking you first. 'Default' asks before every action; 'Accept edits' lets it change files freely; 'Bypass all' never asks; 'Plan mode' makes it propose a plan before doing anything.")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("manual", "Default (ask for each)")
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

    // Default agent — desktop only (scans the filesystem), and only shown if
    // agent files exist. On mobile the agent is picked per conversation from
    // the gateway's list instead.
    let agentFiles: string[] = [];
    if (!Platform.isMobile) {
      try {
        const agentDir = path.join(os.homedir(), ".claude", "agents");
        if (fs.existsSync(agentDir)) {
          agentFiles = fs
            .readdirSync(agentDir)
            .filter((f) => f.endsWith(".md"))
            .map((f) => f.replace(/\.md$/, "").toLowerCase())
            .sort();
        }
      } catch {}
    }

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

    // Custom models — added via the picker's "Custom model ID" field; managed
    // (removed) here, next to the Model default they feed. Only rendered once
    // at least one has been added, so it never shows as an empty section.
    if (this.plugin.settings.customModels.length > 0) {
      new Setting(containerEl).setName("Custom models").setHeading();
      new Setting(containerEl).setDesc(
        "Models you've added from the picker. Remove any you no longer want here."
      );
      for (const id of [...this.plugin.settings.customModels]) {
        new Setting(containerEl)
          .setName(id)
          .setDesc("Added from the model picker")
          .addExtraButton((btn) =>
            btn
              .setIcon("trash")
              .setTooltip("Remove")
              .onClick(async () => {
                this.plugin.settings.customModels =
                  this.plugin.settings.customModels.filter((m) => m !== id);
                // If the removed model was the current default, fall back to
                // the first built-in so nothing points at a now-absent entry.
                if (this.plugin.settings.model === id) {
                  this.plugin.settings.model = MODEL_OPTIONS[0].id;
                }
                await this.plugin.saveSettings();
                this.showSaved();
                this.display();
              })
          );
      }
    }
  }

  // ---- Voice: ElevenLabs voice mode ------------------------------------------
  private renderVoice(containerEl: HTMLElement): void {
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

  }

  // ---- Advanced: paths and caps ----------------------------------------------
  private renderAdvanced(containerEl: HTMLElement): void {
    containerEl.createEl("p", {
      text: "You shouldn't need these unless something isn't working or your setup is unusual.",
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

    // CLI path — with a live found/not-found indicator, because a stale path
    // here used to surface only as a cryptic "exited (code -2)" mid-chat.
    const cliPathSetting = new Setting(containerEl)
      .setName("Claude Code CLI path")
      .setDesc(
        "Where Claude Code is installed on your machine. Click 'Auto-detect' to find it automatically."
      );
    const cliStatusEl = cliPathSetting.descEl.createEl("div", {
      attr: { style: "margin-top: 4px; font-size: 0.95em;" },
    });
    const updateCliStatus = (p: string) => {
      let found = false;
      try {
        found = !!p && fs.existsSync(p);
      } catch {
        found = false;
      }
      cliStatusEl.setText(found ? "✓ Found" : "✗ Not found — click Auto-detect");
      cliStatusEl.style.color = found ? "var(--color-green)" : "var(--color-red)";
    };
    updateCliStatus(this.plugin.settings.cliPath);
    cliPathSetting.addText((text) =>
      text
        .setPlaceholder("/usr/local/bin/claude")
        .setValue(this.plugin.settings.cliPath)
        .onChange(async (value) => {
          this.plugin.settings.cliPath = value;
          await this.plugin.saveSettings();
          updateCliStatus(value);
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

  // ---- Commands: note-header buttons ------------------------------------------
  // Ported from the standalone AI Commands plugin. A note's `type` frontmatter
  // drives which commands show.
  private renderCommands(containerEl: HTMLElement): void {
    const intro = containerEl.createEl("p", {
      attr: { style: "margin: 0 0 16px; color: var(--text-muted); font-size: 0.9em;" },
    });
    intro.setText(
      "Attach a skill to a note type in your vault and run one-click commands. For example: a Summarise command on your meeting notes. ",
    );
    intro.createEl("a", {
      text: "How commands work →",
      href: "https://docs.gethyo.co/skills/note-commands/",
      attr: { target: "_blank", rel: "noopener" },
    });

    const commandSkills = this.plugin.commands.getSkills();
    const configuredTypes = Object.keys(this.plugin.settings.commands).sort();

    for (const type of configuredTypes) {
      this.renderCommandType(containerEl, type, commandSkills);
    }

    const availableTypes = this.plugin.commands
      .getNoteTypes()
      .filter((t) => !this.plugin.settings.commands[t]);

    if (availableTypes.length) {
      let newType = availableTypes[0];
      new Setting(containerEl)
        .setName("Add a note type")
        .setDesc("Pick a note type found in your vault to add commands for.")
        .addDropdown((d) => {
          for (const t of availableTypes) d.addOption(t, t);
          d.setValue(newType);
          d.onChange((v) => {
            newType = v;
          });
        })
        .addButton((b) =>
          b
            .setButtonText("Add")
            .setCta()
            .onClick(async () => {
              if (!newType || this.plugin.settings.commands[newType]) return;
              this.plugin.settings.commands[newType] = [];
              await this.plugin.saveSettings();
              this.display();
            })
        );
    } else {
      new Setting(containerEl)
        .setName("Add a note type")
        .setDesc(
          configuredTypes.length
            ? "Every note type in your vault already has commands configured."
            : "No note types found — open a note with a `type` in its frontmatter first."
        );
    }

  }

  // ---- Mobile: gateway hosting (desktop) / gateway address (phone) ------------
  private renderMobile(containerEl: HTMLElement): void {
    if (Platform.isMobile) {
      const intro = containerEl.createEl("p", {
        attr: { style: "margin: 0 0 16px; color: var(--text-muted); font-size: 0.9em;" },
      });
      intro.setText(
        "Hyo on your phone talks to Claude running on your Mac. Set up your Mac first — this side mostly takes care of itself. ",
      );
      intro.createEl("a", {
        text: "Read the setup guide →",
        href: "https://docs.gethyo.co/mobile/setup/",
        attr: { target: "_blank", rel: "noopener" },
      });
    } else {
      const mutedStyle = "margin: 0 0 12px; color: var(--text-muted); font-size: 0.9em;";
      containerEl.createEl("p", {
        text: "Set up Hyo to work on your mobile devices, so you can talk to your agent from anywhere. This involves setting up a mobile gateway on your desktop that the mobile can connect to.",
        attr: { style: mutedStyle },
      });
      const guide = containerEl.createEl("p", { attr: { style: mutedStyle } });
      guide.createEl("a", {
        text: "Read the setup guide to get started →",
        href: "https://docs.gethyo.co/mobile/setup/",
        attr: { target: "_blank", rel: "noopener" },
      });
      const steps = containerEl.createEl("ol", {
        attr: { style: "margin: 0 0 16px; padding-left: 20px; color: var(--text-muted); font-size: 0.9em;" },
      });
      steps.createEl("li", {
        text: "Download Tailscale on your desktop and mobile device first (it won't work without Tailscale).",
      });
      steps.createEl("li", {
        text: "Switch on mobile access. You'll need to leave your Obsidian vault open and your computer on for the mobile gateway to work.",
      });
    }

    if (Platform.isMobile) {
      const gwSetting = new Setting(containerEl)
        .setName("Gateway address")
        .setDesc(
          "The address of your Mac. It fills in by itself when this vault syncs from your Mac — only enter it by hand if it hasn't come through. You can copy it from the Mac's Hyo settings, under Mobile.",
        )
        .addText((text) =>
          text
            .setPlaceholder("wss://your-mac.tailXXXX.ts.net/")
            .setValue(this.plugin.settings.gatewayUrl)
            .onChange(async (value) => {
              this.plugin.settings.gatewayUrl = value.trim();
              await this.plugin.saveSettings();
              this.showSavedNear(gwSetting.nameEl as HTMLElement);
            })
        );
    } else {
      new Setting(containerEl)
        .setName("Enable mobile access")
        .setDesc("Host the gateway from this Mac while Obsidian is open, so your phone can connect.")
        .addToggle((toggle) =>
          toggle
            .setValue(this.plugin.settings.enableMobileAccess)
            .onChange(async (value) => {
              this.plugin.settings.enableMobileAccess = value;
              await this.plugin.saveSettings();
              if (value) this.plugin.startMobileHost();
              else this.plugin.stopMobileHost();
              // The gateway comes up (or down) asynchronously — re-render once
              // it has had a moment, so the status below tells the truth.
              setTimeout(() => {
                if (this.activeTab === "mobile") this.display();
              }, 2500);
            })
        );

      // Live status — same truth as the status bar item, shown where you'd
      // look for it. Includes the address the phone connects to, copyable.
      const s = this.plugin.gatewayStatus;
      const statusText =
        !s || s.state === "off"
          ? "Off"
          : s.state === "starting"
            ? "Starting…"
            : s.state === "error"
              ? `Not working — ${s.detail || "unknown error"}`
              : s.clients > 0
                ? `On · ${s.clients} device${s.clients === 1 ? "" : "s"} connected`
                : "On";
      const statusSetting = new Setting(containerEl).setName("Status").setDesc(statusText);
      statusSetting.descEl.style.color =
        s?.state === "on" ? "var(--color-green)" : s?.state === "error" ? "var(--color-red)" : "var(--text-muted)";

      if (s?.state === "on" && s.url) {
        new Setting(containerEl)
          .setName("Phone address")
          .setDesc(s.url)
          .addButton((b) =>
            b.setButtonText("Copy").onClick(async () => {
              await navigator.clipboard.writeText(s.url as string);
              new Notice("Address copied. It also syncs to your phone automatically.");
            })
          );
      }

      // The gateway port isn't shown: it's internal (Tailscale fronts it) and
      // the host auto-picks a free one. gatewayPort stays in settings only as
      // the starting point for that search.
    }
  }

  // One card per configured note type: a header (count + add/remove-type
  // buttons) and a row per command (label, skill, extra instruction, delete).
  private renderCommandType(containerEl: HTMLElement, type: string, skills: Skill[]): void {
    const commands = this.plugin.settings.commands[type];

    const typeHeading = new Setting(containerEl)
      .setName(type)
      .setDesc(
        commands.length === 0
          ? "No commands"
          : commands.length === 1
          ? "1 command"
          : `${commands.length} commands`
      );
    typeHeading.nameEl.style.fontWeight = "600";
    typeHeading.settingEl.style.marginTop = "8px";
    typeHeading.addButton((b) =>
      b.setButtonText("Add command").onClick(async () => {
        commands.push({ skill: skills.length ? skills[0].name : "", label: "", extra: "" });
        await this.plugin.saveSettings();
        this.display();
      })
    );
    typeHeading.addExtraButton((b) =>
      b
        .setIcon("trash")
        .setTooltip("Remove this note type")
        .onClick(async () => {
          delete this.plugin.settings.commands[type];
          await this.plugin.saveSettings();
          this.display();
        })
    );

    commands.forEach((cmd, i) => {
      const row = new Setting(containerEl);
      // The row's built-in name column would only duplicate the label input —
      // and crush it to a couple of characters. Remove it and give the whole
      // row to the controls, nested under the note-type heading.
      row.infoEl.remove();
      row.settingEl.style.paddingLeft = "24px";
      row.settingEl.style.borderTop = "none";
      row.controlEl.style.flex = "1";
      row.controlEl.style.justifyContent = "flex-start";
      row.addText((text) => {
        text
          .setPlaceholder("Command name")
          .setValue(cmd.label || "")
          .onChange(async (v) => {
            cmd.label = v;
            await this.plugin.saveSettings();
          });
        text.inputEl.style.flex = "1";
        text.inputEl.style.minWidth = "120px";
      });
      row.addDropdown((dropdown) => {
        for (const sk of skills) dropdown.addOption(sk.name, sk.name);
        if (cmd.skill && !skills.find((sk) => sk.name === cmd.skill)) {
          dropdown.addOption(cmd.skill, `${cmd.skill} (not found)`);
        }
        dropdown.setValue(cmd.skill || skills[0]?.name || "");
        dropdown.onChange(async (v) => {
          cmd.skill = v;
          await this.plugin.saveSettings();
        });
        dropdown.selectEl.style.maxWidth = "220px";
      });
      row.addText((text) => {
        text
          .setPlaceholder("Extra instruction (optional)")
          .setValue(cmd.extra || "")
          .onChange(async (v) => {
            cmd.extra = v;
            await this.plugin.saveSettings();
          });
        text.inputEl.style.flex = "1.4";
        text.inputEl.style.minWidth = "160px";
      });
      row.addExtraButton((b) =>
        b
          .setIcon("trash-2")
          .setTooltip("Delete command")
          .onClick(async () => {
            commands.splice(i, 1);
            await this.plugin.saveSettings();
            this.display();
          })
      );
    });
  }
}
