// obsidian://hyo links: what each one asks Hyo to do.
import test from "node:test";
import assert from "node:assert/strict";
import { parseHyoLink } from "../src/hyo-link";

test("a bare link only opens Hyo", () => {
  assert.equal(parseHyoLink({ vault: "EV-HQ", action: "hyo" }), null);
  assert.equal(parseHyoLink({ session: " ", prompt: "  " }), null);
});

test("session= opens that conversation", () => {
  assert.deepEqual(parseHyoLink({ session: "abc-123" }), { session: "abc-123" });
});

test("prompt= keeps the text exactly as given", () => {
  assert.deepEqual(parseHyoLink({ prompt: "Plan my day\nthen the inbox" }), { prompt: "Plan my day\nthen the inbox" });
});

test("session= and prompt= together go to that conversation's box", () => {
  assert.deepEqual(parseHyoLink({ session: "abc", prompt: "hi" }), { session: "abc", prompt: "hi" });
});
