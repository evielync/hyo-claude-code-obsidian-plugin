import { ItemView, WorkspaceLeaf } from "obsidian";
import { createRoot, Root } from "react-dom/client";
import { createElement } from "react";
import { HyoApp } from "./components/HyoApp";
import type HyoPlugin from "./main";

export const VIEW_TYPE_HYO = "hyo-plugin-view";

export class HyoView extends ItemView {
  private root: Root | null = null;
  private plugin: HyoPlugin;

  constructor(leaf: WorkspaceLeaf, plugin: HyoPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_HYO;
  }

  getDisplayText(): string {
    return "Hyo";
  }

  getIcon(): string {
    return "message-circle";
  }

  async onOpen() {
    // Hide Obsidian's native view header — plugin has its own tab bar
    const header = this.containerEl.children[0] as HTMLElement;
    if (header) header.style.display = "none";

    const container = this.containerEl.children[1] as HTMLElement;
    container.style.padding = "0";
    container.empty();
    container.addClass("hyo-plugin");

    this.root = createRoot(container);
    this.root.render(
      createElement(HyoApp, {
        app: this.app,
        plugin: this.plugin,
      })
    );
  }

  async onClose() {
    if (this.root) {
      this.root.unmount();
      this.root = null;
    }
  }
}
