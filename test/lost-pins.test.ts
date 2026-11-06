// A pinned conversation Claude Code has deleted (it clears out conversations
// it hasn't used in `cleanupPeriodDays`, 30 by default) is said once, by
// name, and unpinned, instead of silently vanishing from the Open list.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const home = mkdtempSync(join(tmpdir(), "hyo-lostpins-home-"));
process.env.HOME = home;
process.env.USERPROFILE = home;

import { getProjectDir, listPinned, takeLostPins, lostPinsNotice } from "../src/session-parser";
import { OpenConversationsStore } from "../src/open-conversations";

function session(dir: string, id: string, text: string) {
  mkdirSync(dir, { recursive: true });
  const lines = [
    { type: "user", message: { role: "user", content: text }, uuid: "u1" },
    { type: "assistant", message: { id: "m1", role: "assistant", content: [{ type: "text", text: `Reply. ${"padding ".repeat(80)}` }] }, uuid: "a1" },
  ];
  writeFileSync(join(dir, `${id}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

const longAgo = new Date(Date.now() - 40 * 24 * 3600_000).toISOString();

function vault(): string {
  const cwd = mkdtempSync(join(tmpdir(), "hyo-lostpins-cwd-"));
  const dir = getProjectDir(cwd);
  session(dir, "still-here", "the launch plan");
  writeFileSync(
    join(dir, "session-metadata.json"),
    JSON.stringify({
      "still-here": { customTitle: "Launch plan", pinned: true, pinnedAt: longAgo },
      gone: { customTitle: "Momentum Club funnel", pinned: true, pinnedAt: longAgo },
      "call-only": { pinned: true, pinnedAt: longAgo, voiceCalls: [{ id: "c1", startedAt: longAgo, turns: [] }] },
      "just-pinned": { pinned: true, pinnedAt: new Date().toISOString() },
      "gone-unpinned": { customTitle: "Not pinned" },
    })
  );
  return cwd;
}

const meta = (cwd: string) => JSON.parse(readFileSync(join(getProjectDir(cwd), "session-metadata.json"), "utf8"));

test("a deleted pinned conversation is found, unpinned, and only once", () => {
  const cwd = vault();
  assert.deepEqual(takeLostPins(cwd), [{ id: "gone", title: "Momentum Club funnel" }]);
  const m = meta(cwd);
  assert.equal(m.gone.pinned, false, "the pin is cleared");
  assert.equal(m.gone.pinnedAt, undefined);
  assert.equal(m.gone.customTitle, "Momentum Club funnel", "its title stays");
  assert.equal(m["still-here"].pinned, true, "a pin with its transcript is untouched");
  assert.equal(m["call-only"].pinned, true, "a call-only conversation has no transcript by design");
  assert.equal(m["just-pinned"].pinned, true, "a pin made moments ago may not have its first line written yet");
  assert.deepEqual(takeLostPins(cwd), [], "the second time, nothing to say");
  assert.deepEqual(listPinned(cwd).map((p) => p.id).sort(), ["call-only", "still-here"]);
});

test("the notice names it, in plain words", () => {
  assert.equal(
    lostPinsNotice([{ title: "Momentum Club funnel" }]),
    "Your pinned conversation “Momentum Club funnel” can't be found. Claude Code deleted it because it hadn't been used for a while."
  );
  assert.equal(
    lostPinsNotice([{ title: "A" }, { title: "B" }, { title: null }]),
    "Your pinned conversations “A”, “B” and one other can't be found. Claude Code deleted them because they hadn't been used for a while."
  );
  assert.equal(
    lostPinsNotice([{ title: null }]),
    "One of your pinned conversations can't be found. Claude Code deleted it because it hadn't been used for a while."
  );
});

test("wired the way main.ts wires it: the Open list drops the lost pin, the notice fires once", () => {
  const cwd = vault();
  const notices: string[] = [];
  const pins = () => {
    const lost = takeLostPins(cwd);
    if (lost.length) notices.push(lostPinsNotice(lost));
    return listPinned(cwd);
  };
  const store = new OpenConversationsStore({ load: () => [], save: () => {}, seed: () => [], pins });
  assert.deepEqual(store.list().map((e) => e.id).sort(), ["call-only", "still-here"]);
  store.pinsChanged();
  const store2 = new OpenConversationsStore({ load: () => [], save: () => {}, seed: () => [], pins });
  assert.ok(store2);
  assert.equal(notices.length, 1, "said once, however often the pins are read");
  assert.match(notices[0], /Momentum Club funnel/);
});
