import { Platform } from "obsidian";
import { createRoot, type Root } from "react-dom/client";
import { createElement } from "react";
import { DockApp } from "./components/DockApp";
import type HyoPlugin from "./main";

// The dock: a strip on the edge of the Obsidian window showing the open
// conversations, with a pop-up to carry one on over whatever note is open.
// Settings → Dock, desktop only. It lives on the workspace itself, not in a
// sidebar leaf, so it's there whatever the sidebars show, or with them shut.
// Conversations are run by the plugin (session-owner.ts), not by the panel,
// so the dock needs neither the Hyo panel nor the mobile gateway.
export class Dock {
  private host: HTMLElement | null = null;
  private root: Root | null = null;

  constructor(private plugin: HyoPlugin) {}

  /** Show or remove the dock to match Settings. */
  sync(): void {
    const want = !Platform.isMobile && !!this.plugin.settings.dock;
    if (want && !this.root) this.mount();
    else if (!want && this.root) this.unmount();
  }

  private mount(): void {
    try {
      this.host = document.body.createDiv({ cls: "hyo-dock-host" });
      this.root = createRoot(this.host);
      this.root.render(createElement(DockApp, { app: this.plugin.app, plugin: this.plugin }));
    } catch (e) {
      console.error("[hyo] Couldn't show the dock:", e);
      this.unmount();
    }
  }

  unmount(): void {
    try {
      this.root?.unmount();
    } catch (e) {
      console.error("[hyo] Couldn't remove the dock:", e);
    }
    this.root = null;
    this.host?.remove();
    this.host = null;
  }
}
