// Hyo's settings layout as Obsidian 1.13+'s declarative definitions.
import test from "node:test";
import assert from "node:assert/strict";
import { toDefinitions, controlRows, type Layout } from "../src/settings-layout";

const state = { on: true, side: "right" };
const layout: Layout = {
  top: [{ items: [{ kind: "custom", name: "Documentation", desc: "Docs.", build: () => {} }] }],
  pages: [
    {
      kind: "page",
      id: "general",
      name: "General",
      desc: "Everyday defaults.",
      sections: [
        {
          items: [
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
        },
        {
          heading: "Note types",
          items: [
            {
              kind: "page",
              id: "type:meeting",
              name: "meeting",
              desc: "1 command",
              sections: [
                {
                  items: [
                    { kind: "custom", name: "Columns", searchable: false, build: () => {} },
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
            },
          ],
        },
      ],
    },
  ],
};

test("rows above the pages come first, then one page per tab", () => {
  const defs = toDefinitions(layout);
  assert.equal(defs.length, 2);
  assert.ok("type" in defs[0] && defs[0].type === "group");
  assert.ok("type" in defs[1] && defs[1].type === "page" && defs[1].name === "General" && defs[1].desc === "Everyday defaults.");
});

test("plain settings become Obsidian controls keyed for getControlValue, custom rows render themselves", () => {
  const [top, page] = toDefinitions(layout);
  assert.ok("items" in top && top.items);
  const docs = top.items[0];
  assert.ok("render" in docs && typeof docs.render === "function");
  assert.equal(docs.name, "Documentation");

  assert.ok("type" in page && page.type === "page" && page.items);
  const group = page.items[0];
  assert.ok("type" in group && group.type === "group" && group.items);
  const [dock, side] = group.items;
  assert.ok("control" in dock && dock.control?.type === "toggle" && dock.control.key === "dock");
  assert.ok("control" in side && side.control?.type === "dropdown");
  assert.deepEqual(side.control.type === "dropdown" ? side.control.options : null, { right: "Right", left: "Left" });
  assert.ok("visible" in side && typeof side.visible === "function" && side.visible() === true);
});

test("nested pages stay pages, and rows that aren't settings stay out of search", () => {
  const page = toDefinitions(layout)[1];
  assert.ok("type" in page && page.type === "page" && page.items);
  const types = page.items[1];
  assert.ok("type" in types && types.type === "group" && types.heading === "Note types" && types.items);
  const meeting = types.items[0];
  assert.ok("type" in meeting && meeting.type === "page" && meeting.name === "meeting" && meeting.items);
  const inner = meeting.items[0];
  assert.ok("type" in inner && inner.type === "group" && inner.items);
  const [columns, max] = inner.items;
  assert.ok("searchable" in columns && columns.searchable === false);
  assert.ok("control" in max && max.control?.type === "number");
  const validate = max.control.type === "number" ? max.control.validate : undefined;
  assert.ok(validate);
  assert.equal(validate(512), "Must be at least 1024.");
  assert.equal(validate(2048), undefined);
});

test("every control row is found by its key, nested pages included", () => {
  const rows = controlRows(layout);
  assert.deepEqual([...rows.keys()].sort(), ["dock", "dockSide", "max"]);
  assert.equal(rows.get("dock")?.binding.get(), true);
});
