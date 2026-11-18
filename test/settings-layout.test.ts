// Hyo's settings layout: how the tab is arranged, and the declarative
// definitions Obsidian 1.13+ draws from it.
import test from "node:test";
import assert from "node:assert/strict";
import {
  arrangeTab,
  controlRows,
  toDefinitions,
  type Layout,
  type Page,
  type Row,
  type Section,
  type TabParts,
} from "../src/settings-layout";
import { addCommand, addNoteType, commandCount, commandsPage, submitNoteType, type CommandsHost } from "../src/settings-commands";
import { voicePage, type VoiceHost, type VoiceSettings } from "../src/settings-voice";
import type { HyoCommand } from "../src/settings";
import type { SettingDefinitionItem, SettingDefinitionPage, SettingGroupItem } from "obsidian";

// ---- Helpers ----------------------------------------------------------------

const row = (name: string): Row => ({ kind: "custom", name, desc: `${name}.`, build: () => {} });
const page = (id: string, name: string): Page => ({ kind: "page", id, name, desc: `What's in ${name}.`, sections: [{ items: [row(`${name} row`)] }] });

const state = { on: true, side: "right", customModels: [] as string[] };
const parts: TabParts = {
  documentation: () => [row("Documentation")],
  setup: () => [row("Claude Code"), row("Install Claude Code"), row("Sign in to Claude"), row("Claude Code path")],
  general: () => [
    {
      kind: "control",
      key: "dock",
      name: "Dock",
      desc: "A strip.",
      binding: { type: "toggle", get: () => state.on, set: (v) => (state.on = v) },
    },
    {
      kind: "control",
      key: "dockSide",
      name: "Dock side",
      desc: "Which edge.",
      visible: () => state.on,
      binding: { type: "dropdown", options: { right: "Right", left: "Left" }, get: () => state.side, set: (v) => (state.side = v) },
    },
  ],
  customModels: () => state.customModels.map(row),
  voice: () => page("voice", "Voice"),
  mobile: () => page("mobile", "Mobile"),
  commands: () => page("commands", "Commands"),
  advanced: () => ({
    kind: "page",
    id: "advanced",
    name: "Advanced",
    desc: "Rarely needed.",
    sections: [
      {
        items: [
          {
            kind: "control",
            key: "max",
            name: "Max",
            desc: "A cap.",
            binding: { type: "number", min: 1024, get: () => 64000, set: () => {} },
          },
        ],
      },
    ],
  }),
};

function isPage(item: SettingDefinitionItem | SettingGroupItem): item is SettingDefinitionPage {
  return "type" in item && item.type === "page";
}

/** The top-level groups, as Obsidian gets them. */
function groups(layout: Layout) {
  return toDefinitions(layout).map((d) => {
    assert.ok("type" in d && d.type === "group", "every top-level item is a group");
    return d;
  });
}

const names = (items: SettingGroupItem[] | undefined) => (items ?? []).map((i) => i.name);

// ---- The tab ------------------------------------------------------------------

test("Setup and General are groups shown straight away, with their headings", () => {
  const [docs, setup, general] = groups(arrangeTab(parts, false));
  assert.equal(docs.heading, undefined);
  assert.deepEqual(names(docs.items), ["Documentation"]);
  assert.equal(setup.heading, "Setup");
  assert.deepEqual(names(setup.items), ["Claude Code", "Install Claude Code", "Sign in to Claude", "Claude Code path"]);
  assert.ok(setup.items?.every((i) => !isPage(i)), "Setup's rows are all shown, none behind a click");
  assert.equal(general.heading, "General");
  assert.deepEqual(names(general.items), ["Dock", "Dock side"]);
  assert.ok(general.items?.every((i) => !isPage(i)));
});

test("Voice, Mobile, Commands and Advanced follow as pages, in that order, each with its description", () => {
  const all = groups(arrangeTab(parts, false));
  const last = all[all.length - 1];
  assert.equal(all.length, 4, "documentation, Setup, General, the pages");
  assert.ok(last.items?.every(isPage));
  assert.deepEqual(names(last.items), ["Voice", "Mobile", "Commands", "Advanced"]);
  for (const p of last.items ?? []) assert.ok(isPage(p) && typeof p.desc === "string" && p.desc.length > 0);
});

test("custom models get their own group under General, only when there are some", () => {
  state.customModels = ["my-model"];
  try {
    const all = groups(arrangeTab(parts, false));
    assert.equal(all[3].heading, "Custom models");
    assert.deepEqual(names(all[3].items), ["my-model"]);
  } finally {
    state.customModels = [];
  }
});

test("the phone shows General, then Voice and Mobile as pages: no Setup, Commands or Advanced", () => {
  const all = groups(arrangeTab(parts, true));
  assert.deepEqual(
    all.map((g) => g.heading),
    [undefined, "General", undefined]
  );
  assert.deepEqual(names(all[2].items), ["Voice", "Mobile"]);
  const everything = JSON.stringify(toDefinitions(arrangeTab(parts, true)));
  for (const gone of ["Setup", "Claude Code", "Commands", "Advanced"]) assert.ok(!everything.includes(`"${gone}"`), gone);
});

test("plain settings become Obsidian controls keyed for getControlValue, custom rows render themselves", () => {
  const [docs, , general] = groups(arrangeTab(parts, false));
  const docsRow = docs.items?.[0];
  assert.ok(docsRow && "render" in docsRow && typeof docsRow.render === "function");
  const [dock, side] = general.items ?? [];
  assert.ok("control" in dock && dock.control?.type === "toggle" && dock.control.key === "dock");
  assert.ok("control" in side && side.control?.type === "dropdown");
  assert.deepEqual(side.control.type === "dropdown" ? side.control.options : null, { right: "Right", left: "Left" });
  assert.ok("visible" in side && typeof side.visible === "function" && side.visible() === true);
});

test("a number control keeps its minimum, inside a page", () => {
  const all = groups(arrangeTab(parts, false));
  const advanced = all[all.length - 1].items?.[3];
  assert.ok(advanced && isPage(advanced) && advanced.items);
  const group = advanced.items[0];
  assert.ok("type" in group && group.type === "group" && group.items);
  const max = group.items[0];
  assert.ok("control" in max && max.control?.type === "number");
  const validate = max.control.type === "number" ? max.control.validate : undefined;
  assert.ok(validate);
  assert.equal(validate(512), "Must be at least 1024.");
  assert.equal(validate(2048), undefined);
});

test("every control row is found by its key, pages included", () => {
  const rows = controlRows(arrangeTab(parts, false));
  assert.deepEqual([...rows.keys()].sort(), ["dock", "dockSide", "max"]);
  assert.equal(rows.get("dock")?.binding.get(), true);
});

// ---- Voice ----------------------------------------------------------------------

function voiceHost(settings: VoiceSettings): VoiceHost {
  return {
    settings: () => settings,
    keyInput: () => {},
    voicePicker: () => {},
    customVoiceAdder: () => {},
    removeCustomVoice: async () => {},
    aboutYou: () => {},
    stackedTextArea: () => {},
    refreshVisibility: () => {},
  };
}

function voiceSettings(): VoiceSettings {
  return {
    openAiApiKey: "",
    gptLiveCustomVoices: [{ id: "voice_abc", name: "Chad", description: "A relaxed British man." }],
    voiceAboutYouNote: "",
    voicePersonality: "",
    dictationProvider: "openai",
    elevenLabsApiKey: "",
  };
}

/** A page's groups as Obsidian gets them: [heading, the rows shown now]. */
function pageOutline(p: Page): [string | undefined, string[]][] {
  const def = toDefinitions({ sections: [{ items: [p] }] })[0];
  assert.ok("items" in def && def.items);
  const defPage = def.items[0];
  assert.ok(isPage(defPage) && defPage.items);
  return defPage.items.map((g) => {
    assert.ok("type" in g && g.type === "group", "the page holds only groups");
    assert.ok(!g.items?.some(isPage), "no row opens another page");
    const shown = (g.items ?? []).filter((i) => typeof i.visible !== "function" || i.visible());
    return [g.heading, names(shown)];
  });
}

test("Voice has voice calls, then dictation, each in its own headed group", () => {
  const s = voiceSettings();
  s.dictationProvider = "elevenlabs";
  assert.deepEqual(pageOutline(voicePage(voiceHost(s))), [
    ["Voice calls (GPT-Live)", ["OpenAI API key", "Voice", "Chad", "Add a custom voice", "About you", "Personality"]],
    ["Dictation", ["Dictation service", "ElevenLabs API key"]],
  ]);
});

test("the ElevenLabs key shows only when ElevenLabs does the dictation", () => {
  const s = voiceSettings();
  assert.deepEqual(pageOutline(voicePage(voiceHost(s)))[1], ["Dictation", ["Dictation service"]]);
  s.dictationProvider = "elevenlabs";
  assert.deepEqual(pageOutline(voicePage(voiceHost(s)))[1], ["Dictation", ["Dictation service", "ElevenLabs API key"]]);
});

test("Personality is drawn by Hyo, like About you, with a one-line description", () => {
  const personality = voicePage(voiceHost(voiceSettings())).sections[0].items.find((i) => i.name === "Personality");
  // A custom row, so its box sits full width underneath (Obsidian's own
  // textarea control would squeeze it into the right-hand column).
  assert.ok(personality && personality.kind === "custom");
  assert.equal(personality.desc, "How the voice talks to you: its character and tone.");
});

// ---- Commands -------------------------------------------------------------------

function commandsHost(commands: Record<string, HyoCommand[]>, expanded = new Set<string>()): CommandsHost {
  return {
    app: () => {
      throw new Error("No Obsidian app in tests");
    },
    commands: () => commands,
    noteTypes: () => ["meeting", "project", "person"],
    skills: () => [],
    skillMissing: () => false,
    save: async () => {},
    rebuild: () => {},
    refreshVisibility: () => {},
    isExpanded: (type) => expanded.has(type),
    setExpanded: (type, open) => {
      if (open) expanded.add(type);
      else expanded.delete(type);
    },
    confirm: () => {},
    openUrl: () => {},
  };
}

/** Every page anywhere under these sections. */
function nestedPages(sections: Section[]): Page[] {
  return sections.flatMap((s) => s.items.flatMap((i) => (i.kind === "page" ? [i, ...nestedPages(i.sections)] : [])));
}

/** The note types' rows shown now, with each row's description. */
function typeRowsShown(host: CommandsHost): [string, string | undefined][] {
  const group = commandsPage(host).sections[1];
  assert.equal(group.heading, "Note types");
  return group.items
    .filter((i): i is Row => i.kind !== "page" && (!i.visible || i.visible()))
    .map((r) => [r.name, typeof r.desc === "string" ? r.desc : undefined]);
}

const threeTypes = (): Record<string, HyoCommand[]> => ({
  meeting: [
    { skill: "summarise", label: "Summarise" },
    { skill: "actions", label: "Action items" },
  ],
  project: [{ skill: "status", label: "" }],
  person: [],
});

test("Commands puts Add a note type first, then one closed row per note type with its count", () => {
  const host = commandsHost(threeTypes());
  assert.equal(nestedPages(commandsPage(host).sections).length, 0);
  assert.deepEqual(pageOutline(commandsPage(host)), [
    [undefined, ["How commands work", "Add a note type"]],
    ["Note types", ["meeting", "project", "person"]],
  ]);
  assert.deepEqual(typeRowsShown(host), [
    ["meeting", "2 commands"],
    ["project", "1 command"],
    ["person", "No commands yet"],
  ]);
});

test("an open note type shows its commands and a link to add one, under its row", () => {
  const expanded = new Set(["meeting"]);
  const host = commandsHost(threeTypes(), expanded);
  assert.deepEqual(pageOutline(commandsPage(host))[1], [
    "Note types",
    ["meeting", "Summarise", "Action items", "Add command", "project", "person"],
  ]);
  // Closing it again hides them: no redraw of the definitions needed.
  const page = commandsPage(host);
  expanded.delete("meeting");
  assert.deepEqual(pageOutline(page)[1], ["Note types", ["meeting", "project", "person"]]);
});

test("there's no section for removing a type's commands: the type's row does that", () => {
  const all = pageOutline(commandsPage(commandsHost(threeTypes(), new Set(["meeting", "project", "person"]))));
  assert.equal(all.length, 2);
  assert.ok(!JSON.stringify(all).includes("Remove"));
});

test("with no note types yet, the page is the guide and the Add box", () => {
  assert.deepEqual(pageOutline(commandsPage(commandsHost({}))), [[undefined, ["How commands work", "Add a note type"]]]);
});

test("a newly added note type opens straight away, ready for its first command", async () => {
  const commands: Record<string, HyoCommand[]> = { meeting: [{ skill: "summarise", label: "Summarise" }] };
  const expanded = new Set<string>();
  const host = commandsHost(commands, expanded);
  await submitNoteType(host, "  project ");
  assert.deepEqual(Object.keys(commands), ["meeting", "project"]);
  assert.deepEqual(pageOutline(commandsPage(host))[1], ["Note types", ["meeting", "project", "Add command"]]);
  assert.equal(addNoteType(commands, "project"), false, "a type is only added once");
  assert.equal(addNoteType(commands, "   "), false, "a blank type isn't added");
});

test("adding a command adds its row under that type, running the first skill", () => {
  const commands: Record<string, HyoCommand[]> = { meeting: [], project: [] };
  addCommand(commands, "project", [
    { name: "status", description: "", content: "" },
    { name: "other", description: "", content: "" },
  ]);
  assert.deepEqual(commands.project, [{ skill: "status", label: "", extra: "" }]);
  assert.deepEqual(pageOutline(commandsPage(commandsHost(commands, new Set(["project"]))))[1], [
    "Note types",
    ["meeting", "project", "Untitled command", "Add command"],
  ]);
  assert.deepEqual([commandCount(0), commandCount(1), commandCount(2)], ["No commands yet", "1 command", "2 commands"]);
});
