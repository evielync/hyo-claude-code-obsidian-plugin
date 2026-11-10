import { test } from "node:test";
import assert from "node:assert/strict";
import { ReadState } from "../src/read-state";
import { dockItems, overallState } from "../src/dock-state";
import { parseEntries } from "../src/open-conversations";

const memory = (start: string[] | null = null) => {
  let saved = start;
  return { io: { load: () => saved, save: (ids: string[]) => { saved = ids; } }, saved: () => saved };
};

test("a reply that finishes with nobody looking is unread until someone looks", () => {
  const m = memory();
  const rs = new ReadState(m.io);
  rs.replyFinished("a");
  assert.equal(rs.isUnread("a"), true);
  assert.deepEqual(m.saved(), ["a"]);
  rs.setViewing("dock", "a");
  assert.equal(rs.isUnread("a"), false);
  assert.deepEqual(m.saved(), []);
});

test("a reply you're watching arrive is read", () => {
  const rs = new ReadState(memory().io);
  rs.setViewing("panel", "a");
  rs.replyFinished("a");
  assert.equal(rs.isUnread("a"), false);
});

test("reading it in one view reads it everywhere, and looking away doesn't read the next one", () => {
  const rs = new ReadState(memory().io);
  rs.setViewing("panel", "b");
  rs.setViewing("phone:x", null);
  rs.replyFinished("a");
  assert.equal(rs.isUnread("a"), true);
  rs.setViewing("phone:x", "a");
  assert.equal(rs.isUnread("a"), false);
  rs.setViewing("phone:x", null);
  rs.replyFinished("a");
  assert.equal(rs.isUnread("a"), true);
});

test("a view that goes away stops counting as looking", () => {
  const rs = new ReadState(memory().io);
  rs.setViewing("phone:x", "a");
  rs.forget("phone:x");
  rs.replyFinished("a");
  assert.equal(rs.isUnread("a"), true);
});

test("unread survives a restart; nothing saved starts empty", () => {
  assert.equal(new ReadState(memory(["a"]).io).isUnread("a"), true);
  assert.deepEqual(new ReadState(memory(null).io).list(), []);
});

test("listeners hear each change", () => {
  const rs = new ReadState(memory().io);
  const heard: string[][] = [];
  rs.subscribe((u) => heard.push([...u]));
  rs.replyFinished("a");
  rs.replyFinished("a");
  rs.markRead("a");
  assert.deepEqual(heard, [["a"], []]);
});

const tab = (over: any = {}): any => ({
  id: "t1", cliSessionId: "s1", title: "Chat", messages: [], generating: false,
  model: "", effort: "", permissionMode: "", agent: "", inputTokens: 0, voiceMode: false, ...over,
});

test("the dock shows unread only when nothing louder is going on", () => {
  const [quiet] = dockItems([tab()], null, new Set(["s1"]));
  assert.equal(quiet.unread, true);
  assert.equal(quiet.status, "New reply");
  const [busy] = dockItems([tab({ generating: true })], null, new Set(["s1"]));
  assert.equal(busy.unread, false);
  assert.equal(overallState([quiet]), "unread");
});

test("the phone hears unread in the open list", () => {
  const [e] = parseEntries([{ id: "s1", title: "Chat", unread: true }]);
  assert.equal(e.unread, true);
  const [f] = parseEntries([{ id: "s1", title: "Chat" }]);
  assert.equal(f.unread, undefined);
});
