import { test } from "node:test";
import assert from "node:assert/strict";
import { MODEL_OPTIONS, claudeUpdateNeeded, isNative1M } from "../src/models";

test("Fable 5.2 is in the picker, with its 1M window", () => {
  const f = MODEL_OPTIONS.find((m) => m.id === "claude-fable-5-2");
  assert.ok(f);
  assert.equal(f!.name, "Fable 5.2");
  assert.equal(isNative1M("claude-fable-5-2"), true);
  assert.equal(MODEL_OPTIONS.some((m) => m.id === "claude-fable-5-1"), false);
});

test("Fable 5.2 asks for Claude Code 2.1.321 or newer", () => {
  assert.equal(claudeUpdateNeeded("claude-fable-5-2", "2.1.280 (Claude Code)"), "2.1.321");
  assert.equal(claudeUpdateNeeded("claude-fable-5-2", "2.1.319"), "2.1.321");
  assert.equal(claudeUpdateNeeded("claude-fable-5-2", "2.1.321"), null);
  assert.equal(claudeUpdateNeeded("claude-fable-5-1", "2.1.280"), null);
});
