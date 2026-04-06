import { App, PluginSettingTab, Setting } from "obsidian";
import type HyoPlugin from "./main";

export interface HyoSettings {
  cliPath: string;
  model: string;
  permissionMode: string;
  workingDirectory: string;
}

export const DEFAULT_SETTINGS: HyoSettings = {
  cliPath: "/usr/local/bin/claude",
  model: "claude-sonnet-4-5-20250929",
  permissionMode: "default",
  workingDirectory: "", // Empty means use current vault
};

export class HyoSettingTab extends PluginSettingTab {
  plugin: HyoPlugin;

  constructor(app: App, plugin: HyoPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Hyo Plugin" });

    // Model
    new Setting(containerEl)
      .setName("Model")
      .setDesc("Default model for new conversations")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("claude-opus-4-6[1m]", "Opus 4.6 (1M)")
          .addOption("claude-opus-4-6", "Opus 4.6 (200K)")
          .addOption("claude-sonnet-4-5-20250929[1m]", "Sonnet 4.5 (1M)")
          .addOption("claude-sonnet-4-5-20250929", "Sonnet 4.5 (200K)")
          .addOption("claude-haiku-4-5-20251001", "Haiku 4.5 (200K)")
          .setValue(this.plugin.settings.model)
          .onChange(async (value) => {
            this.plugin.settings.model = value;
            await this.plugin.saveSettings();
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
          })
      );

    // Advanced Settings
    containerEl.createEl("h3", {
      text: "Advanced",
      attr: { style: "margin-top: 24px; margin-bottom: 12px;" },
    });

    const advancedDesc = containerEl.createEl("p", {
      text: "Optional settings for custom configurations.",
      attr: {
        style:
          "margin: 0 0 16px; color: var(--text-muted); font-size: 0.9em;",
      },
    });

    // Working directory
    const workingDirSetting = new Setting(containerEl)
      .setName("Working directory")
      .setDesc(
        "Where Claude Code runs. Leave blank to use your current Obsidian vault."
      )
      .addText((text) =>
        text
          .setPlaceholder("Leave blank for current vault")
          .setValue(this.plugin.settings.workingDirectory)
          .onChange(async (value) => {
            this.plugin.settings.workingDirectory = value;
            await this.plugin.saveSettings();
          })
      );

    workingDirSetting.addButton((button) =>
      button.setButtonText("Browse...").onClick(async () => {
        const input = document.createElement("input");
        input.type = "file";
        input.setAttribute("webkitdirectory", "");
        input.setAttribute("directory", "");
        input.onchange = async (e: Event) => {
          const target = e.target as HTMLInputElement;
          const files = target.files;
          if (files && files.length > 0) {
            const path = files[0].path;
            const dirPath = path.substring(0, path.lastIndexOf("/"));
            this.plugin.settings.workingDirectory = dirPath;
            await this.plugin.saveSettings();
            this.display();
          }
        };
        input.click();
      })
    );

    // CLI path
    const cliPathSetting = new Setting(containerEl)
      .setName("Claude Code CLI path")
      .setDesc(
        "Default is /usr/local/bin/claude. Only change if Claude is installed elsewhere."
      )
      .addText((text) =>
        text
          .setPlaceholder("/usr/local/bin/claude")
          .setValue(this.plugin.settings.cliPath)
          .onChange(async (value) => {
            this.plugin.settings.cliPath = value;
            await this.plugin.saveSettings();
          })
      );

    cliPathSetting.addButton((button) =>
      button.setButtonText("Browse...").onClick(async () => {
        const input = document.createElement("input");
        input.type = "file";
        input.onchange = async (e: Event) => {
          const target = e.target as HTMLInputElement;
          const files = target.files;
          if (files && files.length > 0) {
            this.plugin.settings.cliPath = files[0].path;
            await this.plugin.saveSettings();
            this.display();
          }
        };
        input.click();
      })
    );
  }
}
