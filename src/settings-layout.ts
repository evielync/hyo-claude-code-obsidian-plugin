import { Setting, type SettingControl, type SettingDefinition, type SettingDefinitionItem, type SettingDefinitionPage, type SettingGroupItem } from "obsidian";

/**
 * Hyo's settings are described once, as groups of rows (some of which open a
 * page of their own groups), and drawn two ways from that one description:
 *
 * - Obsidian 1.13 and later: `toDefinitions` turns it into the declarative
 *   settings API's definitions, which Obsidian renders and indexes for its
 *   settings search.
 * - Obsidian 1.7.2 to 1.12: `FallbackRenderer` draws the same groups, with
 *   each page as a row that opens it in place and a way back.
 *
 * A plain setting (a toggle, a dropdown, a text box) is a `ControlRow`:
 * Obsidian draws its control on 1.13+, the fallback draws the same control.
 * Anything else is a `CustomRow`, whose `build` fills in the row on both.
 */

/** A row's description: text, or a fresh fragment each time it's drawn. */
export type Desc = string | (() => DocumentFragment);

interface RowBase {
  name: string;
  /** Extra words the settings search matches. */
  aliases?: string[];
  /** Checked on each render: false hides the row and keeps it out of search. */
  visible?: () => boolean;
}

export type ControlBinding =
  | { type: "toggle"; get: () => boolean; set: (v: boolean) => void }
  | { type: "dropdown"; options: Record<string, string>; get: () => string; set: (v: string) => void }
  | { type: "text"; placeholder?: string; get: () => string; set: (v: string) => void }
  | { type: "textarea"; placeholder?: string; rows: number; get: () => string; set: (v: string) => void }
  | { type: "number"; placeholder?: string; min: number; get: () => number; set: (v: number) => void };

export interface ControlRow extends RowBase {
  kind: "control";
  desc: Desc;
  /** Unique within the layout: how Obsidian asks for and hands back this row's value. */
  key: string;
  binding: ControlBinding;
  /** Runs after the new value is saved. */
  after?: () => void;
}

/**
 * A row that's a setting has a name and description, so the settings search
 * finds it; only rows that aren't settings (a column header, an empty state)
 * may leave the description out, and they're kept out of search.
 */
export type CustomRow = RowBase & {
  kind: "custom";
  /**
   * Fills in the row. Name and description are already set. Listeners on the
   * row's own element must be added with `scope.signal`, so a redraw removes
   * them (see fillCustom).
   */
  build: (setting: Setting, scope: RowScope) => void;
} & ({ desc: Desc; searchable?: true } | { desc?: Desc; searchable: false });

export type Row = ControlRow | CustomRow;

export interface Section {
  /** Shown above the group. Setup, General and each note type have one. */
  heading?: string;
  items: (Row | Page)[];
  visible?: () => boolean;
}

/** A row that opens its own screen: Voice, Mobile, Commands, Advanced. */
export interface Page {
  kind: "page";
  /** Unique among its siblings; the fallback remembers which page is open by it. */
  id: string;
  name: string;
  /** One line on the row that opens the page, so people know what's inside. */
  desc?: Desc;
  sections: Section[];
}

/** The whole tab: groups shown straight away, with pages among their rows. */
export interface Layout {
  sections: Section[];
}

/** What Hyo's tab is made of. Each part is built only when it's shown. */
export interface TabParts {
  /** Links to the docs, above everything. */
  documentation: () => Row[];
  /** Claude Code: installed, signed in, and the actions that get it there. */
  setup: () => Row[];
  /** The everyday defaults. */
  general: () => Row[];
  /** Models added from the picker, removable here; often none. */
  customModels: () => Row[];
  voice: () => Page;
  mobile: () => Page;
  commands: () => Page;
  advanced: () => Page;
}

/**
 * The tab, top to bottom: Setup and General shown in full, then the pages to
 * click into. The phone gets General, Voice and Mobile; Setup, Commands and
 * Advanced are desktop concerns (installing Claude, note-header buttons, paths).
 */
export function arrangeTab(parts: TabParts, isMobile: boolean): Layout {
  const sections: Section[] = [{ items: parts.documentation() }];
  if (!isMobile) sections.push({ heading: "Setup", items: parts.setup() });
  sections.push({ heading: "General", items: parts.general() });
  const customModels = parts.customModels();
  if (customModels.length > 0) sections.push({ heading: "Custom models", items: customModels });
  const pages = isMobile
    ? [parts.voice(), parts.mobile()]
    : [parts.voice(), parts.mobile(), parts.commands(), parts.advanced()];
  sections.push({ items: pages });
  return { sections };
}

function descOf(desc: Desc | undefined): string | DocumentFragment | undefined {
  return typeof desc === "function" ? desc() : desc;
}

/** What a custom row's build gets besides the Setting. */
export interface RowScope {
  /** Aborted before the row is drawn again: pass it to addEventListener. */
  signal: AbortSignal;
}

/**
 * Name, description, then whatever the row adds: the same on both renderers.
 *
 * Returns the row's clean-up. On a redraw, Obsidian 1.13+ keeps a row whose
 * key is unchanged, runs this clean-up, clears the Setting's own name,
 * description and controls, and draws the row again on the same element.
 * Anything a build added to the row element itself (an icon, a text box, a
 * drop line, classes, listeners) would otherwise be added a second time, so
 * the clean-up puts the element back exactly as the build found it.
 */
export function fillCustom(setting: Setting, row: CustomRow): () => void {
  const el = setting.settingEl;
  const children = Array.from(el.childNodes);
  const className = el.className;
  const controller = new AbortController();
  setting.setName(row.name);
  const desc = descOf(row.desc);
  if (desc !== undefined) setting.setDesc(desc);
  row.build(setting, { signal: controller.signal });
  return () => {
    controller.abort();
    el.replaceChildren(...children);
    el.className = className;
  };
}

/** Every control row in a layout, by key. */
export function controlRows(layout: Layout): Map<string, ControlRow> {
  const out = new Map<string, ControlRow>();
  const walkSections = (sections: Section[]) => {
    for (const s of sections) {
      for (const item of s.items) {
        if (item.kind === "page") walkSections(item.sections);
        else if (item.kind === "control") out.set(item.key, item);
      }
    }
  };
  walkSections(layout.sections);
  return out;
}

// ---- Obsidian 1.13+: declarative definitions --------------------------------

function controlOf(row: ControlRow): SettingControl {
  const b = row.binding;
  switch (b.type) {
    case "toggle":
      return { type: "toggle", key: row.key };
    case "dropdown":
      return { type: "dropdown", key: row.key, options: b.options };
    case "text":
      return { type: "text", key: row.key, placeholder: b.placeholder };
    case "textarea":
      return { type: "textarea", key: row.key, placeholder: b.placeholder, rows: b.rows };
    case "number": {
      const min = b.min;
      return {
        type: "number",
        key: row.key,
        placeholder: b.placeholder,
        min,
        validate: (v: number) => (v >= min ? undefined : `Must be at least ${min}.`),
      };
    }
  }
}

function rowDefinition(row: Row): SettingDefinition {
  const base = { name: row.name, desc: descOf(row.desc), aliases: row.aliases, visible: row.visible };
  if (row.kind === "control") return { ...base, control: controlOf(row) };
  return { ...base, searchable: row.searchable, render: (setting: Setting) => fillCustom(setting, row) };
}

function pageDefinition(page: Page): SettingDefinitionPage {
  return { type: "page", name: page.name, desc: descOf(page.desc), items: page.sections.map(sectionDefinition) };
}

function sectionDefinition(section: Section): SettingDefinitionItem {
  const items: SettingGroupItem[] = section.items.map((item) =>
    item.kind === "page" ? pageDefinition(item) : rowDefinition(item)
  );
  return { type: "group", heading: section.heading, items, visible: section.visible };
}

export function toDefinitions(layout: Layout): SettingDefinitionItem[] {
  return layout.sections.map(sectionDefinition);
}

// ---- Obsidian 1.7.2 to 1.12: drawn by Hyo -----------------------------------

export interface FallbackHost {
  /** Save a control row's new value; resolves to whether it was taken. */
  change(row: ControlRow, value: unknown): Promise<boolean>;
  /** A value was saved from this row. */
  saved(setting: Setting): void;
  /** Navigation changed: draw again. */
  redraw(): void;
}

/**
 * Draws a layout's groups in order, each page as a row that opens it in
 * place, with a way back. Which page is open survives redraws, so saving a
 * value or adding a row never bounces back to the top.
 */
export class FallbackRenderer {
  /** The ids of the open page and the pages it was opened from, outermost first. */
  private openPath: string[] = [];
  /** Set when a page was just opened or closed, so the new screen starts at the top. */
  private navigated = false;

  constructor(private host: FallbackHost) {}

  render(containerEl: HTMLElement, layout: Layout): void {
    containerEl.empty();
    const trail: Page[] = [];
    let sections = layout.sections;
    for (const id of this.openPath) {
      const page = findPage(sections, id);
      if (!page) break;
      trail.push(page);
      sections = page.sections;
    }
    this.openPath = trail.map((p) => p.id);

    const open = trail[trail.length - 1];
    if (open) {
      const backTo = trail.length > 1 ? trail[trail.length - 2].name : "All settings";
      const back = containerEl.createDiv({ text: `← ${backTo}`, cls: "hyo-settings-back" });
      back.addEventListener("click", () => this.navigate(this.openPath.slice(0, -1)));
      new Setting(containerEl).setName(open.name).setHeading();
      const desc = descOf(open.desc);
      if (desc !== undefined) {
        const intro = containerEl.createEl("p", { cls: "hyo-settings-intro" });
        intro.append(desc);
      }
    }
    for (const s of sections) this.section(containerEl, s);

    if (this.navigated) {
      this.navigated = false;
      containerEl.scrollTop = 0;
    }
  }

  private navigate(path: string[]): void {
    this.openPath = path;
    this.navigated = true;
    this.host.redraw();
  }

  private section(el: HTMLElement, section: Section): void {
    if (section.visible && !section.visible()) return;
    if (section.heading) new Setting(el).setName(section.heading).setHeading();
    for (const item of section.items) {
      if (item.kind === "page") this.pageEntry(el, item);
      else this.row(el, item);
    }
  }

  private pageEntry(el: HTMLElement, page: Page): void {
    const entry = new Setting(el).setName(page.name);
    const desc = descOf(page.desc);
    if (desc !== undefined) entry.setDesc(desc);
    entry.settingEl.addClass("hyo-settings-page-row");
    entry.addExtraButton((b) => b.setIcon("chevron-right").setTooltip("Open"));
    entry.settingEl.addEventListener("click", () => this.navigate([...this.openPath, page.id]));
  }

  private row(el: HTMLElement, row: Row): void {
    if (row.visible && !row.visible()) return;
    const setting = new Setting(el);
    if (row.kind === "custom") {
      fillCustom(setting, row);
      return;
    }
    setting.setName(row.name);
    const desc = descOf(row.desc);
    if (desc !== undefined) setting.setDesc(desc);
    const save = (value: unknown) => {
      this.host
        .change(row, value)
        .then((taken) => {
          if (taken) this.host.saved(setting);
        })
        .catch((e: unknown) => console.error(`[hyo] Couldn't save ${row.name}:`, e));
    };
    const b = row.binding;
    switch (b.type) {
      case "toggle":
        setting.addToggle((t) => t.setValue(b.get()).onChange(save));
        break;
      case "dropdown":
        setting.addDropdown((d) => d.addOptions(b.options).setValue(b.get()).onChange(save));
        break;
      case "text":
        setting.addText((t) => t.setPlaceholder(b.placeholder ?? "").setValue(b.get()).onChange(save));
        break;
      case "textarea":
        setting.settingEl.addClass("hyo-setting-stacked");
        setting.addTextArea((t) => {
          t.inputEl.rows = b.rows;
          t.inputEl.addClass("hyo-textarea-full");
          t.setPlaceholder(b.placeholder ?? "").setValue(b.get()).onChange(save);
        });
        break;
      case "number":
        setting.addText((t) =>
          t
            .setPlaceholder(b.placeholder ?? "")
            .setValue(String(b.get()))
            .onChange((v) => {
              const n = parseInt(v, 10);
              if (!isNaN(n) && n >= b.min) save(n);
            })
        );
        break;
    }
  }
}

/** A visible page among these groups' rows, by id. */
function findPage(sections: Section[], id: string): Page | null {
  for (const s of sections) {
    if (s.visible && !s.visible()) continue;
    for (const item of s.items) if (item.kind === "page" && item.id === id) return item;
  }
  return null;
}
