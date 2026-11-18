import { ItemView, WorkspaceLeaf, Platform } from "obsidian";
import { createRoot, Root } from "react-dom/client";
import { createElement } from "react";
import { HyoApp } from "./components/HyoApp";
import { HyoApp as MobileHyoApp } from "./mobile/components/HyoApp";
import type HyoPlugin from "./main";

export const VIEW_TYPE_HYO = "hyo-plugin-view";

export class HyoView extends ItemView {
  private root: Root | null = null;
  private plugin: HyoPlugin;
  /** The mobile drawer this view sits in, marked for styles.css's seam fix. */
  private hostDrawer: HTMLElement | null = null;

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
    // Desktop draws its own tab bar, so it hides Obsidian's native view
    // header; mobile leaves the native header in place (matches the mobile app).
    if (!Platform.isMobile) {
      const header = this.containerEl.children[0] as HTMLElement;
      if (header) header.addClass("hyo-hidden-view-header");
    }

    const container = this.containerEl.children[1] as HTMLElement;
    container.addClass("hyo-view-content");
    container.empty();
    container.addClass("hyo-plugin");

    // On a phone or tablet the view lives in a drawer whose chrome Obsidian
    // paints white; styles.css repaints the drawer marked here to match the
    // chat. A leaf can be moved, so the mark follows it on layout changes.
    if (Platform.isMobile) {
      this.markHostDrawer();
      this.registerEvent(this.app.workspace.on("layout-change", () => this.markHostDrawer()));
    }

    const props = { app: this.app, plugin: this.plugin, isShown: () => this.isOnScreen() };
    this.root = createRoot(container);
    this.root.render(Platform.isMobile ? createElement(MobileHyoApp, props) : createElement(HyoApp, props));
  }

  /** The panel can be seen: its tab is the one showing, and its sidebar is open. */
  isOnScreen(): boolean {
    if (this.containerEl.doc.visibilityState === "hidden") return false;
    // A sidebar (or the mobile drawer) has `collapsed`; the main area doesn't.
    const root = this.leaf.getRoot();
    if ("collapsed" in root && root.collapsed) return false;
    return this.containerEl.isShown();
  }

  private markHostDrawer(): void {
    const drawer = this.containerEl.closest<HTMLElement>(".workspace-drawer");
    if (drawer === this.hostDrawer) return;
    this.hostDrawer?.removeClass("hyo-drawer-host");
    drawer?.addClass("hyo-drawer-host");
    this.hostDrawer = drawer;
  }

  async onClose() {
    this.hostDrawer?.removeClass("hyo-drawer-host");
    this.hostDrawer = null;
    if (this.root) {
      this.root.unmount();
      this.root = null;
    }
  }
}
