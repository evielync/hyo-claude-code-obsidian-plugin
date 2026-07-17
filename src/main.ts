import { Plugin, WorkspaceLeaf } from "obsidian";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { HyoView, VIEW_TYPE_HYO } from "./HyoView";
import { HyoSettingTab, HyoSettings, DEFAULT_SETTINGS, dispatchSettingsChanged } from "./settings";
import { cleanupOldAttachments } from "./attachments";

export default class HyoPlugin extends Plugin {
  settings: HyoSettings = DEFAULT_SETTINGS;

  // AI Commands seam: a command that arrived before the chat panel was
  // mounted is parked here and consumed by ChatPanel on mount. When the
  // panel is already open, `runCommand` is set and we call it directly.
  pendingCommand: { prompt: string; notePath?: string } | null = null;
  runCommand: ((prompt: string, notePath?: string) => void) | null = null;

  async onload() {
    await this.loadSettings();

    this.registerView(VIEW_TYPE_HYO, (leaf) => new HyoView(leaf, this));

    // External trigger (e.g. the AI Commands companion plugin): open a new
    // chat pre-loaded with a prompt + note. Generic seam — anything can fire
    // `hyo-run-command` with { prompt, notePath }.
    this.registerDomEvent(window, "hyo-run-command", async (evt: Event) => {
      const detail = (evt as CustomEvent).detail || {};
      const prompt: string = detail.prompt || "";
      if (!prompt) return;
      this.pendingCommand = { prompt, notePath: detail.notePath };
      await this.activateView();
      // If the panel is already mounted it wires up `runCommand`; consume here.
      // Otherwise ChatPanel's mount effect consumes `pendingCommand`.
      if (this.runCommand && this.pendingCommand) {
        const cmd = this.pendingCommand;
        this.pendingCommand = null;
        this.runCommand(cmd.prompt, cmd.notePath);
      }
    });

    this.addRibbonIcon("message-circle", "Open Hyo", () => {
      this.activateView();
    });

    this.addCommand({
      id: "open-hyo",
      name: "Open chat panel",
      hotkeys: [{ modifiers: ["Mod", "Shift"], key: "h" }],
      callback: () => this.activateView(),
    });

    this.addSettingTab(new HyoSettingTab(this.app, this));

    // Sweep old attachment files (> 1 day). Safe because active sessions
    // write far more recently, so only stale files get removed.
    try {
      const vaultBase = (this.app.vault.adapter as any).basePath as string;
      const attachmentsDir = path.join(vaultBase, this.manifest.dir || "", "attachments");
      cleanupOldAttachments(attachmentsDir);
    } catch (e) {
      console.error("[hyo] Attachment cleanup setup failed:", e);
    }
  }

  onunload() {
    // Unmount React and clean up child processes for all Hyo leaves
    this.app.workspace.getLeavesOfType(VIEW_TYPE_HYO).forEach((leaf) => {
      (leaf.view as HyoView).onClose();
    });
  }

  async loadSettings() {
    this.settings = Object.assign(
      {},
      DEFAULT_SETTINGS,
      await this.loadData()
    );
    // Reset stale shorthand model IDs to the default (Sonnet)
    const staleShorthands = ["opus", "sonnet", "haiku"];
    if (staleShorthands.includes(this.settings.model)) {
      this.settings.model = DEFAULT_SETTINGS.model;
      await this.saveData(this.settings);
    }
    // Sonnet 5 shipped in 0.3.5 with a "[1m]" suffix in its model ID. 0.3.6
    // dropped the suffix (Sonnet 5 runs 1M natively and doesn't accept it —
    // the API silently drops to 200K context if you pass it), but settings
    // saved under 0.3.5 still have the old string. Migrate it forward.
    if (this.settings.model === "claude-sonnet-5[1m]") {
      this.settings.model = "claude-sonnet-5";
      await this.saveData(this.settings);
    }
    // The CLI renamed the "default" permission mode to "manual" at some
    // point after 2.1.32. Settings saved under the old CLI still have the
    // old string, which the new CLI rejects as an invalid --permission-mode
    // value. Migrate it forward.
    if (this.settings.permissionMode === "default") {
      this.settings.permissionMode = "manual";
      await this.saveData(this.settings);
    }
    // Clear defaultAgent if no matching file exists in ~/.claude/agents/.
    // Fixes stale state from older plugin versions that hardcoded an agent name.
    if (this.settings.defaultAgent) {
      try {
        const agentFile = path.join(
          os.homedir(),
          ".claude",
          "agents",
          `${this.settings.defaultAgent}.md`
        );
        if (!fs.existsSync(agentFile)) {
          this.settings.defaultAgent = "";
          await this.saveData(this.settings);
        }
      } catch {
        this.settings.defaultAgent = "";
        await this.saveData(this.settings);
      }
    }
  }

  async saveSettings() {
    await this.saveData(this.settings);
    dispatchSettingsChanged();
  }

  async activateView() {
    const { workspace } = this.app;

    let leaf: WorkspaceLeaf | null = null;
    const leaves = workspace.getLeavesOfType(VIEW_TYPE_HYO);

    if (leaves.length > 0) {
      leaf = leaves[0];
    } else {
      const rightLeaf = workspace.getRightLeaf(false);
      if (rightLeaf) {
        leaf = rightLeaf;
        await leaf.setViewState({ type: VIEW_TYPE_HYO, active: true });
      }
    }

    if (leaf) {
      workspace.revealLeaf(leaf);
    }
  }
}
