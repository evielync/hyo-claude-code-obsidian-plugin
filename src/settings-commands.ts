import { AbstractInputSuggest, Notice, setIcon, type App, type Setting } from "obsidian";
import type { HyoCommand } from "./settings";
import type { Skill } from "./hooks/useSkills";
import type { Page, Row, RowScope, Section } from "./settings-layout";

/**
 * Settings → Hyo → Commands. Ported from the standalone AI Commands plugin: a
 * note's `type` frontmatter decides which header-button commands it shows.
 *
 * Everything is on the one page. Adding a note type comes first; below it,
 * each configured type is one row (its name, how many commands it has, and a
 * button that removes them) that opens in place to show its commands and a
 * link to add another.
 */

export const COMMANDS_GUIDE_URL = "https://docs.gethyo.co/skills/note-commands/";

/** What the Commands page needs from the settings tab. */
export interface CommandsHost {
  /** Obsidian, for the note-type suggestions. */
  app(): App;
  /** Note type → its commands, in the order the rows are shown. */
  commands(): Record<string, HyoCommand[]>;
  /** Every `type` found on a note in the vault. */
  noteTypes(): string[];
  /** The installed skills a command can run. */
  skills(): Skill[];
  /** True only when the skill is definitely not installed. */
  skillMissing(skill: string, skills: Skill[]): boolean;
  save(): Promise<void>;
  /** Rows were added, removed or reordered: draw the page again where it is. */
  rebuild(): void;
  /** Only which rows are shown changed: apply it without redrawing. */
  refreshVisibility(): void;
  /** Whether a note type is open, showing its commands. Survives redraws. */
  isExpanded(type: string): boolean;
  setExpanded(type: string, open: boolean): void;
  /** Ask before removing something. */
  confirm(message: string, onConfirm: () => Promise<void>): void;
  openUrl(url: string): void;
}

/** Give `type` its own (empty) list of commands. False if it's blank or already there. */
export function addNoteType(commands: Record<string, HyoCommand[]>, type: string): boolean {
  const t = type.trim();
  if (!t || Object.prototype.hasOwnProperty.call(commands, t)) return false;
  commands[t] = [];
  return true;
}

/** A new, unnamed command at the end of `type`'s list, running the first skill. */
export function addCommand(commands: Record<string, HyoCommand[]>, type: string, skills: Skill[]): void {
  commands[type]?.push({ skill: skills[0]?.name ?? "", label: "", extra: "" });
}

/** What a note type's row says about it: "2 commands", "1 command", "No commands yet". */
export function commandCount(n: number): string {
  if (n === 0) return "No commands yet";
  return n === 1 ? "1 command" : `${n} commands`;
}

/**
 * The Add box's Add (or Enter). A new type opens straight away, ready for its
 * first command; one that's already there is opened instead.
 */
export async function submitNoteType(host: CommandsHost, draft: string): Promise<void> {
  const type = draft.trim();
  if (!type) {
    new Notice("Type a note type first, or pick one from the list.");
    return;
  }
  host.setExpanded(type, true);
  if (!addNoteType(host.commands(), type)) {
    new Notice(`"${type}" is already in the list. It's open below.`);
    host.rebuild();
    return;
  }
  await host.save();
  host.rebuild();
}

/** The command row being dragged, so a drop only lands within its own note type. */
interface DragState {
  from: { type: string; index: number } | null;
}

export function commandsPage(host: CommandsHost): Page {
  const commands = host.commands();
  // Read once per render, and only when a row needs them.
  let skills: Skill[] | null = null;
  const getSkills = () => (skills ??= host.skills());
  const drag: DragState = { from: null };

  const sections: Section[] = [
    {
      items: [
        {
          kind: "custom",
          name: "How commands work",
          desc: "Attach a skill to a note type in your vault and run it with one click. For example: a Summarise command on your meeting notes.",
          build: (setting) => {
            setting.addButton((b) => b.setButtonText("Open the guide").onClick(() => host.openUrl(COMMANDS_GUIDE_URL)));
          },
        },
        {
          kind: "custom",
          name: "Add a note type",
          desc: 'Note types come from the "type" property on your notes. Type one, or pick from the types found in your vault, then press Add.',
          build: (setting) => buildAddNoteType(host, setting),
        },
      ],
    },
  ];
  const types = Object.keys(commands);
  if (types.length > 0) {
    sections.push({
      heading: "Note types",
      items: types.flatMap((type) => typeRows(host, type, commands[type], getSkills, drag)),
    });
  }

  return {
    kind: "page",
    id: "commands",
    name: "Commands",
    desc: "One-click buttons in a note's header that run a skill, set up for each note type.",
    sections,
  };
}

/** A note type's row, then (while it's open) its commands and the link to add one. */
function typeRows(host: CommandsHost, type: string, list: HyoCommand[], getSkills: () => Skill[], drag: DragState): Row[] {
  const open = () => host.isExpanded(type);
  const labels = list.map((c) => c.label).filter((l) => l.length > 0);
  return [
    {
      kind: "custom",
      name: type,
      desc: commandCount(list.length),
      // A closed type's commands aren't searchable themselves, so the type's
      // row answers for them.
      aliases: labels.length > 0 ? labels : undefined,
      build: (setting, scope) => buildTypeRow(host, setting, type, scope),
    },
    ...list.map(
      (cmd, i): Row => ({
        kind: "custom",
        name: cmd.label || "Untitled command",
        desc: `Runs the ${cmd.skill || "(no skill)"} skill on "${type}" notes`,
        visible: open,
        build: (setting, scope) => buildCommandRow(host, setting, type, list, cmd, i, getSkills(), drag, scope),
      })
    ),
    {
      kind: "custom",
      name: "Add command",
      searchable: false,
      visible: open,
      build: (setting) => {
        setting.settingEl.empty();
        setting.settingEl.addClass("hyo-command-add-row");
        const add = setting.settingEl.createEl("button", { text: "+ Add command", cls: "hyo-command-add" });
        add.addEventListener("click", () => {
          addCommand(host.commands(), type, getSkills());
          host
            .save()
            .then(() => host.rebuild())
            .catch((err: unknown) => console.error("[hyo] Couldn't add the command:", err));
        });
      },
    },
  ];
}

/** The type's row: click (or Enter) opens and closes it; the bin removes its commands. */
function buildTypeRow(host: CommandsHost, setting: Setting, type: string, { signal }: RowScope): void {
  const el = setting.settingEl;
  const chevron = el.createDiv({ cls: "hyo-command-type-chevron" });
  setIcon(chevron, "chevron-right");
  el.prepend(chevron);
  el.addClass("hyo-command-type");
  el.setAttribute("role", "button");
  el.tabIndex = 0;
  const show = (open: boolean) => {
    el.toggleClass("is-expanded", open);
    el.setAttribute("aria-expanded", String(open));
  };
  show(host.isExpanded(type));
  const toggle = () => {
    const open = !host.isExpanded(type);
    host.setExpanded(type, open);
    show(open);
    host.refreshVisibility();
  };
  el.addEventListener("click", toggle, { signal });
  el.addEventListener("keydown", (e: KeyboardEvent) => {
    // Only the row itself: Enter on the bin is the bin's.
    if (e.target !== el || (e.key !== "Enter" && e.key !== " ")) return;
    e.preventDefault();
    toggle();
  }, { signal });

  // Removing a type's commands takes all of them at once, behind a question.
  // The wording stays clearly about commands: nothing here touches the
  // user's notes or their type property.
  setting.addExtraButton((b) => {
    b.setIcon("trash-2")
      .setTooltip("Remove these commands")
      .onClick(() => {
        host.confirm(`Remove the commands for "${type}"? Your notes and their type stay exactly as they are.`, async () => {
          delete host.commands()[type];
          host.setExpanded(type, false);
          await host.save();
          host.rebuild();
        });
      });
    // The bin is inside the row, so its click mustn't also open or close it.
    b.extraSettingsEl.addEventListener("click", (e) => e.stopPropagation());
  });
}

/** Suggests the vault's note types that don't have commands yet. */
class NoteTypeSuggest extends AbstractInputSuggest<string> {
  constructor(app: App, private inputEl: HTMLInputElement, private types: string[]) {
    super(app, inputEl);
  }

  protected getSuggestions(query: string): string[] {
    const q = query.trim().toLowerCase();
    return this.types.filter((t) => t.toLowerCase().includes(q));
  }

  renderSuggestion(type: string, el: HTMLElement): void {
    el.setText(type);
  }

  selectSuggestion(type: string): void {
    this.inputEl.value = type;
    this.inputEl.dispatchEvent(new Event("input"));
    this.close();
  }
}

function buildAddNoteType(host: CommandsHost, setting: Setting): void {
  const commands = host.commands();
  const available = host.noteTypes().filter((t) => !Object.prototype.hasOwnProperty.call(commands, t));
  let draft = "";
  const add = () => submitNoteType(host, draft);
  setting
    .addText((t) => {
      t.setPlaceholder(available[0] ? `e.g. ${available[0]}` : "Note type").onChange((v) => (draft = v));
      t.inputEl.addEventListener("keydown", (e: KeyboardEvent) => {
        if (e.key !== "Enter" || e.isComposing) return;
        e.preventDefault();
        void add();
      });
      new NoteTypeSuggest(host.app(), t.inputEl, available);
    })
    .addButton((b) => b.setButtonText("Add").setCta().onClick(add));
}

// One command: drag grip, name, the skill it runs, delete.
function buildCommandRow(
  host: CommandsHost,
  row: Setting,
  type: string,
  list: HyoCommand[],
  cmd: HyoCommand,
  i: number,
  skills: Skill[],
  drag: DragState,
  { signal }: RowScope
): void {
  // The row's built-in name column would only duplicate the label input, and
  // crush it to a couple of characters. Remove it and give the whole row to
  // the controls.
  row.infoEl.remove();
  row.settingEl.addClass("hyo-command-row");

  // Drag to reorder, the same interaction as the chat tabs. The grip is the
  // drag surface (dragging from an input would fight text selection). Every
  // note type is on this page, so a row only takes drops from its own type.
  const grip = row.controlEl.createDiv({ cls: "hyo-command-grip" });
  setIcon(grip, "grip-vertical");
  grip.setAttribute("aria-label", "Drag to reorder");
  grip.addEventListener("mousedown", () => (row.settingEl.draggable = true));
  grip.addEventListener("mouseup", () => (row.settingEl.draggable = false));
  const sameType = () => drag.from !== null && drag.from.type === type;
  row.settingEl.addEventListener("dragstart", (e: DragEvent) => {
    drag.from = { type, index: i };
    e.dataTransfer?.setData("text/plain", String(i));
    if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
    row.settingEl.addClass("is-dragging");
  }, { signal });
  // The drop indicator is its own element laid over the row's top edge; a
  // shadow or border would follow the card's rounded corners and read as a
  // curve rather than a line.
  const dropLine = row.settingEl.createDiv({ cls: "hyo-command-dropline" });
  row.settingEl.addEventListener("dragend", () => {
    drag.from = null;
    row.settingEl.draggable = false;
    row.settingEl.removeClass("is-dragging");
    dropLine.removeClass("is-active");
  }, { signal });
  row.settingEl.addEventListener("dragover", (e: DragEvent) => {
    if (!sameType()) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    dropLine.addClass("is-active");
  }, { signal });
  row.settingEl.addEventListener("dragleave", () => {
    dropLine.removeClass("is-active");
  }, { signal });
  row.settingEl.addEventListener("drop", (e: DragEvent) => {
    e.preventDefault();
    dropLine.removeClass("is-active");
    if (!sameType() || !drag.from) return;
    const from = drag.from.index;
    drag.from = null;
    if (from === i) return;
    const [moved] = list.splice(from, 1);
    list.splice(i, 0, moved);
    host
      .save()
      .then(() => host.rebuild())
      .catch((err: unknown) => console.error("[hyo] Couldn't save the new command order:", err));
  }, { signal });

  row.addText((text) => {
    text
      .setPlaceholder("Command name")
      .setValue(cmd.label || "")
      .onChange(async (v) => {
        cmd.label = v;
        await host.save();
      });
    // Fixed column widths, not flex-to-content: every row lines up with the
    // headers and each other regardless of how long a skill name is.
    text.inputEl.addClass("hyo-command-label");
  });
  row.addDropdown((dropdown) => {
    for (const sk of skills) dropdown.addOption(sk.name, sk.name);
    const missing = host.skillMissing(cmd.skill, skills);
    if (cmd.skill && !skills.find((sk) => sk.name === cmd.skill)) {
      dropdown.addOption(cmd.skill, `${cmd.skill} (not installed)`);
    }
    dropdown.setValue(cmd.skill || skills[0]?.name || "");
    // A command pointing at a skill that isn't installed does nothing when
    // clicked, so it has to stand out here, not just in the option text.
    if (missing) {
      dropdown.selectEl.addClass("is-missing");
      dropdown.selectEl.title = `"${cmd.skill}" isn't installed. Pick the skill this command should run.`;
    }
    dropdown.onChange(async (v) => {
      cmd.skill = v;
      await host.save();
      host.rebuild();
    });
    // (Legacy `extra` instructions from the standalone plugin still fire with
    // the command; there's just no editing UI for them any more.)
    dropdown.selectEl.addClass("hyo-command-skill");
  });
  row.addExtraButton((b) =>
    b
      .setIcon("trash-2")
      .setTooltip("Delete command")
      .onClick(async () => {
        list.splice(i, 1);
        await host.save();
        host.rebuild();
      })
  );
}
