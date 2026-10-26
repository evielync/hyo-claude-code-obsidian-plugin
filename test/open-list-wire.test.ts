// The open list over a real WebSocket: the gateway's handler (gatewayOpenList,
// what gateway-host.ts runs for every phone message) on a real `ws` server,
// and the phone's real GatewayClient, PendingOps and reconcile on the other
// end, the way the phone's session manager wires them. The Mac's panel is a
// subscriber to the same store. What this doesn't run is React or Obsidian.
import test from "node:test";
import assert from "node:assert/strict";
import { WebSocketServer } from "ws";
import { GatewayClient } from "../src/mobile/gateway-client";
import {
  OpenConversationsStore,
  PendingOps,
  reconcileTabs,
  gatewayOpenList,
  gatewayOpenListGone,
  type OpenEntry,
  type PinnedEntry,
} from "../src/open-conversations";

interface Tab {
  id: string;
  cliSessionId: string | null;
  isMain?: boolean;
  title: string;
}
let n = 0;
const mk = (e: OpenEntry): Tab => ({ id: `t${++n}`, cliSessionId: e.id, title: e.title });
const blank = (): Tab => ({ id: `t${++n}`, cliSessionId: null, title: "New conversation" });
const main = (): Tab => ({ id: `main${++n}`, cliSessionId: "MAIN", isMain: true, title: "Main chat" });

/** A device: tabs, the one it's looking at, and how it applies a list. */
class Device {
  tabs: Tab[] = [main()];
  active = this.tabs[0].id;
  constructor(private pending?: PendingOps) {}
  apply(entries: OpenEntry[]) {
    const p = this.pending;
    const r = reconcileTabs(this.tabs, this.active, entries, mk, blank, {
      mainSessionId: "MAIN",
      blocksClose: p ? (s) => p.blocksClose(s) : undefined,
      blocksOpen: p ? (s) => p.blocksOpen(s) : undefined,
      blocksRetitle: p ? (s) => p.blocksRetitle(s) : undefined,
    });
    this.tabs = r.tabs;
    this.active = r.activeTabId;
  }
  open(sid: string) {
    if (this.tabs.some((t) => t.cliSessionId === sid)) return;
    const t = mk({ id: sid, title: `T ${sid}` });
    this.tabs.push(t);
    this.active = t.id;
  }
  close(sid: string) {
    this.tabs = this.tabs.filter((t) => t.cliSessionId !== sid);
    if (!this.tabs.some((t) => t.id === this.active)) this.active = this.tabs[0].id;
  }
  sids() {
    return this.tabs.filter((t) => !t.isMain).map((t) => t.cliSessionId);
  }
  activeSid() {
    const t = this.tabs.find((x) => x.id === this.active);
    return t?.isMain ? "main" : t?.cliSessionId;
  }
}

async function waitFor(what: string, pred: () => boolean, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.fail(`timed out waiting for: ${what}`);
}

test("open list over a real socket: open, close, races, pins and a reconnect", async (t) => {
  // The Mac.
  let pins: PinnedEntry[] = [];
  let saved: OpenEntry[] | null = [{ id: "a", title: "T a" }, { id: "b", title: "T b" }];
  const store = new OpenConversationsStore({
    load: () => saved,
    save: (e) => (saved = e),
    seed: () => [],
    pins: () => pins,
  });
  const mac = new Device();
  mac.apply(store.list());
  store.subscribe((e) => mac.apply(e));

  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((r) => server.once("listening", () => r()));
  const port = (server.address() as any).port;
  const sockets = new Set<any>();
  // Hold the server's replies while the test plays a race.
  let hold = false;
  const held: (() => void)[] = [];
  server.on("connection", (ws) => {
    sockets.add(ws);
    const send = (o: unknown) => {
      const go = () => ws.readyState === ws.OPEN && ws.send(JSON.stringify(o));
      if (hold) held.push(go);
      else go();
    };
    ws.on("message", (d) => {
      const m = JSON.parse(d.toString());
      if (m.type === "set_task_meta") {
        // What gateway-host does after saving a pin.
        pins = m.patch.pinned ? [...pins, { id: m.sessionId, title: m.sessionId, order: String(Date.now()) }] : pins.filter((p) => p.id !== m.sessionId);
        store.pinsChanged();
        return;
      }
      gatewayOpenList(store, m, ws, { send });
    });
    ws.on("close", () => {
      sockets.delete(ws);
      gatewayOpenListGone(ws);
    });
  });

  // The phone, wired as its session manager does it.
  const pending = new PendingOps();
  const phone = new Device(pending);
  const g = GatewayClient.get(`ws://127.0.0.1:${port}`);
  t.after(() => {
    g.destroy();
    for (const s of sockets) s.terminate();
    server.close();
  });
  let lists = 0;
  let watchY = false;
  let yFlickered = false;
  g.onOpenList((entries, meta) => {
    pending.settle(meta);
    lists++;
    phone.apply(entries);
    if (watchY && !phone.sids().includes("y")) yFlickered = true;
  });
  g.onConnected(() => g.openSync(pending.sync()));
  const tell = {
    open: (sid: string) => g.openAdd(sid, `T ${sid}`, pending.note(sid, "add")),
    close: (sid: string) => g.openRemove(sid, pending.note(sid, "remove")),
  };

  // 1. On connecting, the phone takes the Mac's list.
  await waitFor("first list", () => lists > 0);
  assert.deepEqual(phone.sids(), ["a", "b"]);

  // 2. Opened from History on the phone: the Mac's panel shows it.
  phone.open("x");
  tell.open("x");
  await waitFor("Mac has x", () => mac.sids().includes("x"));
  assert.deepEqual(mac.sids(), ["a", "b", "x"]);
  assert.equal(mac.activeSid(), "main", "the Mac keeps looking at what it was");
  assert.equal(phone.activeSid(), "x");

  // 3. Closed on the Mac while the phone is looking at it: the phone closes
  //    it and goes to the main chat.
  phone.active = phone.tabs.find((t) => t.cliSessionId === "a")!.id;
  mac.close("a");
  store.close("a");
  await waitFor("phone lost a", () => !phone.sids().includes("a"));
  assert.equal(phone.activeSid(), "main");

  // 4. A race: the phone opens y while a list from before the Mac saw it is
  //    in flight. The stale list doesn't close y; both end up with y and z.
  hold = true;
  store.open({ id: "z", title: "T z" }); // the Mac's list without y, held
  phone.open("y");
  tell.open("y");
  watchY = true;
  await new Promise((r) => setTimeout(r, 100)); // y reaches the Mac; its ack is held too
  hold = false;
  for (const go of held.splice(0)) go();
  await waitFor("both have y and z", () => phone.sids().join() === "b,x,z,y" && mac.sids().join() === "b,x,z,y");
  assert.equal(pending.size, 0, "everything confirmed");
  assert.equal(yFlickered, false, "y never vanished from the phone");
  assert.equal(phone.activeSid(), "y", "and the phone stayed on it");
  watchY = false;

  // 5. Pinned on the phone: first in both lists, flagged.
  g.setTaskMeta("z", { pinned: true });
  await waitFor("z pinned first on both", () => phone.sids()[0] === "z" && mac.sids()[0] === "z");

  // 6. Offline: the Mac closes b, the phone closes x. On reconnect they agree.
  for (const s of sockets) s.terminate();
  await waitFor("phone notices", () => g.getStatus() !== "connected");
  mac.close("b");
  store.close("b");
  phone.close("x");
  tell.close("x"); // queued until reconnect
  await waitFor("reconnected and agreed", () => g.getStatus() === "connected" && phone.sids().join() === "z,y" && mac.sids().join() === "z,y", 10000);
  assert.equal(pending.size, 0);
});
