import test from "node:test";
import assert from "node:assert/strict";
import type { Setting } from "obsidian";
import { fillCustom, type CustomRow } from "../src/settings-layout";

// A stand-in for the bit of a row element fillCustom touches.
class FakeEl {
  childNodes: object[] = [];
  className = "setting-item";
  appendChild(n: object): void {
    this.childNodes.push(n);
  }
  replaceChildren(...nodes: object[]): void {
    this.childNodes = nodes;
  }
}

// Obsidian 1.13+ redraws a kept row by running its clean-up, then drawing it
// again on the same element. The row must end up drawn once, not twice.
test("a custom row drawn again on the same element is drawn once", () => {
  const info = {};
  const control = {};
  const el = new FakeEl();
  el.childNodes = [info, control];
  const setting = { settingEl: el, setName: () => setting, setDesc: () => setting } as unknown as Setting;
  const signals: AbortSignal[] = [];
  const row: CustomRow = {
    kind: "custom",
    name: "asset",
    desc: "1 command",
    build: (s, { signal }) => {
      (s.settingEl as unknown as FakeEl).appendChild({ chevron: true });
      (s.settingEl as unknown as FakeEl).className += " hyo-command-type";
      signals.push(signal);
    },
  };

  const cleanup = fillCustom(setting, row);
  assert.equal(el.childNodes.length, 3);
  cleanup();
  assert.deepEqual(el.childNodes, [info, control], "the row is back as the build found it");
  assert.equal(el.className, "setting-item");
  assert.ok(signals[0].aborted, "the first draw's listeners are removed");

  fillCustom(setting, row);
  assert.equal(el.childNodes.length, 3, "one chevron, not two");
  assert.equal(el.className, "setting-item hyo-command-type");
  assert.ok(!signals[1].aborted);
});
