import { Plugin, WorkspaceLeaf, Platform, Notice } from "obsidian";

// Node built-ins are desktop-only. Deferred behind a Platform check so this
// module loads on mobile (where `require` of a Node built-in throws). Every
// use site below is already guarded by `!Platform.isMobile`.
const fs: typeof import("fs") = Platform.isMobile ? (undefined as any) : require("fs");
const path: typeof import("path") = Platform.isMobile ? (undefined as any) : require("path");
const os: typeof import("os") = Platform.isMobile ? (undefined as any) : require("os");
import { HyoView, VIEW_TYPE_HYO } from "./HyoView";
import { HyoSettingTab, HyoSettings, DEFAULT_SETTINGS, dispatchSettingsChanged } from "./settings";
import {
  resolveModelForEngine,
  resolveEffortForEngine,
  DEFAULT_EFFORT,
} from "./models";
import { cleanupOldAttachments } from "./attachments";
import { setDebug } from "./debug";
import { probeCliCapabilities } from "./cli-capabilities";
import { startGatewayHost, stopGatewayHost, GatewayStatus } from "./gateway-host";
import { CommandsManager } from "./commands";

export default class HyoPlugin extends Plugin {
  settings: HyoSettings = DEFAULT_SETTINGS;

  // Note-header command button — see commands.ts.
  commands!: CommandsManager;

  // AI Commands seam: a command that arrived before the chat panel was
  // mounted is parked here and consumed by ChatPanel on mount. When the
  // panel is already open, `runCommand` is set and we call it directly.
  pendingCommand: { prompt: string; notePath?: string } | null = null;
  runCommand: ((prompt: string, notePath?: string) => void) | null = null;

  // Status bar indicator for mobile access (desktop only) — always shows
  // whether the gateway is actually up, so a silent failure is visible.
  private mobileStatusEl: HTMLElement | null = null;

  // Last reported gateway state — the settings tab's Mobile section reads
  // this to show the same truth as the status bar.
  gatewayStatus: GatewayStatus | null = null;

  async onload() {
    await this.loadSettings();

    // Verbose "[hyo] ..." tracing is off by default. Expose the toggle so it
    // can be flipped from the developer console without a rebuild:
    //   hyoDebug(true)  → start logging (spawn args, effort level, CLI errors)
    //   hyoDebug(false) → stop
    (window as any).hyoDebug = setDebug;

    // Detect CLI capabilities up front so the first message can already use
    // `--effort` where it's supported, rather than falling back to the
    // environment variable for one turn. Fire-and-forget — the transport
    // re-probes if this hasn't landed yet. Desktop only — mobile has no CLI.
    if (!Platform.isMobile) void probeCliCapabilities(this.settings.cliPath);

    this.registerView(VIEW_TYPE_HYO, (leaf) => new HyoView(leaf, this));

    // External trigger (e.g. the standalone AI Commands plugin, still running
    // during the transition): open a new chat pre-loaded with a prompt +
    // note. Generic seam — anything can fire `hyo-run-command` with
    // { prompt, notePath }. Kept alongside the merged commands.ts, which
    // calls runFromSeam() below directly instead of round-tripping an event.
    this.registerDomEvent(window, "hyo-run-command", async (evt: Event) => {
      const detail = (evt as CustomEvent).detail || {};
      await this.runFromSeam(detail.prompt || "", detail.notePath);
    });

    // Note-header command button (folded in from the standalone AI Commands
    // plugin). Defers to that plugin while it's still enabled — see
    // CommandsManager.standaloneActive().
    this.commands = new CommandsManager(this.app, this);
    this.commands.onload();

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
    // write far more recently, so only stale files get removed. Desktop only —
    // mobile writes no attachment files (the gateway host handles them).
    if (!Platform.isMobile) {
      try {
        const vaultBase = (this.app.vault.adapter as any).basePath as string;
        const attachmentsDir = path.join(vaultBase, this.manifest.dir || "", "attachments");
        cleanupOldAttachments(attachmentsDir);
      } catch (e) {
        console.error("[hyo] Attachment cleanup setup failed:", e);
      }
    }

    // Host the mobile gateway from this Mac if enabled (desktop only).
    if (!Platform.isMobile && this.settings.enableMobileAccess) {
      this.startMobileHost();
    }
  }

  // Parks a prompt (+ optional note path) and opens/reveals the chat panel,
  // exactly like the `hyo-run-command` window-event listener above. Both the
  // event listener (external triggers) and CommandsManager.fire() (the
  // in-plugin note-header button) go through this single seam.
  async runFromSeam(prompt: string, notePath?: string) {
    if (!prompt) return;
    this.pendingCommand = { prompt, notePath };
    await this.activateView();
    // If the panel is already mounted it wires up `runCommand`; consume here.
    // Otherwise ChatPanel's mount effect consumes `pendingCommand`.
    if (this.runCommand && this.pendingCommand) {
      const cmd = this.pendingCommand;
      this.pendingCommand = null;
      this.runCommand(cmd.prompt, cmd.notePath);
    }
  }

  // Renders the gateway's state into the status bar. "off" hides the item —
  // no indicator when mobile access is disabled, a live one whenever it's on.
  private renderMobileStatus(s: GatewayStatus) {
    if (Platform.isMobile) return;
    this.gatewayStatus = s;
    if (s.state === "off") {
      this.mobileStatusEl?.remove();
      this.mobileStatusEl = null;
      return;
    }
    if (!this.mobileStatusEl) {
      this.mobileStatusEl = this.addStatusBarItem();
      this.mobileStatusEl.addClass("mod-clickable");
      this.mobileStatusEl.onClickEvent(() => {
        const setting = (this.app as any).setting;
        setting?.open?.();
        setting?.openTabById?.("hyo");
      });
    }
    const el = this.mobileStatusEl;
    if (s.state === "starting") {
      el.setText("📱 Mobile: starting…");
      el.setAttribute("aria-label", "Hyo mobile access is starting");
    } else if (s.state === "error") {
      el.setText("📱 Mobile: not working");
      el.setAttribute("aria-label", `Hyo mobile access failed: ${s.detail || "unknown error"}. Click to open settings.`);
    } else {
      el.setText(s.clients > 0 ? `📱 Mobile: on · ${s.clients} connected` : "📱 Mobile: on");
      el.setAttribute("aria-label", s.url ? `Phone address: ${s.url}` : "Hyo mobile access is on");
    }
  }

  startMobileHost() {
    if (Platform.isMobile) return;
    try {
      const vault = (this.app.vault.adapter as any).basePath as string;
      startGatewayHost({
        port: this.settings.gatewayPort,
        vault,
        cliPath: this.settings.cliPath,
        defaultAgent: this.settings.defaultAgent,
        defaultModel: this.settings.model,
        // Write the Mac's own tailnet address into the vault's settings. It
        // syncs to the phone, which then connects automatically — nothing to
        // paste on the phone.
        onConnectUrl: (url: string) => {
          // Only announce when the address is actually news — first setup or
          // a changed address. On every ordinary startup the status bar's
          // "📱 Mobile: on" is confirmation enough.
          if (this.settings.gatewayUrl !== url) {
            this.settings.gatewayUrl = url;
            void this.saveSettings();
            new Notice(
              `Hyo mobile access is on. Your phone will connect automatically once its settings sync.\n(Address, if you ever need it: ${url})`,
              15000,
            );
          }
        },
        onStatus: (s) => this.renderMobileStatus(s),
      });
    } catch (e) {
      console.error("[hyo] Failed to start mobile gateway host:", e);
    }
  }

  stopMobileHost() {
    if (Platform.isMobile) return;
    try {
      stopGatewayHost();
    } catch (e) {
      console.error("[hyo] Failed to stop mobile gateway host:", e);
    }
  }

  onunload() {
    if (!Platform.isMobile) {
      try { stopGatewayHost(); } catch { /* ignore */ }
    }
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
    // The saved model and effort must belong to the engine this vault runs.
    // A live switch resolves them, but settings can also arrive mismatched —
    // edited by hand, synced from another machine, or left over from before
    // the engine was changed — and then the picker shows one engine's model
    // while offering the other's list.
    {
      const engine = this.settings.engine || "claude";
      const model = resolveModelForEngine(engine, this.settings.model);
      const effort = resolveEffortForEngine(
        engine,
        this.settings.effortLevel || DEFAULT_EFFORT,
      );
      if (model !== this.settings.model || effort !== this.settings.effortLevel) {
        this.settings.model = model;
        this.settings.effortLevel = effort;
        await this.saveData(this.settings);
      }
    }

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
    // Desktop only — mobile can't scan the filesystem and its agent list comes
    // from the gateway. Claude only too: agents are its feature, and clearing
    // the setting while another engine is selected would lose the choice for
    // whenever the user switches back.
    if (
      !Platform.isMobile &&
      (this.settings.engine || "claude") === "claude" &&
      this.settings.defaultAgent
    ) {
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
