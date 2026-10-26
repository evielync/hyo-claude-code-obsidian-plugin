import test from "node:test";
import assert from "node:assert/strict";
import {
  OpenConversationsStore,
  PendingOps,
  reconcileTabs,
  syncChanges,
  effectiveList,
  legacyDesk,
  withReplaced,
  gatewayOpenList,
  gatewayOpenListGone,
  type OpenEntry,
  type PinnedEntry,
  type StoreIO,
} from "../src/open-conversations";

// ---- helpers -----------------------------------------------------------------

interface Tab {
  id: string;
  cliSessionId: string | null;
  isMain?: boolean;
  title: string;
  generating?: boolean;
}

let n = 0;
const tab = (sid: string | null, extra: Partial<Tab> = {}): Tab => ({ id: `t${++n}`, cliSessionId: sid, title: sid ? `T ${sid}` : "New conversation", ...extra });
const main = (): Tab => ({ id: "main", cliSessionId: "MAIN", isMain: true, title: "Main chat" });
const fromEntry = (e: OpenEntry): Tab => ({ id: `t${++n}`, cliSessionId: e.id, title: e.title });
const blank = (): Tab => tab(null);
const sids = (tabs: Tab[]) => tabs.map((t) => (t.isMain ? "main" : t.cliSessionId || "(new)"));

function memIO(initial: OpenEntry[] | null, seed: OpenEntry[] = [], pins: PinnedEntry[] = []) {
  const io = {
    saved: initial as OpenEntry[] | null,
    saves: 0,
    pinsNow: pins,
    load: () => io.saved,
    save: (e: OpenEntry[]) => {
      io.saved = e;
      io.saves++;
    },
    seed: () => seed,
    pins: () => io.pinsNow,
  };
  return io;
}

// ---- the store -----------------------------------------------------------------

test("first run seeds from the desktop's old open tabs, then never again", () => {
  const raw = JSON.stringify({ sessions: [{ id: "a", title: "Alpha" }, { id: "b", title: "Beta" }], activeId: "b" });
  const io = memIO(null, legacyDesk(raw));
  const store = new OpenConversationsStore(io);
  assert.deepEqual(store.list().map((e) => e.id), ["a", "b"]);
  assert.deepEqual(io.saved!.map((e) => e.id), ["a", "b"], "the seed is saved at once");

  // An existing (even empty) list is never reseeded.
  const again = new OpenConversationsStore(memIO([], legacyDesk(raw)));
  assert.deepEqual(again.list(), []);
});

test("legacyDesk survives junk", () => {
  assert.deepEqual(legacyDesk(null), []);
  assert.deepEqual(legacyDesk("{not json"), []);
  assert.deepEqual(legacyDesk(JSON.stringify({ sessions: [{ id: "a" }, { nope: 1 }, { id: "a" }] })), [{ id: "a", title: "Untitled" }]);
});

test("opens and closes reach every listener, saved, in the order opened", () => {
  const io = memIO([]);
  const store = new OpenConversationsStore(io);
  const heard: string[][] = [];
  store.subscribe((e) => heard.push(e.map((x) => x.id)));
  store.open({ id: "a", title: "A" });
  store.open({ id: "b", title: "B" });
  store.open({ id: "a", title: "A" }); // already open: no change, still answered
  store.close("a");
  assert.deepEqual(heard, [["a"], ["a", "b"], ["a", "b"], ["b"]]);
  assert.deepEqual(io.saved, [{ id: "b", title: "B" }]);
});

test("a rename travels with the list; a session id change keeps its place", () => {
  const store = new OpenConversationsStore(memIO([{ id: "a", title: "A" }, { id: "b", title: "B" }, { id: "c", title: "C" }]));
  store.rename("b", "Better");
  store.rename("zzz", "not open"); // not open: ignored
  assert.deepEqual(store.list().map((e) => e.title), ["A", "Better", "C"]);
  store.replace("b", { id: "b2", title: "Better" });
  assert.deepEqual(store.list().map((e) => e.id), ["a", "b2", "c"]);
  assert.deepEqual(withReplaced([{ id: "x", title: "X" }], "missing", { id: "y", title: "Y" }).map((e) => e.id), ["x", "y"]);
});

test("a save that fails is said, and the list carries on in memory", () => {
  let told: unknown = null;
  const io: StoreIO = {
    load: () => [],
    save: () => {
      throw new Error("disk full");
    },
    seed: () => [],
    onSaveError: (e) => (told = e),
  };
  const err = console.error;
  console.error = () => {};
  try {
    const store = new OpenConversationsStore(io);
    store.open({ id: "a", title: "A" });
    assert.equal((told as Error).message, "disk full");
    assert.deepEqual(store.list().map((e) => e.id), ["a"]);
  } finally {
    console.error = err;
  }
});

// ---- pins ------------------------------------------------------------------------

test("pins come first, in the order they were pinned, then the rest as opened", () => {
  const list = effectiveList(
    [
      { id: "a", title: "A" },
      { id: "b", title: "B (renamed)" },
      { id: "c", title: "C" },
    ],
    [
      { id: "p2", title: "Second pin", order: "2026-10-02T00:00:00Z" },
      { id: "b", title: "B", order: "2026-10-01T00:00:00Z" },
      { id: "old", title: "Old pin, no time", order: "" },
    ]
  );
  assert.deepEqual(
    list.map((e) => [e.id, !!e.pinned]),
    [
      ["old", true],
      ["b", true],
      ["p2", true],
      ["a", false],
      ["c", false],
    ]
  );
  // The opened title (a rename) wins over the metadata's.
  assert.equal(list[1].title, "B (renamed)");
});

test("a pinned conversation is in the list without ever being opened, and can't be closed off it", () => {
  const io = memIO([{ id: "a", title: "A" }], [], [{ id: "p", title: "Pinned elsewhere", order: "1" }]);
  const store = new OpenConversationsStore(io);
  assert.deepEqual(store.list().map((e) => e.id), ["p", "a"]);
  store.close("p");
  assert.deepEqual(store.list().map((e) => e.id), ["p", "a"], "still there while pinned");
});

test("pinning moves a conversation to the pins; unpinning leaves it open as an ordinary row", () => {
  const io = memIO([{ id: "a", title: "A" }, { id: "b", title: "B" }]);
  const store = new OpenConversationsStore(io);
  const heard: string[] = [];
  store.subscribe((e) => heard.push(e.map((x) => `${x.id}${x.pinned ? "*" : ""}`).join(",")));

  io.pinsNow = [{ id: "b", title: "B", order: "1" }];
  store.pinsChanged();
  assert.equal(heard.pop(), "b*,a");

  // Pinned on the other device, never opened here.
  io.pinsNow = [{ id: "b", title: "B", order: "1" }, { id: "q", title: "Q", order: "2" }];
  store.pinsChanged();
  assert.equal(heard.pop(), "b*,q*,a");

  // Unpin b: back where it was opened. Unpin q: stays open, at the end.
  io.pinsNow = [];
  store.pinsChanged();
  assert.equal(heard.pop(), "a,b,q");
  assert.deepEqual(io.saved!.map((e) => e.id), ["a", "b", "q"]);
});

// ---- a device's tabs against the list ----------------------------------------------

test("a conversation opened elsewhere appears; one closed elsewhere goes", () => {
  const a = tab("a");
  const b = tab("b");
  const tabs = [main(), a, b];
  const r = reconcileTabs(tabs, a.id, [{ id: "a", title: "T a" }, { id: "c", title: "Cee" }], fromEntry, blank);
  assert.deepEqual(sids(r.tabs), ["main", "a", "c"]);
  assert.deepEqual(r.closed.map((t) => t.cliSessionId), ["b"]);
  assert.deepEqual(r.opened.map((t) => t.cliSessionId), ["c"]);
  assert.equal(r.activeTabId, a.id, "what this device is looking at doesn't change");
});

test("nothing to do returns the same tabs untouched", () => {
  const a = tab("a");
  const tabs = [main(), a];
  const r = reconcileTabs(tabs, a.id, [{ id: "a", title: "T a" }], fromEntry, blank);
  assert.equal(r.changed, false);
  assert.equal(r.tabs, tabs);
});

test("the conversation each device is looking at is its own", () => {
  // Two devices, same list, different active tabs: reconciling never moves either.
  const list = [{ id: "a", title: "T a" }, { id: "b", title: "T b" }];
  const mac = [main(), tab("a"), tab("b")];
  const phone = [main(), tab("a"), tab("b")];
  const rm = reconcileTabs(mac, mac[1].id, [...list, { id: "c", title: "C" }], fromEntry, blank);
  const rp = reconcileTabs(phone, phone[2].id, [...list, { id: "c", title: "C" }], fromEntry, blank);
  assert.equal(rm.activeTabId, mac[1].id);
  assert.equal(rp.activeTabId, phone[2].id);
});

test("a new conversation with no session id yet stays on its own device", () => {
  const fresh = tab(null, { title: "Thinking about…" });
  const r = reconcileTabs([main(), tab("a"), fresh], fresh.id, [{ id: "a", title: "T a" }, { id: "b", title: "B" }], fromEntry, blank);
  assert.ok(r.tabs.includes(fresh), "kept");
  assert.deepEqual(sids(r.tabs), ["main", "a", "b", "(new)"], "after the list's conversations");
  assert.equal(r.activeTabId, fresh.id);
});

test("the conversation in view closed elsewhere: falls back to the main chat", () => {
  const a = tab("a");
  const r = reconcileTabs([main(), tab("x"), a], a.id, [{ id: "x", title: "T x" }], fromEntry, blank);
  assert.equal(r.activeTabId, "main");
  assert.deepEqual(sids(r.tabs), ["main", "x"]);
});

test("without a main chat it falls back to the next tab, or a fresh conversation", () => {
  const a = tab("a");
  const b = tab("b");
  const r = reconcileTabs([a, b], b.id, [{ id: "a", title: "T a" }], fromEntry, blank);
  assert.equal(r.activeTabId, a.id);
  const only = tab("z");
  const r2 = reconcileTabs([only], only.id, [], fromEntry, blank);
  assert.equal(r2.tabs.length, 1);
  assert.equal(r2.tabs[0].cliSessionId, null);
  assert.equal(r2.activeTabId, r2.tabs[0].id);
});

test("a close waits while work is running in the tab", () => {
  const busy = tab("a", { generating: true });
  const r = reconcileTabs([main(), busy], busy.id, [], fromEntry, blank, { busy: (t) => !!t.generating });
  assert.ok(r.tabs.includes(busy));
  assert.equal(r.closed.length, 0);
  const done = { ...busy, generating: false };
  const r2 = reconcileTabs([main(), done], done.id, [], fromEntry, blank, { busy: (t) => !!t.generating });
  assert.deepEqual(r2.closed.map((t) => t.cliSessionId), ["a"]);
  assert.equal(r2.activeTabId, "main");
});

test("the main chat's conversation is never opened as a second tab, nor closed", () => {
  const m = main();
  const r = reconcileTabs([m], m.id, [{ id: "MAIN", title: "Main chat" }], fromEntry, blank, { mainSessionId: "MAIN" });
  assert.equal(r.changed, false);
  // Nor is the main chat's tab ever closed for not being in the list.
  const r2 = reconcileTabs([m], m.id, [], fromEntry, blank, { mainSessionId: "MAIN" });
  assert.equal(r2.changed, false);
});

test("titles come from the list, and tabs follow its order (pins first)", () => {
  const a = tab("a");
  const p = tab("p");
  const r = reconcileTabs([main(), a, p], a.id, [{ id: "p", title: "Pinned", pinned: true }, { id: "a", title: "Renamed on the Mac" }], fromEntry, blank);
  assert.deepEqual(sids(r.tabs), ["main", "p", "a"]);
  assert.equal(r.tabs.find((t) => t.cliSessionId === "a")!.title, "Renamed on the Mac");
});

// ---- what a device tells the list ------------------------------------------------------

test("a tab that gets its session id joins the list; opened and closed tabs don't count", () => {
  const fresh = tab(null);
  const kept = tab("k");
  let prev = syncChanges(new Map(), [main(), fresh, kept], "MAIN").next;
  assert.equal(prev.get("main"), null, "the main chat is never the list's");

  const sent = { ...fresh, cliSessionId: "new-sid", title: "First message" };
  const opened = tab("from-history");
  const ch = syncChanges(prev, [main(), sent, opened], "MAIN");
  assert.deepEqual(ch.gained, [{ tabId: fresh.id, sid: "new-sid", title: "First message", oldSid: null }]);
  assert.deepEqual(ch.cleared, [], "the closed tab k isn't reported here");
  prev = ch.next;

  // An agent switch starts a new conversation in the same tab.
  const ch2 = syncChanges(prev, [main(), { ...sent, cliSessionId: null }, opened], "MAIN");
  assert.deepEqual(ch2.cleared, ["new-sid"]);
  // A forked session id.
  const ch3 = syncChanges(prev, [main(), { ...sent, cliSessionId: "forked" }, opened], "MAIN");
  assert.equal(ch3.gained[0].oldSid, "new-sid");
});

// ---- the phone's unconfirmed changes -----------------------------------------------------

test("a list sent before the Mac saw the phone's change doesn't undo it", () => {
  const p = new PendingOps();
  const openOp = p.note("x", "add");
  assert.ok(p.blocksClose("x"));
  p.settle({ ack: openOp + 100 });
  assert.ok(p.blocksClose("x"), "someone else's ack doesn't count");
  p.settle({ ack: openOp });
  assert.ok(!p.blocksClose("x"));

  const closeOp = p.note("y", "remove");
  assert.ok(p.blocksOpen("y"));
  p.settle({ ack: closeOp });
  assert.ok(!p.blocksOpen("y"));

  p.note("z", "rename");
  assert.ok(p.blocksRetitle("z"));
});

test("a full list asked for after a reconnect settles everything sent before it", () => {
  const p = new PendingOps();
  p.note("a", "add"); // its ack was lost with the old connection
  const sync = p.sync();
  const later = p.note("b", "add");
  p.settle({ sync });
  assert.ok(!p.blocksClose("a"));
  assert.ok(p.blocksClose("b"), "sent after the request: still waiting");
  p.settle({ ack: later });
  assert.equal(p.size, 0);
});

test("reconcile honours the phone's pending changes", () => {
  const x = tab("x");
  const p = new PendingOps();
  p.note("x", "add");
  p.note("gone", "remove");
  const r = reconcileTabs([main(), x], x.id, [{ id: "gone", title: "G" }], fromEntry, blank, {
    blocksClose: (s) => p.blocksClose(s),
    blocksOpen: (s) => p.blocksOpen(s),
  });
  assert.ok(r.tabs.includes(x), "just opened here: not closed by a stale list");
  assert.ok(!r.tabs.some((t) => t.cliSessionId === "gone"), "just closed here: not reopened");
});

// ---- the gateway -------------------------------------------------------------------------

test("the gateway subscribes the phone, acknowledges its changes and pushes the Mac's", () => {
  const store = new OpenConversationsStore(memIO([{ id: "a", title: "A" }]));
  const ws = {};
  const out: any[] = [];
  const sink = { send: (o: unknown) => out.push(o) };

  assert.equal(gatewayOpenList(store, { type: "prompt" }, ws, sink), false);
  assert.ok(gatewayOpenList(store, { type: "open_list", requestId: 7 }, ws, sink));
  assert.deepEqual(out.pop(), { type: "open_list", entries: [{ id: "a", title: "A" }], sync: 7 });

  gatewayOpenList(store, { type: "open_add", id: "b", title: "B", opId: 8 }, ws, sink);
  assert.deepEqual(out.pop(), { type: "open_list", entries: [{ id: "a", title: "A" }, { id: "b", title: "B" }], ack: 8 });

  // A change on the Mac reaches the phone, unacknowledged.
  store.close("a");
  assert.deepEqual(out.pop(), { type: "open_list", entries: [{ id: "b", title: "B" }] });

  gatewayOpenListGone(ws);
  store.open({ id: "c", title: "C" });
  assert.equal(out.length, 0, "nothing after the phone has gone");
});
