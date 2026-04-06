import { Plugin, WorkspaceLeaf } from "obsidian";
import { HyoView, VIEW_TYPE_HYO } from "./HyoView";
import { HyoSettingTab, HyoSettings, DEFAULT_SETTINGS } from "./settings";

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
  }

  async saveSettings() {
    await this.saveData(this.settings);
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
