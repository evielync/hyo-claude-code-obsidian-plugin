import { App, Menu, MarkdownView, Notice, Platform, TFile } from "obsidian";
import type HyoPlugin from "./main";
import type { HyoCommand } from "./settings";
import type { Skill } from "./hooks/useSkills";
import { withBundledSkills } from "./bundled-skills";

// Node built-ins are desktop-only; deferred so this module loads on mobile.
const fs: typeof import("fs") = Platform.isMobile ? (undefined as any) : require("fs");
const path: typeof import("path") = Platform.isMobile ? (undefined as any) : require("path");
const os: typeof import("os") = Platform.isMobile ? (undefined as any) : require("os");

const ICON = "sparkles";

// The id the standalone "AI Commands" plugin ships under. While it's enabled,
// merged Hyo defers to it (see standaloneActive()) so Ev doesn't get two
// header buttons firing the same command twice.
const STANDALONE_PLUGIN_ID = "ai-commands";

/**
 * Ports the standalone AI Commands plugin's note-header button into Hyo.
 *
 * A note's `type` frontmatter drives which commands appear in its header
 * menu (configured in Hyo's settings, Commands section). Firing one builds
 * `/<skill> <extra>` plus the note's path and sends it through the same
 * `pendingCommand` / `activateView()` seam the `hyo-run-command` window event
 * already uses in main.ts — so this and the standalone plugin (still running
 * during the transition) both land in the same place.
 */
export class CommandsManager {
  constructor(
    private app: App,
    private plugin: HyoPlugin
  ) {}

  onload(): void {
    const refresh = () => this.refreshButtons();
    this.plugin.registerEvent(this.app.workspace.on("active-leaf-change", refresh));
    this.plugin.registerEvent(this.app.workspace.on("file-open", refresh));
    this.plugin.registerEvent(this.app.workspace.on("layout-change", refresh));
    // Frontmatter parses asynchronously — for a note not yet in the metadata
    // cache, `type` isn't readable when file-open fires, so the button would
    // stay hidden forever without this.
    this.plugin.registerEvent(this.app.metadataCache.on("changed", refresh));
    this.plugin.registerEvent(this.app.metadataCache.on("resolved", refresh));
    this.app.workspace.onLayoutReady(refresh);

    void this.migrateFromStandalone();
  }

  // ---- defer to the standalone plugin ------------------------------------

  // While the standalone "AI Commands" plugin is enabled, it owns the header
  // button (both plugins stay enabled together because plugin enablement
  // lives in community-plugins.json, which syncs to devices where Hyo can't
  // load). Re-evaluated on every refresh, so toggling the standalone plugin
  // mid-session settles without a restart.
  private standaloneActive(): boolean {
    try {
      const enabled = (this.app as any).plugins?.enabledPlugins;
      return !!enabled && enabled.has(STANDALONE_PLUGIN_ID);
    } catch {
      return false;
    }
  }

  // ---- header button ------------------------------------------------------

  // Refresh every open markdown pane, not just the active one — so a split
  // view and the note just configured in settings both update.
  refreshButtons(): void {
    this.app.workspace.getLeavesOfType("markdown").forEach((leaf) => {
      const view = leaf.view;
      if (view instanceof MarkdownView) this.refreshView(view);
    });
  }

  private refreshView(view: MarkdownView): void {
    // Add the action once per view; reuse it afterwards.
    const v = view as any;
    if (!v.__hyoCommandsEl) {
      v.__hyoCommandsEl = view.addAction(ICON, "Hyo commands", (evt: MouseEvent) =>
        this.showMenu(evt, view)
      );
    }
    const hide = this.standaloneActive() || this.commandsForFile(view.file).length === 0;
    v.__hyoCommandsEl.style.display = hide ? "none" : "";
  }

  private commandsForFile(file: TFile | null): HyoCommand[] {
    if (!file) return [];
    const cache = this.app.metadataCache.getFileCache(file);
    const type = cache?.frontmatter?.type;
    if (typeof type !== "string" || !type.trim()) return [];
    return this.plugin.settings.commands[type] || [];
  }

  private showMenu(evt: MouseEvent, view: MarkdownView): void {
    const cmds = this.commandsForFile(view.file);
    if (!cmds.length) {
      new Notice("No Hyo commands for this note type");
      return;
    }
    const menu = new Menu();
    for (const cmd of cmds) {
      menu.addItem((item) =>
        item
          .setTitle(cmd.label || cmd.skill)
          .setIcon(ICON)
          .onClick(() => this.fire(cmd, view.file))
      );
    }
    menu.showAtMouseEvent(evt);
  }

  // ---- firing ---------------------------------------------------------

  async fire(cmd: HyoCommand, file: TFile | null): Promise<void> {
    if (!cmd.skill) {
      new Notice("This command has no skill set");
      return;
    }
    let prompt = "/" + cmd.skill;
    if (cmd.extra && cmd.extra.trim()) prompt += " " + cmd.extra.trim();

    // Desktop Hyo resolves the note against its own working directory, so it
    // needs an absolute path — the vault file may itself be a symlink into
    // another vault (e.g. EV-HQ), and a relative path won't resolve through
    // that. Mobile routes through the gateway host, which spawns Claude with
    // cwd set to the vault root, so a vault-relative path resolves there —
    // and mobile has no filesystem access to build an absolute one anyway.
    let notePath: string | undefined;
    if (file) {
      notePath = Platform.isMobile
        ? file.path
        : path.join((this.app.vault.adapter as any).basePath, file.path);
    }

    await this.plugin.runFromSeam(prompt, notePath);
    new Notice(`Sent to Hyo: ${cmd.label || cmd.skill}`);
  }

  // ---- note-type discovery (distinct `type` frontmatter in the vault) ---

  getNoteTypes(): string[] {
    const types = new Set<string>();
    for (const file of this.app.vault.getMarkdownFiles()) {
      const cache = this.app.metadataCache.getFileCache(file);
      const t = cache?.frontmatter?.type;
      if (typeof t === "string" && t.trim()) types.add(t.trim());
    }
    return Array.from(types).sort();
  }

  // ---- skill discovery ----------------------------------------------------

  // Synchronous equivalent of the useSkills() hook (same three folders, same
  // frontmatter parse) for use outside React — the settings panel's command
  // builder and the header menu. Also folds in the CLI's bundled skills
  // (deep-research, dataviz, loop, schedule) so the dropdowns match what
  // typing "/" in chat already offers.
  getSkills(): Skill[] {
    if (Platform.isMobile || !fs) return [];
    const vaultPath = (this.app.vault.adapter as any).basePath as string;
    const workingDirectory = this.plugin.settings.workingDirectory
      ? this.plugin.settings.workingDirectory.replace(/^~/, os.homedir())
      : vaultPath;

    // Same folders the "/" picker uses, for whichever engine is running.
    const engineHome =
      this.plugin.settings.engine === "codex" ? ".codex" : ".claude";
    const bases = [
      path.join(os.homedir(), engineHome, "skills"),
      path.join(workingDirectory, engineHome, "skills"),
      path.join(workingDirectory, "skills"),
    ];

    const loaded: Skill[] = [];
    for (const base of bases) {
      let entries;
      try {
        if (!fs.existsSync(base)) continue;
        entries = fs.readdirSync(base, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const d of entries) {
        if (!d.isDirectory()) continue;
        const skillFile = path.join(base, d.name, "SKILL.md");
        if (!fs.existsSync(skillFile)) continue;
        let name = d.name;
        let description = "";
        try {
          const txt = fs.readFileSync(skillFile, "utf8");
          const m = txt.match(/^---\n([\s\S]*?)\n---/);
          if (m) {
            const nm = m[1].match(/^name:\s*(.+)$/m);
            if (nm) name = nm[1].trim();
            const dm = m[1].match(/^description:\s*(.+)$/m);
            if (dm) description = dm[1].trim();
          }
        } catch {
          /* keep dir name */
        }
        if (loaded.find((s) => s.name === name)) continue;
        loaded.push({ name, description, content: "" });
      }
    }
    loaded.sort((a, b) => a.name.localeCompare(b.name));
    return withBundledSkills(loaded);
  }

  // ---- migration from the standalone plugin's data.json ------------------

  private async migrateFromStandalone(): Promise<void> {
    if (this.plugin.settings.commandsMigrated) return;
    // Nothing to migrate from without filesystem access, and this only ever
    // needs to happen once from whichever desktop already ran the standalone
    // plugin — mark it done so mobile doesn't retry every load.
    if (Platform.isMobile || !fs) {
      this.plugin.settings.commandsMigrated = true;
      await this.plugin.saveSettings();
      return;
    }
    try {
      const standalone = (this.app as any).plugins?.plugins?.[STANDALONE_PLUGIN_ID];
      const dir: string | undefined = standalone?.manifest?.dir;
      const vaultBase = (this.app.vault.adapter as any).basePath as string;
      const dataPath = dir
        ? path.join(vaultBase, dir, "data.json")
        : path.join(vaultBase, ".obsidian", "plugins", STANDALONE_PLUGIN_ID, "data.json");

      if (fs.existsSync(dataPath)) {
        const parsed = JSON.parse(fs.readFileSync(dataPath, "utf8"));
        const commands = parsed?.commands;
        let migratedTypes = 0;
        if (commands && typeof commands === "object") {
          for (const [type, cmds] of Object.entries(commands)) {
            if (Array.isArray(cmds) && !this.plugin.settings.commands[type]) {
              this.plugin.settings.commands[type] = cmds as HyoCommand[];
              migratedTypes++;
            }
          }
        }
        if (migratedTypes > 0) {
          new Notice(
            `Hyo: imported commands for ${migratedTypes} note type${migratedTypes === 1 ? "" : "s"} from AI Commands`
          );
        }
      }
    } catch (e) {
      console.error("[hyo] Command migration from AI Commands failed:", e);
    }
    this.plugin.settings.commandsMigrated = true;
    await this.plugin.saveSettings();
  }
}
