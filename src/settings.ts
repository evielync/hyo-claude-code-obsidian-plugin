import {
  App,
  ButtonComponent,
  FuzzySuggestModal,
  Modal,
  Notice,
  PluginSettingTab,
  Setting,
  Platform,
  TFile,
  requireApiVersion,
  type SettingDefinitionItem,
} from "obsidian";
import { FallbackRenderer, arrangeTab, controlRows, toDefinitions, type ControlRow, type Layout, type Page, type Row } from "./settings-layout";
import { commandsPage } from "./settings-commands";
import { voicePage } from "./settings-voice";
import { MAIN_CHAT_AVAILABLE } from "./main-chat";
// Node built-ins and Electron are desktop-only, loaded where they're used.
import { electron, nodeFs, nodeOs, nodePath, type ElectronApi } from "./platform/node";
import { vaultBasePath } from "./obsidian-internals";
import { errorMessage } from "./types/json";
import type HyoPlugin from "./main";
import { CUSTOM_VOICE_PREFIX, resolveLiveVoice, type CustomLiveVoice } from "./voice/live-voice";
export { CUSTOM_VOICE_PREFIX, resolveLiveVoice, type CustomLiveVoice };
import { MODEL_OPTIONS, EFFORT_OPTIONS, DEFAULT_EFFORT } from "./models";
import { checkMobileAccess, mobileLogPath } from "./gateway-host";
import { detectClaude, checkClaude, installClaude, signIn, type ClaudeStatus } from "./cli-probe";
import type { DictationProvider } from "./voice/dictation";

// A single command: which skill it fires, what its header-menu label reads,
// and any extra instruction text appended after the skill invocation.
export interface HyoCommand {
  skill: string;
  label: string;
  extra?: string;
}

// OpenAI's built-in voices for GPT-Live-1 (from the SDK's BuiltInVoice type).
export const GPT_LIVE_VOICES = [
  "marin", "cedar", "alloy", "ash", "ballad", "beacon", "bossa", "cinder",
  "coral", "delta", "echo", "gleam", "meridian", "quartz", "ripple", "sage",
  "shimmer", "stone", "tempo", "verse", "vesper", "willow",
];

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
  // Off: each run of tool calls folds into one summary line (like Claude
  // Desktop's Normal view). On: one row per tool call.
  showAllToolCalls: boolean;
  // Mobile: the gateway URL the phone connects to (also what desktop hosts
  // when "enable mobile access" is on), and the permission default sent with
  // every mobile prompt.
  gatewayUrl: string;
  askFirst: boolean;
  // Synced, so it no longer decides anything: each Mac's "This computer is
  // the gateway" switch lives in local storage and was seeded from this once.
  enableMobileAccess: boolean;
  // The local port this vault's gateway listens on. Per-vault so more than one
  // vault can host mobile access at once without colliding, and so a user whose
  // 8787 is already taken can move it.
  gatewayPort: number;
  // Last version whose release card was seen. Empty on a fresh install, which
  // suppresses the card — a first-time user doesn't need to be told what
  // changed in a version they never had.
  lastSeenVersion: string;
  // Voice. A call is OpenAI's GPT-Live-1 voice model, which hands real work
  // to Claude. Dictation (the phone's mic button) is transcribed by the
  // service chosen here, with its key.
  dictationProvider: DictationProvider;
  elevenLabsApiKey: string;
  openAiApiKey: string;
  gptLiveVoice: string;
  gptLiveCustomVoices: CustomLiveVoice[];
  /** "About you" for the voice: name, what they do, how they like to be spoken to. */
  voiceAboutYou: string;
  /** A vault note to use as "About you" instead, read fresh at each call. Empty = the text above. */
  voiceAboutYouNote: string;
  // Who the voice is and how it talks — the only part of the voice's prompt
  // the user writes. Hyo adds the fixed policies underneath.
  voicePersonality: string;
  // Diagnostics for live calls (no UI; set in data.json): event log to
  // ~/Dropbox/chad/hyo-live.log and stored sessions at OpenAI.
  voiceDebugLog: boolean;
  // Task mode — per-conversation metadata, keyed by cliSessionId. Everything
  // else about a task (its state) is derived live; only these few things need
  // to persist across reloads. See hyo-task-mode-build-spec.
  tasks: Record<string, TaskMeta>;
  // Main chat: a pinned first tab holding one long conversation with your
  // agent that hands work to background agents and never blocks. Off by
  // default. The conversation's id is kept here (synced) so the phone opens
  // the same one.
  mainChat: boolean;
  mainChatSessionId: string;
  // The dock (dock.ts): a strip on the edge of the Obsidian window showing
  // the open conversations; click one to carry it on in a pop-up. Desktop
  // only, off by default.
  dock: boolean;
  dockSide: "right" | "left";
  dockCollapsed: boolean;
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
  model: "claude-sonnet-5-5",
  effortLevel: DEFAULT_EFFORT,
  customModels: [],
  permissionMode: "manual",
  workingDirectory: "",
  defaultAgent: "",
  maxOutputTokens: 64000,
  autoGenerateTitles: true,
  showAllToolCalls: false,
  gatewayUrl: "",
  askFirst: true,
  enableMobileAccess: false,
  gatewayPort: 8787,
  lastSeenVersion: "",
  // Voice
  dictationProvider: "openai",
  elevenLabsApiKey: "",
  openAiApiKey: "",
  gptLiveVoice: "marin",
  gptLiveCustomVoices: [],
  voiceAboutYou: "",
  voiceAboutYouNote: "",
  voicePersonality: "",
  voiceDebugLog: false,
  mainChat: false,
  mainChatSessionId: "",
  dock: false,
  dockSide: "right",
  dockCollapsed: false,
  tasks: {},
  commands: {},
  commandsMigrated: false,
};

export function dispatchSettingsChanged(): void {
  window.dispatchEvent(new CustomEvent("hyo-settings-changed"));
}

/**
 * Electron's file dialog, where this Obsidian still exposes it (`remote` went
 * away in later Electron versions). Undefined means Browse can't open a
 * dialog here and the path has to be typed in.
 */
function fileDialog(): NonNullable<ElectronApi["remote"]>["dialog"] | undefined {
  return electron().remote?.dialog;
}

const NO_FILE_DIALOG = "This version of Obsidian can't open a file browser here. Type the path into the box instead.";

// The colour a status line shows in, as a class (see styles.css).
type StatusKind = "ok" | "warn" | "bad" | "muted";
const STATUS_CLASSES: Record<StatusKind, string> = {
  ok: "is-ok",
  warn: "is-warn",
  bad: "is-bad",
  muted: "is-muted",
};

function setStatusKind(el: HTMLElement, kind: StatusKind): void {
  el.addClass("hyo-status-text");
  for (const [k, cls] of Object.entries(STATUS_CLASSES)) el.toggleClass(cls, k === kind);
}

const DOCS_URL = "https://docs.gethyo.co";
const USER_GUIDE_URL = "https://www.loom.com/share/349eaac59e514142bc47b10469287db0";
const MOBILE_GUIDE_URL = "https://docs.gethyo.co/mobile/setup/";

function openUrl(url: string): void {
  window.open(url, "_blank", "noopener");
}

/** A description with a link at the end. */
function descWithLink(text: string, linkText: string, href: string): () => DocumentFragment {
  return () => {
    const frag = createFragment();
    frag.append(text);
    frag.createEl("a", { text: linkText, href, attr: { target: "_blank", rel: "noopener" } });
    return frag;
  };
}

/** Agents in ~/.claude/agents (desktop only): the choices for Default agent. */
function listAgents(): string[] {
  if (Platform.isMobile) return [];
  try {
    const fs = nodeFs();
    const agentDir = nodePath().join(nodeOs().homedir(), ".claude", "agents");
    if (!fs.existsSync(agentDir)) return [];
    return fs
      .readdirSync(agentDir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => f.replace(/\.md$/, "").toLowerCase())
      .sort();
  } catch {
    // An unreadable agents folder just means there's no agent to offer.
    return [];
  }
}

/**
 * Settings → Hyo. Every row is described once, in `layout()`
 * (settings-layout.ts): Obsidian 1.13+ draws it from getSettingDefinitions()
 * and finds every row in its settings search; older versions get the same
 * rows from display().
 */
export class HyoSettingTab extends PluginSettingTab {
  plugin: HyoPlugin;
  private controls = new Map<string, ControlRow>();
  private fallback: FallbackRenderer;
  /**
   * Setup's check of Claude Code, run once per visit to the tab (it starts
   * Claude twice, so not on every redraw) and again after Auto-detect,
   * Install or Sign in.
   */
  private claudeCheck: { path: string; status: Promise<ClaudeStatus> } | null = null;
  /**
   * The note types open on the Commands page. Kept on the tab, not the page,
   * so a type stays open through the redraws that follow each edit.
   */
  private expandedNoteTypes = new Set<string>();

  constructor(app: App, plugin: HyoPlugin) {
    super(app, plugin);
    this.plugin = plugin;
    this.fallback = new FallbackRenderer({
      change: (row, value) => this.applyControl(row, value),
      saved: (setting) => this.showSavedNear(setting.nameEl),
      redraw: () => this.drawFallback(),
    });
  }

  /** Obsidian draws the tab from these on 1.13+. Older versions never call it. */
  getSettingDefinitions(): SettingDefinitionItem[] {
    return toDefinitions(this.buildLayout());
  }

  getControlValue(key: string): unknown {
    return this.controls.get(key)?.binding.get();
  }

  async setControlValue(key: string, value: unknown): Promise<void> {
    const row = this.controls.get(key);
    if (row) await this.applyControl(row, value);
  }

  /** Obsidian before 1.13 calls this to draw the tab; 1.13+ uses getSettingDefinitions. */
  display(): void {
    this.drawFallback();
  }

  hide(): void {
    super.hide();
    this.claudeCheck = null;
  }

  /** The tab as drawn for Obsidian before 1.13. */
  private drawFallback(): void {
    this.fallback.render(this.containerEl, this.buildLayout());
  }

  private buildLayout(): Layout {
    const layout = this.layout();
    this.controls = controlRows(layout);
    return layout;
  }

  /** Save a control's new value, checked against what the control holds. */
  private async applyControl(row: ControlRow, value: unknown): Promise<boolean> {
    const b = row.binding;
    switch (b.type) {
      case "toggle":
        if (typeof value !== "boolean") return false;
        b.set(value);
        break;
      case "dropdown":
      case "text":
      case "textarea":
        if (typeof value !== "string") return false;
        b.set(value);
        break;
      case "number":
        if (typeof value !== "number" || !Number.isFinite(value) || value < b.min) return false;
        b.set(Math.round(value));
        break;
    }
    await this.plugin.saveSettings();
    row.after?.();
    return true;
  }

  /** The rows themselves changed (one added or removed): draw them again. */
  private rebuild(): void {
    if (requireApiVersion("1.13.0")) this.update();
    else this.drawFallback();
  }

  /** A value other rows' visibility depends on changed. */
  private refreshVisibility(): void {
    if (requireApiVersion("1.13.0")) this.refreshDomState();
    else this.drawFallback();
  }

  private showSavedNear(nameEl: HTMLElement): void {
    const existing = nameEl.querySelector(".hyo-setting-saved");
    if (existing) existing.remove();
    const badge = nameEl.createSpan({
      cls: "hyo-setting-saved",
      text: "✓ Saved",
    });
    window.setTimeout(() => badge.addClass("is-fading"), 1200);
    window.setTimeout(() => badge.remove(), 1800);
  }

  private save(nameEl: HTMLElement): void {
    this.plugin
      .saveSettings()
      .then(() => this.showSavedNear(nameEl))
      .catch((e: unknown) => console.error("[hyo] Couldn't save settings:", e));
  }

  // ---- The layout -------------------------------------------------------------

  private layout(): Layout {
    return arrangeTab(
      {
        documentation: () => [
          {
            kind: "custom",
            name: "Documentation",
            desc: "How every part of Hyo works, and a video walk-through.",
            aliases: ["help", "docs", "guide"],
            build: (s) => {
              s.addButton((b) => b.setButtonText("Read the docs").onClick(() => openUrl(DOCS_URL)));
              s.addButton((b) => b.setButtonText("Watch the user guide").onClick(() => openUrl(USER_GUIDE_URL)));
            },
          },
        ],
        setup: () => this.setupRows(),
        general: () => this.generalRows(),
        customModels: () => this.customModelRows(),
        voice: () => this.voicePage(),
        mobile: () => this.mobilePage(),
        commands: () =>
          commandsPage({
            app: () => this.app,
            commands: () => this.plugin.settings.commands,
            noteTypes: () => this.plugin.commands.getNoteTypes(),
            skills: () => this.plugin.commands.getSkills(),
            skillMissing: (skill, skills) => this.plugin.commands.skillMissing(skill, skills),
            save: () => this.plugin.saveSettings(),
            rebuild: () => this.rebuild(),
            refreshVisibility: () => this.refreshVisibility(),
            isExpanded: (type) => this.expandedNoteTypes.has(type),
            setExpanded: (type, open) => {
              if (open) this.expandedNoteTypes.add(type);
              else this.expandedNoteTypes.delete(type);
            },
            confirm: (message, onConfirm) => new ConfirmRemoveModal(this.app, message, onConfirm).open(),
            openUrl,
          }),
        advanced: () => this.advancedPage(),
      },
      Platform.isMobile
    );
  }

  // ---- General: everyday defaults for new conversations ---------------------
  private generalRows(): Row[] {
    const s = this.plugin.settings;
    const settings = () => this.plugin.settings;

    // Built-in models, then any added from the picker's custom field. If the
    // saved default is in neither (an older model kept from a previous
    // version), it's offered too, so the dropdown shows what's really set.
    const modelOptions: Record<string, string> = {};
    for (const m of MODEL_OPTIONS) modelOptions[m.id] = `${m.name} (${m.context})`;
    for (const id of s.customModels) modelOptions[id] = id;
    if (s.model && !(s.model in modelOptions)) modelOptions[s.model] = s.model;

    const effortOptions: Record<string, string> = {};
    for (const e of EFFORT_OPTIONS) effortOptions[e.id] = e.name;

    const agents = listAgents();
    const agentOptions: Record<string, string> = { "": "Default (no agent)" };
    for (const a of agents) agentOptions[a] = a;

    const rows: Row[] = [
      {
        kind: "control",
        key: "model",
        name: "Model",
        desc: "Default model for new conversations",
        binding: { type: "dropdown", options: modelOptions, get: () => settings().model, set: (v) => (settings().model = v) },
      },
      {
        kind: "control",
        key: "effortLevel",
        name: "Effort",
        desc: "Default reasoning effort for new conversations. Higher effort means more thorough responses, but they take longer and use your limits faster.",
        binding: {
          type: "dropdown",
          options: effortOptions,
          get: () => settings().effortLevel || DEFAULT_EFFORT,
          set: (v) => (settings().effortLevel = v),
        },
      },
      {
        kind: "control",
        key: "permissionMode",
        name: "Permission mode",
        desc: "What Claude may do without asking you first. 'Default' asks before every action; 'Accept edits' lets it change files freely; 'Bypass all' never asks; 'Plan mode' makes it propose a plan before doing anything.",
        binding: {
          type: "dropdown",
          options: {
            manual: "Default (ask for each)",
            acceptEdits: "Accept edits",
            bypassPermissions: "Bypass all",
            plan: "Plan mode",
          },
          get: () => settings().permissionMode,
          set: (v) => (settings().permissionMode = v),
        },
      },
      {
        kind: "control",
        key: "autoGenerateTitles",
        name: "Auto-generate conversation titles",
        desc: "Uses a small Claude Haiku call after your first message to name the conversation. Uses your Claude subscription.",
        binding: { type: "toggle", get: () => settings().autoGenerateTitles, set: (v) => (settings().autoGenerateTitles = v) },
      },
    ];
    // Main chat isn't in this release (see MAIN_CHAT_AVAILABLE).
    if (MAIN_CHAT_AVAILABLE) {
      rows.push({
        kind: "control",
        key: "mainChat",
        name: "Main chat",
        desc: "One ongoing conversation with your agent, always there as the first tab. Ask for something and it hands the work to a background helper and answers straight away, so you can keep asking for more. Each result comes back into the chat when it's done. Your other tabs work as they do now.",
        binding: { type: "toggle", get: () => !!settings().mainChat, set: (v) => (settings().mainChat = v) },
      });
    }
    // The dock: desktop only (the phone has no room for it).
    if (!Platform.isMobile) {
      rows.push(
        {
          kind: "control",
          key: "dock",
          name: "Dock",
          desc: "A strip on the edge of the Obsidian window showing your open conversations, whatever you have open in the sidebar. A green dot means it's working, a peach dot means it needs you. Click one to carry on the conversation in a pop-up over your note.",
          binding: { type: "toggle", get: () => !!settings().dock, set: (v) => (settings().dock = v) },
          after: () => this.refreshVisibility(),
        },
        {
          kind: "control",
          key: "dockSide",
          name: "Dock side",
          desc: "Which edge of the window the dock sits on.",
          visible: () => !!settings().dock,
          binding: {
            type: "dropdown",
            options: { right: "Right", left: "Left" },
            get: () => settings().dockSide || "right",
            set: (v) => (settings().dockSide = v === "left" ? "left" : "right"),
          },
        }
      );
    }
    rows.push(
      {
        kind: "control",
        key: "showAllToolCalls",
        name: "Show every tool call",
        desc: 'Off: the steps your agent takes (reading files, running commands, searching) fold into one line per step, like "Read 3 files, ran 2 commands". Click the line to see them. On: every tool call gets its own row.',
        binding: { type: "toggle", get: () => settings().showAllToolCalls, set: (v) => (settings().showAllToolCalls = v) },
      },
      // Desktop only (it reads ~/.claude/agents), and only when there's an
      // agent to pick. On the phone the agent is picked per conversation.
      {
        kind: "control",
        key: "defaultAgent",
        name: "Default agent",
        desc: "Which agent to use when starting new conversations",
        visible: () => agents.length > 0,
        binding: {
          type: "dropdown",
          options: agentOptions,
          get: () => settings().defaultAgent || "",
          set: (v) => (settings().defaultAgent = v),
        },
      }
    );
    return rows;
  }

  // Custom models: added from the picker's "Custom model ID" field, removed
  // here, just below the Model default they feed.
  private customModelRows(): Row[] {
    return this.plugin.settings.customModels.map((id) => ({
      kind: "custom",
      name: id,
      desc: "Added from the model picker. Remove it here if you no longer want it.",
      build: (setting: Setting) => {
        setting.addExtraButton((btn) =>
          btn
            .setIcon("trash")
            .setTooltip("Remove")
            .onClick(async () => {
              const st = this.plugin.settings;
              st.customModels = st.customModels.filter((m) => m !== id);
              // A removed default falls back to the first built-in, so
              // nothing points at a now-absent entry.
              if (st.model === id) st.model = MODEL_OPTIONS[0].id;
              await this.plugin.saveSettings();
              this.rebuild();
            })
        );
      },
    }));
  }

  // ---- Voice ----------------------------------------------------------------
  private voicePage(): Page {
    return voicePage({
      settings: () => this.plugin.settings,
      keyInput: (setting, placeholder, get, set) => this.buildKeyInput(setting, placeholder, get, set),
      voicePicker: (setting) => this.buildVoicePicker(setting),
      customVoiceAdder: (setting) => this.buildCustomVoiceAdder(setting),
      removeCustomVoice: async (id) => {
        const st = this.plugin.settings;
        st.gptLiveCustomVoices = (st.gptLiveCustomVoices || []).filter((v) => v.id !== id);
        if (st.gptLiveVoice === `${CUSTOM_VOICE_PREFIX}${id}`) st.gptLiveVoice = "marin";
        await this.plugin.saveSettings();
        this.rebuild();
      },
      aboutYou: (setting) => this.buildAboutYou(setting),
      stackedTextArea: (setting, o) => this.buildStackedTextArea(setting, o),
      refreshVisibility: () => this.refreshVisibility(),
    });
  }

  /** A password box for an API key, trimmed and saved as it's typed. */
  private buildKeyInput(setting: Setting, placeholder: string, get: () => string, set: (v: string) => void): void {
    setting.addText((text) => {
      text.inputEl.type = "password";
      text.inputEl.addClass("hyo-input-key");
      text
        .setPlaceholder(placeholder)
        .setValue(get())
        .onChange((value) => {
          set(value.trim());
          this.save(setting.nameEl);
        });
    });
  }

  private buildVoicePicker(setting: Setting): void {
    setting.addDropdown((dropdown) => {
      for (const c of this.plugin.settings.gptLiveCustomVoices || []) {
        dropdown.addOption(`${CUSTOM_VOICE_PREFIX}${c.id}`, `${c.name || "Custom voice"} (custom)`);
      }
      for (const v of GPT_LIVE_VOICES) {
        dropdown.addOption(v, v.charAt(0).toUpperCase() + v.slice(1));
      }
      dropdown.setValue(this.plugin.settings.gptLiveVoice || "marin").onChange((value) => {
        this.plugin.settings.gptLiveVoice = value;
        this.save(setting.nameEl);
      });
    });
    setting.addButton((btn) => {
      btn.setButtonText("Play sample").onClick(async () => {
        const key = this.plugin.settings.openAiApiKey;
        if (!key) {
          new Notice("Add your OpenAI API key first.");
          return;
        }
        btn.setDisabled(true).setButtonText("Playing…");
        try {
          const { playVoiceSample } = await import("./voice/gpt-live");
          const { voice } = resolveLiveVoice(this.plugin.settings.gptLiveVoice, this.plugin.settings.gptLiveCustomVoices);
          await playVoiceSample(key, voice);
        } catch (e) {
          new Notice(`Couldn't play the sample — ${e instanceof Error ? e.message : "error"}`);
        } finally {
          btn.setDisabled(false).setButtonText("Play sample");
        }
      });
    });
  }

  // Custom voices: an id from OpenAI's custom voices, with the description it
  // was made from (OpenAI's guide: keep that description in the call's
  // instructions so the voice stays in character).
  private buildCustomVoiceAdder(setting: Setting): void {
    const draft = { name: "", id: "", description: "" };
    setting.settingEl.addClass("hyo-setting-stacked");
    setting
      .addText((t) => t.setPlaceholder("Name, e.g. Chad").onChange((v) => (draft.name = v.trim())))
      .addText((t) => t.setPlaceholder("voice_…").onChange((v) => (draft.id = v.trim())))
      .addButton((btn) =>
        btn.setButtonText("Add").onClick(async () => {
          if (!/^voice_[A-Za-z0-9]+$/.test(draft.id)) {
            new Notice("That doesn't look like a voice id. It starts with voice_.");
            return;
          }
          const s = this.plugin.settings;
          const list = (s.gptLiveCustomVoices || []).filter((v) => v.id !== draft.id);
          list.push({ id: draft.id, name: draft.name || "Custom voice", description: draft.description.trim() });
          s.gptLiveCustomVoices = list;
          s.gptLiveVoice = `${CUSTOM_VOICE_PREFIX}${draft.id}`;
          await this.plugin.saveSettings();
          this.rebuild();
        })
      );
    const descArea = setting.settingEl.createEl("textarea", {
      attr: { rows: "3", placeholder: "The voice's description, e.g. A natural, relaxed British man in his forties…" },
    });
    descArea.addClass("hyo-textarea-full");
    descArea.addEventListener("input", () => (draft.description = descArea.value));
  }

  private buildAboutYou(setting: Setting): void {
    const note = this.plugin.settings.voiceAboutYouNote || "";
    setting.addButton((btn) =>
      btn.setButtonText(note ? "Change note" : "Use a note").onClick(() => {
        new NotePickerModal(this.app, async (notePath) => {
          this.plugin.settings.voiceAboutYouNote = notePath;
          await this.plugin.saveSettings();
          this.rebuild();
        }).open();
      })
    );
    if (note) {
      setting.addButton((btn) =>
        btn.setButtonText("Write it here instead").onClick(async () => {
          this.plugin.settings.voiceAboutYouNote = "";
          await this.plugin.saveSettings();
          this.rebuild();
        })
      );
      return;
    }
    this.buildStackedTextArea(setting, {
      placeholder: "I'm Sam. I run a small design studio. Keep it brief and skip the pleasantries.",
      get: () => this.plugin.settings.voiceAboutYou || "",
      set: (v) => (this.plugin.settings.voiceAboutYou = v),
    });
  }

  /**
   * A full-width box under the row's name and description, saved as it's
   * typed. About you and Personality share it, so the two boxes match.
   */
  private buildStackedTextArea(setting: Setting, o: { placeholder: string; get: () => string; set: (v: string) => void }): void {
    setting.settingEl.addClass("hyo-setting-stacked");
    const area = setting.settingEl.createEl("textarea", { attr: { rows: "4", placeholder: o.placeholder } });
    area.addClass("hyo-textarea-full");
    area.value = o.get();
    area.addEventListener("input", () => {
      o.set(area.value);
      this.save(setting.nameEl);
    });
  }

  // ---- Advanced: paths and caps ----------------------------------------------
  private advancedPage(): Page {
    const settings = () => this.plugin.settings;
    return {
      kind: "page",
      id: "advanced",
      name: "Advanced",
      desc: "Claude's working folder and the cap on response length. Rarely needed.",
      sections: [
        {
          items: [
            {
              kind: "custom",
              name: "Working directory",
              desc: "Claude's home folder — where it looks for your CLAUDE.md and starts working from. Defaults to your current Obsidian vault. Set this to a different folder if your Claude project lives outside your vault.",
              build: (setting) =>
                this.buildPathInput(setting, {
                  placeholder: "Leave blank for current vault",
                  get: () => settings().workingDirectory,
                  set: (v) => (settings().workingDirectory = v),
                  browse: "openDirectory",
                  browseFrom: () => settings().workingDirectory || nodeOs().homedir(),
                  label: "Browse...",
                }),
            },
            {
              kind: "control",
              key: "maxOutputTokens",
              name: "Max output tokens",
              desc: "Cap on response length per turn. Default 64000 works for Sonnet. Lower to 32000 if using Opus models.",
              binding: {
                type: "number",
                placeholder: "64000",
                min: 1024,
                get: () => settings().maxOutputTokens,
                set: (v) => (settings().maxOutputTokens = v),
              },
            },
          ],
        },
      ],
    };
  }

  /** A path typed in, or picked with Electron's file dialog where Obsidian still has it. */
  private buildPathInput(
    setting: Setting,
    o: {
      placeholder: string;
      get: () => string;
      set: (v: string) => void;
      browse: "openDirectory" | "openFile";
      browseFrom: () => string;
      label: string;
    }
  ): void {
    setting.addText((text) =>
      text
        .setPlaceholder(o.placeholder)
        .setValue(o.get())
        .onChange((value) => {
          o.set(value);
          this.save(setting.nameEl);
        })
    );
    setting.addButton((button) =>
      button.setButtonText(o.label).onClick(async () => {
        const dialog = fileDialog();
        if (!dialog) {
          new Notice(NO_FILE_DIALOG);
          return;
        }
        const result = await dialog.showOpenDialog({ properties: [o.browse], defaultPath: o.browseFrom() });
        if (!result.canceled && result.filePaths.length > 0) {
          o.set(result.filePaths[0]);
          await this.plugin.saveSettings();
          this.rebuild();
        }
      })
    );
  }

  // ---- Setup: get Claude installed, signed in, and connected ------------------
  // The one place a person goes to get running. Everything here works by
  // actually running Claude — never by guessing from a file on disk — and does
  // its work headlessly: no terminal window ever shows, only a browser tab for
  // approving sign-in.
  private setupRows(): Row[] {
    const settings = () => this.plugin.settings;
    return [
      {
        kind: "custom",
        name: "Claude Code",
        desc: "Hyo runs on Claude Code. This shows whether it's installed, working and signed in on this computer, and sets it up for you if not.",
        aliases: ["install", "sign in", "auto-detect"],
        build: (setting) => this.buildClaudeStatus(setting),
      },
      {
        kind: "custom",
        name: "Install Claude Code",
        desc: "Not installed yet? Hyo installs it for you in the background.",
        build: (setting) => {
          setting.addButton((b) =>
            b.setButtonText("Install Claude").onClick(async () => {
              b.setDisabled(true);
              const notice = new Notice("Installing Claude…", 0);
              const r = await installClaude((msg) => notice.setMessage(msg));
              notice.hide();
              b.setDisabled(false);
              if (r.ok) {
                const found = detectClaude();
                if (found.path) {
                  settings().cliPath = found.path;
                  await this.plugin.saveSettings();
                }
                new Notice("✓ Claude installed. Now sign in.");
              } else {
                new Notice(`Install didn't finish: ${r.error}`);
              }
              this.claudeCheck = null;
              this.rebuild();
            })
          );
        },
      },
      {
        kind: "custom",
        name: "Sign in to Claude",
        desc: "Opens your browser to approve. No terminal, nothing to copy.",
        build: (setting) => {
          setting.addButton((b) =>
            b.setButtonText("Sign in to Claude").onClick(async () => {
              const p = settings().cliPath;
              if (!p) {
                new Notice("Install or auto-detect Claude first.");
                return;
              }
              b.setDisabled(true);
              const notice = new Notice("Starting sign-in…", 0);
              const r = await signIn(p, (msg) => notice.setMessage(msg));
              notice.hide();
              b.setDisabled(false);
              new Notice(r.ok ? "✓ Signed in." : `Sign-in didn't finish: ${r.error}`);
              this.claudeCheck = null;
              this.rebuild();
            })
          );
        },
      },
      {
        kind: "custom",
        name: "Claude Code path",
        desc: "Set automatically by Auto-detect. Only change this if you know you need a specific install.",
        aliases: ["cli path"],
        build: (setting) =>
          this.buildPathInput(setting, {
            placeholder: "/usr/local/bin/claude",
            get: () => settings().cliPath,
            set: (v) => (settings().cliPath = v),
            browse: "openFile",
            browseFrom: () => nodePath().dirname(settings().cliPath || "/usr/local/bin"),
            label: "Browse…",
          }),
      },
    ];
  }

  private buildClaudeStatus(setting: Setting): void {
    const statusEl = setting.descEl.createDiv({ cls: "hyo-setup-status" });
    const setStatus = (kind: StatusKind, detail: string) => {
      statusEl.setText(detail);
      setStatusKind(statusEl, kind);
    };

    // Reflect reality: run Claude, check sign-in. No file-existence guess.
    // It runs in the background, so opening the tab never waits on it.
    const p = this.plugin.settings.cliPath;
    if (!p) {
      setStatus("muted", "Not set up yet — click Auto-detect, or Install Claude below.");
    } else {
      setStatus("muted", "Checking Claude…");
      if (this.claudeCheck?.path !== p) this.claudeCheck = { path: p, status: checkClaude(p) };
      this.claudeCheck.status
        .then(({ probe, auth }) => {
          if (!probe.works) setStatus("bad", "✗ Claude isn't running from the saved path — Auto-detect or Install below.");
          else if (auth.loggedIn === false) setStatus("warn", `✓ Claude ${probe.version} — but not signed in. Sign in below.`);
          else if (auth.loggedIn && auth.email) setStatus("ok", `✓ Ready — Claude ${probe.version}, signed in as ${auth.email}.`);
          else setStatus("ok", `✓ Ready — Claude ${probe.version}.`);
        })
        .catch((e: unknown) => setStatus("bad", `✗ Couldn't check Claude: ${errorMessage(e)}`));
    }

    setting.addButton((b) =>
      b.setButtonText("Auto-detect").onClick(async () => {
        setStatus("muted", "Looking for Claude…");
        this.claudeCheck = null;
        const result = detectClaude();
        if (result.path) {
          this.plugin.settings.cliPath = result.path;
          await this.plugin.saveSettings();
        }
        if (result.state === "ready") {
          const others = result.candidates.filter((c) => c.works).length - 1;
          new Notice(
            `✓ Using Claude ${result.version}` +
              (others > 0 ? ` (${others} other working install${others > 1 ? "s" : ""} found)` : "")
          );
        } else if (result.state === "signed-out") {
          new Notice("Found Claude, but you're not signed in. Click 'Sign in to Claude'.");
        } else {
          new Notice("Couldn't find Claude. Click 'Install Claude' to set it up.");
        }
        this.rebuild();
      })
    );
  }

  // ---- Mobile: gateway hosting (desktop) / gateway address (phone) ------------
  private mobilePage(): Page {
    const settings = () => this.plugin.settings;
    const rows: Row[] = Platform.isMobile
      ? [
          {
            kind: "custom",
            name: "Setup guide",
            desc: descWithLink(
              "Hyo on your phone talks to Claude running on your Mac. Set up your Mac first — this side mostly takes care of itself. ",
              "Read the setup guide →",
              MOBILE_GUIDE_URL
            ),
            build: () => {},
          },
          {
            kind: "control",
            key: "gatewayUrl",
            name: "Gateway address",
            desc: "The address of your Mac. It fills in by itself when this vault syncs from your Mac — only enter it by hand if it hasn't come through. You can copy it from the Mac's Hyo settings, under Mobile.",
            binding: {
              type: "text",
              placeholder: "wss://your-mac.tailXXXX.ts.net/",
              get: () => settings().gatewayUrl,
              set: (v) => (settings().gatewayUrl = v.trim()),
            },
          },
        ]
      : [
          {
            kind: "custom",
            name: "Setup guide",
            desc: () => {
              const frag = createFragment();
              const steps = frag.createEl("ol", { cls: "hyo-settings-steps" });
              steps.createEl("li", {
                text: "Download Tailscale on your desktop and mobile device first (it won't work without Tailscale).",
              });
              steps.createEl("li", {
                text: "Switch on mobile access. You'll need to leave your Obsidian vault open and your computer on for the mobile gateway to work.",
              });
              frag.createEl("a", {
                text: "Read the setup guide to get started →",
                href: MOBILE_GUIDE_URL,
                attr: { target: "_blank", rel: "noopener" },
              });
              return frag;
            },
            aliases: ["tailscale", "phone"],
            build: () => {},
          },
          {
            kind: "control",
            key: "gatewayHost",
            name: "This computer is the gateway",
            desc: "Turn this on for the Mac that stays on and serves your phone. Each computer has its own switch, so turning it on or off here doesn't change your other computers.",
            aliases: ["mobile access"],
            binding: {
              // Stored on this device only (see HyoPlugin.isGatewayHost), so
              // Sync can't flip it on your other Macs.
              type: "toggle",
              get: () => this.plugin.isGatewayHost(),
              set: (v) => {
                this.plugin.setGatewayHost(v);
                if (v) this.plugin.startMobileHost();
                else this.plugin.stopMobileHost();
              },
            },
            // The gateway comes up (or down) asynchronously — draw again once
            // it has had a moment, so the status below tells the truth.
            after: () => window.setTimeout(() => this.rebuild(), 2500),
          },
          {
            kind: "custom",
            name: "Status",
            desc: "Whether the gateway is running, and how many devices are connected.",
            build: (setting) => this.buildGatewayStatus(setting),
          },
          {
            kind: "custom",
            name: "Phone address",
            desc: "The address your phone connects to. It also syncs to your phone automatically.",
            visible: () => this.plugin.gatewayStatus?.state === "on" && !!this.plugin.gatewayStatus.url,
            build: (setting) => {
              const url = this.plugin.gatewayStatus?.url ?? "";
              setting.setDesc(url);
              setting.addButton((b) =>
                b.setButtonText("Copy").onClick(async () => {
                  await navigator.clipboard.writeText(url);
                  new Notice("Address copied. It also syncs to your phone automatically.");
                })
              );
            },
          },
          // Self-check. When mobile access won't come up, this is the answer —
          // it names what was checked, what failed and what to do about it, so
          // nobody has to open a terminal or send a screenshot of a status bar.
          {
            kind: "custom",
            name: "Check mobile access",
            desc: "Tests everything your phone needs and tells you what's wrong.",
            aliases: ["tailscale", "troubleshoot"],
            build: (setting) => this.buildMobileCheck(setting),
          },
          // The gateway port isn't shown: it's internal (Tailscale fronts it)
          // and the host auto-picks a free one. gatewayPort stays in settings
          // only as the starting point for that search.
        ];
    return {
      kind: "page",
      id: "mobile",
      name: "Mobile",
      desc: Platform.isMobile
        ? "Connect this phone to Hyo on your Mac."
        : "Talk to your agent from your phone, through a gateway on this computer.",
      sections: [{ items: rows }],
    };
  }

  // Live status — same truth as the status bar item, shown where you'd look
  // for it.
  private buildGatewayStatus(setting: Setting): void {
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
    setting.setDesc(statusText);
    setStatusKind(setting.descEl, s?.state === "on" ? "ok" : s?.state === "error" ? "bad" : "muted");
  }

  private buildMobileCheck(setting: Setting): void {
    const resultsEl = setting.infoEl.createDiv({ cls: "hyo-mobile-check" });
    setting.addButton((b) =>
      b.setButtonText("Run check").onClick(async () => {
        b.setButtonText("Checking…").setDisabled(true);
        resultsEl.empty();
        try {
          const vault = vaultBasePath(this.app);
          const checks = await checkMobileAccess(vault, this.plugin.settings.gatewayPort);
          for (const c of checks) {
            const row = resultsEl.createDiv({ cls: "hyo-mobile-check-row" });
            const head = row.createDiv({ cls: "hyo-mobile-check-head" });
            head.createSpan({ text: c.ok ? "✓" : "✗", cls: c.ok ? "hyo-check-ok" : "hyo-check-fail" });
            head.createSpan({ text: c.label });
            row.createDiv({ text: c.detail, cls: "hyo-mobile-check-detail" });
            if (c.fix) row.createDiv({ text: c.fix, cls: "hyo-mobile-check-fix" });
          }
          if (checks.some((c) => !c.ok)) {
            const foot = resultsEl.createDiv({ cls: "hyo-mobile-check-detail" });
            foot.setText(`Full log: ${mobileLogPath()}`);
          }
        } catch (e: unknown) {
          resultsEl.createDiv({ text: `Check failed: ${errorMessage(e)}` });
        }
        b.setButtonText("Run check").setDisabled(false);
      })
    );
  }
}

/** Pick a note from the vault (Settings → Voice → About you). */
class NotePickerModal extends FuzzySuggestModal<TFile> {
  constructor(app: App, private onPick: (path: string) => void | Promise<void>) {
    super(app);
    this.setPlaceholder("Pick the note the voice should read about you");
  }
  getItems(): TFile[] {
    return this.app.vault.getMarkdownFiles();
  }
  getItemText(f: TFile): string {
    return f.path.replace(/\.md$/, "");
  }
  onChooseItem(f: TFile): void {
    Promise.resolve(this.onPick(f.path)).catch((e: unknown) => console.error("[hyo] Couldn't use the chosen note:", e));
  }
}

/** Style a button as destructive: `setDestructive` from 1.13, Obsidian's warning class before it. */
function markDestructive(b: ButtonComponent): ButtonComponent {
  if (requireApiVersion("1.13.0")) return b.setDestructive();
  b.buttonEl.addClass("mod-warning");
  return b;
}

// Small yes/no gate before removing something. Cancel is the safe default.
class ConfirmRemoveModal extends Modal {
  constructor(app: App, private message: string, private onConfirm: () => void | Promise<void>) {
    super(app);
  }

  onOpen(): void {
    this.contentEl.createEl("p", { text: this.message });
    const row = this.contentEl.createDiv({ cls: "hyo-confirm-buttons" });
    markDestructive(new ButtonComponent(row))
      .setButtonText("Remove")
      .onClick(() => {
        this.close();
        Promise.resolve(this.onConfirm()).catch((e: unknown) => console.error("[hyo] Couldn't finish removing:", e));
      });
    const cancel = new ButtonComponent(row).setButtonText("Cancel").onClick(() => this.close());
    cancel.buttonEl.focus();
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
