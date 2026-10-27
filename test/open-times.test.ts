// An open conversation's time is always a real one, never the current moment
// standing in for a time Hyo couldn't find.
import test from "node:test";
import assert from "node:assert/strict";
import { buildTaskList as desktopList, groupTasks } from "../src/task-state";
import { buildTaskList as phoneList } from "../src/mobile/task-state";

const now = Date.parse("2026-10-28T10:00:00");
const tab = (cliSessionId: string | null): any => ({ id: "t1", cliSessionId, title: "Old one", messages: [], generating: false });

for (const [name, build] of [["desktop", desktopList], ["phone", phoneList]] as const) {
  test(`${name}: an open conversation outside the loaded history shows no time, not "just now"`, () => {
    const [row] = (build as any)([tab("old-session")], [], {}, now);
    assert.equal(row.lastActive, 0);
  });

  test(`${name}: an open conversation takes its transcript's last write when given it`, () => {
    const at = Date.parse("2026-10-20T10:29:04");
    const [row] = (build as any)([tab("old-session")], [], {}, now, { "old-session": { lastActive: at } });
    assert.equal(row.lastActive, at);
  });

  test(`${name}: a brand-new conversation is "now"`, () => {
    const [row] = (build as any)([tab(null)], [], {}, now);
    assert.equal(row.lastActive, now);
  });
}

test("a conversation with no known time is grouped under Earlier, never Today", () => {
  const groups = groupTasks([{ pinned: false, lastActive: 0 }, { pinned: false, lastActive: now }], now);
  assert.deepEqual(groups.map((g) => g.label), ["Today", "Earlier"]);
});
