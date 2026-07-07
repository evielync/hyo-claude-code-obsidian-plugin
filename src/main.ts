import { Plugin, WorkspaceLeaf } from "obsidian";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { HyoView, VIEW_TYPE_HYO } from "./HyoView";
import { HyoSettingTab, HyoSettings, DEFAULT_SETTINGS, dispatchSettingsChanged } from "./settings";
import { cleanupOldAttachments } from "./attachments";

export default class HyoPlugin extends Plugin {
  settings: HyoSettings = DEFAULT_SETTINGS;

  async onload() {
    await this.loadSettings();

    this.registerView(VIEW_TYPE_HYO, (leaf) => new HyoView(leaf, this));

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
