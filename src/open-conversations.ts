/**
 * The conversations open on the Open side, shared by the Mac and the phone.
 *
 * The Mac owns the list, because the Mac owns the sessions. It lives in one
 * store per vault on the desktop (`OpenConversationsStore`), saved next to
 * the session metadata. Every Hyo panel on the Mac subscribes to it directly;
 * the gateway subscribes the phone's socket and pushes the whole list to it
 * whenever it changes (`open_list`), and the phone sends its own opens,
 * closes and renames back (`open_add` / `open_remove` / `open_rename` /
 * `open_replace`).
 *
 * What is shared is which conversations are open, in the order they were
 * opened, and their titles. What each device is looking at is its own: the
 * active conversation is never part of the list. The main chat is always
 * there on both and never in the list either. A new conversation joins the
 * list once it has a session id (its first message, or a call that minted
 * one); until then it is only on the device that made it.
 *
 * A device never echoes what it was told: opens and closes that come from
 * the list are applied silently. Only a person's own action (opening from
 * History, closing, renaming) or a conversation gaining its session id is
 * sent.
 *
 * This module holds no Obsidian or Node imports so it can be unit tested;
 * the desktop's file IO is passed in (see main.ts).
 */

export interface OpenEntry {
  /** The conversation's Claude session id. */
  id: string;
  title: string;
  /** Pinned: always open, listed first, and can't be closed until it's unpinned. */
  pinned?: boolean;
  /** Sent to the phone only: the conversation's last line, for its Open row. Never saved. */
  peek?: string;
  /** Sent to the phone only: when it was last active (epoch ms). Never saved. */
  lastActive?: number;
}

/** A pinned conversation, read from the shared session metadata. */
export interface PinnedEntry {
  id: string;
  title: string;
  /** Sorts pins in the order they were pinned (an ISO time; older pins fall back to their last activity). */
  order: string;
}

// ---- List operations ----------------------------------------------------------

function clean(entries: unknown): OpenEntry[] {
  if (!Array.isArray(entries)) return [];
  const seen = new Set<string>();
  const out: OpenEntry[] = [];
  for (const e of entries as any[]) {
    if (!e || typeof e.id !== "string" || !e.id || seen.has(e.id)) continue;
    seen.add(e.id);
    out.push({ id: e.id, title: typeof e.title === "string" && e.title ? e.title : "Untitled", ...(e.pinned === true ? { pinned: true } : {}) });
  }
  return out;
}

/** An open list as it arrives over the wire, checked (with the Mac's peek and last-active time). */
export function parseEntries(raw: unknown): OpenEntry[] {
  const byId = new Map<string, any>();
  if (Array.isArray(raw)) for (const e of raw as any[]) if (e && typeof e.id === "string") byId.set(e.id, e);
  return clean(raw).map((e) => {
    const r = byId.get(e.id);
    return {
      ...e,
      ...(typeof r?.peek === "string" && r.peek ? { peek: r.peek } : {}),
      ...(typeof r?.lastActive === "number" && isFinite(r.lastActive) ? { lastActive: r.lastActive } : {}),
    };
  });
}

/** Add a conversation at the end, or refresh its title if it's already open. */
export function withOpened(entries: OpenEntry[], e: OpenEntry): OpenEntry[] {
  const at = entries.findIndex((x) => x.id === e.id);
  if (at === -1) return [...entries, { id: e.id, title: e.title || "Untitled" }];
  if (!e.title || entries[at].title === e.title) return entries;
  return entries.map((x, i) => (i === at ? { ...x, title: e.title } : x));
}

export function withClosed(entries: OpenEntry[], id: string): OpenEntry[] {
  return entries.some((x) => x.id === id) ? entries.filter((x) => x.id !== id) : entries;
}

/** Rename an open conversation. A conversation that isn't open is left out. */
export function withRenamed(entries: OpenEntry[], id: string, title: string): OpenEntry[] {
  if (!title) return entries;
  const at = entries.findIndex((x) => x.id === id);
  if (at === -1 || entries[at].title === title) return entries;
  return entries.map((x, i) => (i === at ? { ...x, title } : x));
}

/** A conversation carried on under a new session id keeps its place. */
export function withReplaced(entries: OpenEntry[], oldId: string, e: OpenEntry): OpenEntry[] {
  const at = entries.findIndex((x) => x.id === oldId);
  if (at === -1) return withOpened(entries, e);
  const rest = entries.filter((x) => x.id !== e.id || x.id === oldId);
  const i = rest.findIndex((x) => x.id === oldId);
  return rest.map((x, j) => (j === i ? { id: e.id, title: e.title || x.title } : x));
}

function sameEntries(a: OpenEntry[], b: OpenEntry[]): boolean {
  return a.length === b.length && a.every((x, i) => x.id === b[i].id && x.title === b[i].title && !!x.pinned === !!b[i].pinned);
}

/** Pins in the order they were pinned; ties (and old pins with no time) by id, so the order is stable. */
export function sortPins(pins: PinnedEntry[]): PinnedEntry[] {
  return [...pins].sort((a, b) => (a.order || "").localeCompare(b.order || "") || a.id.localeCompare(b.id));
}

/**
 * The Open list as both devices show it: pinned conversations first, in the
 * order they were pinned, then the rest in the order they were opened. A
 * pinned conversation is there whether or not it was ever opened.
 */
export function effectiveList(opened: OpenEntry[], pins: PinnedEntry[]): OpenEntry[] {
  const titles = new Map(opened.map((e) => [e.id, e.title]));
  const pinnedIds = new Set<string>();
  const out: OpenEntry[] = [];
  for (const p of sortPins(pins)) {
    if (!p.id || pinnedIds.has(p.id)) continue;
    pinnedIds.add(p.id);
    out.push({ id: p.id, title: titles.get(p.id) || p.title || "Untitled", pinned: true });
  }
  for (const e of opened) if (!pinnedIds.has(e.id)) out.push({ id: e.id, title: e.title });
  return out;
}

// ---- The Mac's store ----------------------------------------------------------

export interface StoreIO {
  /** The saved list of opened conversations, or null when there isn't one yet (or it can't be read). */
  load(): OpenEntry[] | null;
  save(entries: OpenEntry[]): void;
  /** What to start from on first run: the desktop's open tabs from before this was shared. */
  seed(): OpenEntry[];
  /** The pinned conversations, from the shared session metadata (pins live there, not here). */
  pins?(): PinnedEntry[];
  /** Saving failed. The list stays right in memory until Obsidian closes. */
  onSaveError?(error: unknown): void;
}

/** Who made a change, handed back to listeners (the gateway uses it to acknowledge). */
export type ChangeOrigin = unknown;
export type OpenListener = (entries: OpenEntry[], origin?: ChangeOrigin) => void;

export class OpenConversationsStore {
  // What has been opened, in order (saved). Pins are kept apart, read from
  // the session metadata, and put first by list().
  private opened: OpenEntry[];
  private pins: PinnedEntry[] = [];
  private shown: OpenEntry[] = [];
  private listeners = new Set<OpenListener>();

  constructor(private io: StoreIO) {
    const saved = io.load();
    if (saved === null) {
      this.opened = clean(io.seed()).map(({ id, title }) => ({ id, title }));
      this.persist();
    } else {
      this.opened = clean(saved).map(({ id, title }) => ({ id, title }));
    }
    this.pins = this.readPins();
    this.shown = effectiveList(this.opened, this.pins);
  }

  /** The Open list: pins first, in pin order, then the rest in the order they were opened. */
  list(): OpenEntry[] {
    return this.shown;
  }

  open(e: OpenEntry, origin?: ChangeOrigin): void {
    if (!e?.id) return;
    this.commit(withOpened(this.opened, e), origin);
  }

  /** Close a conversation. A pinned one stays in the list until it's unpinned. */
  close(id: string, origin?: ChangeOrigin): void {
    this.commit(withClosed(this.opened, id), origin);
  }

  rename(id: string, title: string, origin?: ChangeOrigin): void {
    if (title) this.pins = this.pins.map((p) => (p.id === id ? { ...p, title } : p));
    this.commit(withRenamed(this.opened, id, title), origin);
  }

  replace(oldId: string, e: OpenEntry, origin?: ChangeOrigin): void {
    if (!e?.id) return;
    this.commit(withReplaced(this.opened, oldId, e), origin);
  }

  /**
   * A pin changed in the session metadata: read the pins again. A
   * conversation that was unpinned is open only if it's among the opened
   * ones: unpinning closes it, unless the device that unpinned it is looking
   * at it, and that device opens it first (see the session managers).
   */
  pinsChanged(origin?: ChangeOrigin): void {
    this.pins = this.readPins();
    this.commit(this.opened, origin);
  }

  private readPins(): PinnedEntry[] {
    if (!this.io.pins) return [];
    try {
      return sortPins(this.io.pins().filter((p) => p && typeof p.id === "string" && p.id));
    } catch (e) {
      console.error("[hyo] Couldn't read the pinned conversations:", e);
      return this.pins;
    }
  }

  /** Hear every change. Returns the unsubscribe. */
  subscribe(fn: OpenListener): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  get subscribers(): number {
    return this.listeners.size;
  }

  private commit(next: OpenEntry[], origin: ChangeOrigin): void {
    if (!sameEntries(next, this.opened)) {
      this.opened = next;
      this.persist();
    }
    const shown = effectiveList(this.opened, this.pins);
    if (!sameEntries(shown, this.shown)) this.shown = shown;
    // Told even when nothing changed, so whoever asked hears back.
    for (const l of [...this.listeners]) {
      try {
        l(this.shown, origin);
      } catch (e) {
        console.error("[hyo] An open-conversations listener failed:", e);
      }
    }
  }

  private persist(): void {
    try {
      this.io.save(this.opened);
    } catch (e) {
      console.error("[hyo] Couldn't save the open conversations:", e);
      this.io.onSaveError?.(e);
    }
  }
}

/** The store's file, beside session-metadata.json in Claude's project folder. */
export const OPEN_LIST_FILE = "hyo-open-conversations.json";

// One store per vault on this Mac, made by the plugin's factory (desktop only).
const stores = new Map<string, OpenConversationsStore>();
let makeStore: ((cwd: string) => OpenConversationsStore) | null = null;

export function setOpenConversationsFactory(make: ((cwd: string) => OpenConversationsStore) | null): void {
  makeStore = make;
  stores.clear();
}

export function openConversations(cwd: string): OpenConversationsStore | null {
  let s = stores.get(cwd);
  if (!s && makeStore) {
    s = makeStore(cwd);
    stores.set(cwd, s);
  }
  return s || null;
}

/** The desktop's open tabs as they were kept before this list was shared. */
export function legacyDesk(raw: string | null): OpenEntry[] {
  try {
    const saved = JSON.parse(raw || "null");
    return clean(saved?.sessions);
  } catch {
    return [];
  }
}

// ---- Matching a device's tabs to the list ------------------------------------

export interface SyncTab {
  id: string;
  cliSessionId: string | null;
  isMain?: boolean;
  title: string;
}

/** A tab that belongs in the shared list: has a session, and isn't the main chat. */
export function syncedSid(t: SyncTab, mainSessionId?: string): string | null {
  if (!t.cliSessionId || t.isMain) return null;
  if (mainSessionId && t.cliSessionId === mainSessionId) return null;
  return t.cliSessionId;
}

export interface SyncChanges {
  /** Each tab's synced session id now, for the next comparison. */
  next: Map<string, string | null>;
  /** Tabs that gained a session id (or moved to a new one) since last time. */
  gained: { tabId: string; sid: string; title: string; oldSid: string | null }[];
  /** Session ids a still-open tab let go of (a new conversation in the same tab). */
  cleared: string[];
}

/**
 * What changed on this device that the list needs to hear about. Only tabs
 * that were already here count: a tab that's new since last time was opened
 * either by the person (sent when they opened it) or from the list itself
 * (never echoed), and a tab that's gone was closed the same two ways.
 */
export function syncChanges(prev: Map<string, string | null>, tabs: SyncTab[], mainSessionId?: string): SyncChanges {
  const next = new Map<string, string | null>();
  const gained: SyncChanges["gained"] = [];
  const cleared: string[] = [];
  for (const t of tabs) {
    const sid = syncedSid(t, mainSessionId);
    next.set(t.id, sid);
    if (!prev.has(t.id)) continue;
    const was = prev.get(t.id) ?? null;
    if (sid === was) continue;
    if (sid) gained.push({ tabId: t.id, sid, title: t.title, oldSid: was });
    else if (was) cleared.push(was);
  }
  return { next, gained, cleared };
}

export interface ReconcileOptions<T extends SyncTab> {
  /** With the main chat on, its conversation never opens as a second tab. */
  mainSessionId?: string;
  /** Work running in the tab (a turn, background jobs, queued messages): a close waits for it. */
  busy?: (t: T) => boolean;
  /** The phone's own changes the Mac hasn't confirmed yet (see PendingOps). */
  blocksClose?: (sid: string) => boolean;
  blocksOpen?: (sid: string) => boolean;
  blocksRetitle?: (sid: string) => boolean;
}

export interface ReconcileResult<T> {
  tabs: T[];
  activeTabId: string;
  changed: boolean;
  /** Tabs taken off this device: the caller lets go of their processes. */
  closed: T[];
  /** Tabs added from the list: the caller loads their history if it needs to. */
  opened: T[];
}

/**
 * Bring a device's tabs in line with the shared list. Closes synced tabs the
 * list no longer has (not while work is running in them), opens what it has
 * that this device doesn't, takes its titles, and orders the tabs: the main
 * chat, then the list's order, then anything only this device has yet.
 *
 * If the conversation being looked at is closed, this device moves to the
 * main chat, or the next tab along, or a fresh conversation. Nothing in a
 * closed conversation is lost: it's in History, saved by Claude as it went.
 */
export function reconcileTabs<T extends SyncTab>(
  tabs: T[],
  activeTabId: string,
  entries: OpenEntry[],
  make: (e: OpenEntry) => T,
  blank: () => T,
  opts: ReconcileOptions<T> = {}
): ReconcileResult<T> {
  const listed = new Map(entries.map((e, i) => [e.id, i]));
  const closed: T[] = [];
  let changed = false;

  // Close what the list let go of, and take its titles.
  let kept: T[] = [];
  for (const t of tabs) {
    const sid = syncedSid(t, opts.mainSessionId);
    if (sid && !listed.has(sid)) {
      if (!opts.blocksClose?.(sid) && !opts.busy?.(t)) {
        closed.push(t);
        changed = true;
        continue;
      }
    }
    if (sid && listed.has(sid) && !opts.blocksRetitle?.(sid)) {
      const title = entries[listed.get(sid)!].title;
      if (title && title !== t.title) {
        kept.push({ ...t, title });
        changed = true;
        continue;
      }
    }
    kept.push(t);
  }

  // Open what this device doesn't have yet.
  const have = new Set(kept.map((t) => t.cliSessionId).filter(Boolean) as string[]);
  const opened: T[] = [];
  for (const e of entries) {
    if (have.has(e.id)) continue;
    if (opts.mainSessionId && e.id === opts.mainSessionId) continue;
    if (opts.blocksOpen?.(e.id)) continue;
    const t = make(e);
    opened.push(t);
    have.add(e.id);
  }
  if (opened.length) changed = true;
  kept = [...kept, ...opened];

  // Order: main chat, the list's order, then this device's own.
  const rank = (t: T): number => {
    if (t.isMain) return -1;
    const sid = syncedSid(t, opts.mainSessionId);
    if (sid && listed.has(sid)) return listed.get(sid)!;
    return entries.length;
  };
  const ordered = kept
    .map((t, i) => ({ t, i, r: rank(t) }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.t);
  if (!changed && ordered.some((t, i) => t !== tabs[i])) changed = true;
  if (!changed) return { tabs, activeTabId, changed: false, closed, opened };

  // The conversation in view was closed elsewhere: move somewhere sensible.
  let active = activeTabId;
  let result = ordered;
  if (!result.some((t) => t.id === active)) {
    const main = result.find((t) => t.isMain);
    if (main) active = main.id;
    else if (result.length) {
      const was = tabs.findIndex((t) => t.id === activeTabId);
      active = result[Math.max(0, Math.min(was, result.length - 1))].id;
    } else {
      const fresh = blank();
      result = [fresh];
      active = fresh.id;
    }
  }
  return { tabs: result, activeTabId: active, changed: true, closed, opened };
}

// ---- The phone's unconfirmed changes -------------------------------------------

type OpKind = "add" | "remove" | "rename";

/**
 * Changes the phone has sent that the Mac hasn't confirmed. A list that
 * arrives in between was sent before the Mac saw them, so it mustn't undo
 * them on screen: a conversation just opened isn't closed by it, one just
 * closed isn't reopened, a new title isn't put back.
 *
 * The Mac confirms each change by number (`ack`). A list asked for with a
 * number (`sync`) is the whole truth for everything sent before it, so a
 * change whose confirmation was lost to a dropped connection is let go then.
 */
export class PendingOps {
  private seq = 0;
  private pending = new Map<string, Partial<Record<OpKind, number>>>();

  /** Note a change about to be sent; returns its number. */
  note(sid: string, kind: OpKind): number {
    const op = ++this.seq;
    const p = { ...(this.pending.get(sid) || {}) };
    if (kind === "add") delete p.remove;
    if (kind === "remove") {
      delete p.add;
      delete p.rename;
    }
    p[kind] = op;
    this.pending.set(sid, p);
    return op;
  }

  /** A number for a full-list request. */
  sync(): number {
    return ++this.seq;
  }

  /** A list arrived: let go of whatever it confirms. */
  settle(meta: { ack?: number; sync?: number }): void {
    for (const [sid, p] of [...this.pending]) {
      for (const k of Object.keys(p) as OpKind[]) {
        const op = p[k]!;
        if ((meta.ack !== undefined && op === meta.ack) || (meta.sync !== undefined && op < meta.sync)) delete p[k];
      }
      if (!Object.keys(p).length) this.pending.delete(sid);
    }
  }

  blocksClose(sid: string): boolean {
    return this.pending.get(sid)?.add !== undefined;
  }

  blocksOpen(sid: string): boolean {
    return this.pending.get(sid)?.remove !== undefined;
  }

  blocksRetitle(sid: string): boolean {
    const p = this.pending.get(sid);
    return !!p && (p.rename !== undefined || p.add !== undefined);
  }

  get size(): number {
    return this.pending.size;
  }
}

// ---- The gateway's side --------------------------------------------------------

export interface OpenListSink {
  send: (obj: unknown) => void;
}

/** Each phone socket's subscription to the store, and a way to send it the list again. */
const phoneSubs = new Map<object, { off: () => void; push: () => void }>();

/**
 * A phone message about the open list. Subscribes the socket on first
 * contact, so every later change reaches it as `open_list`. Each change is
 * acknowledged to the phone that made it with its number. Returns false for
 * a message that isn't about the open list.
 */
export function gatewayOpenList(
  store: OpenConversationsStore,
  m: any,
  ws: object,
  sink: OpenListSink,
  // What the phone's rows show besides the title (its last line, when it was last active).
  decorate: (entries: OpenEntry[]) => OpenEntry[] = (e) => e
): boolean {
  const type = m?.type;
  if (typeof type !== "string" || !type.startsWith("open_")) return false;
  const shown = (entries: OpenEntry[]): OpenEntry[] => {
    try {
      return decorate(entries);
    } catch (e) {
      console.error("[hyo] Couldn't add the last lines to the open list:", e);
      return entries;
    }
  };
  if (!phoneSubs.has(ws)) {
    const off = store.subscribe((entries, origin: any) => {
      sink.send({
        type: "open_list",
        entries: shown(entries),
        ...(origin && origin.ws === ws && typeof origin.opId === "number" ? { ack: origin.opId } : {}),
      });
    });
    phoneSubs.set(ws, { off, push: () => sink.send({ type: "open_list", entries: shown(store.list()) }) });
  }
  const origin = { ws, opId: typeof m.opId === "number" ? m.opId : undefined };
  const title = typeof m.title === "string" ? m.title : "";
  switch (type) {
    case "open_list":
      sink.send({ type: "open_list", entries: shown(store.list()), ...(typeof m.requestId === "number" ? { sync: m.requestId } : {}) });
      return true;
    case "open_add":
      if (typeof m.id === "string") store.open({ id: m.id, title }, origin);
      return true;
    case "open_remove":
      if (typeof m.id === "string") store.close(m.id, origin);
      return true;
    case "open_rename":
      if (typeof m.id === "string") store.rename(m.id, title, origin);
      return true;
    case "open_replace":
      if (typeof m.oldId === "string" && typeof m.id === "string") store.replace(m.oldId, { id: m.id, title }, origin);
      return true;
  }
  return false;
}

/** The phone's socket closed: stop pushing to it. */
export function gatewayOpenListGone(ws: object): void {
  phoneSubs.get(ws)?.off();
  phoneSubs.delete(ws);
}

/** Send every phone the list again (a turn ended, so a row's last line moved on). */
export function gatewayOpenListRefresh(): void {
  for (const p of phoneSubs.values()) {
    try {
      p.push();
    } catch (e) {
      console.error("[hyo] Couldn't refresh the phone's open list:", e);
    }
  }
}

/** The gateway stopped: drop every phone's subscription. */
export function gatewayOpenListReset(): void {
  for (const p of phoneSubs.values()) p.off();
  phoneSubs.clear();
}
