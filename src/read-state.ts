// Unread replies, shared by every view of a conversation on this Mac and the
// phone.
//
// A conversation is unread when a reply finished while nobody had it on
// screen. Opening it anywhere (the side panel, the dock's pop-up, the phone)
// reads it everywhere. "On screen" is reported by each view: the panel only
// while its leaf is showing, the dock only while its pop-up is open, the
// phone only while the app is in front.
//
// Kept apart from "needs you" (an approval, question or plan waiting on an
// answer), which is louder: a finished reply is something to read, not
// something holding the agent up.
//
// The Mac keeps the list (it sees every reply finish, through the
// conversation's owner in session-owner.ts) and saves it next to the open
// list, so a reply stays unread across a restart until it's looked at. It
// starts empty: conversations that finished before this existed are read.
//
// No Obsidian or Node imports, so it can be unit tested; the file IO is
// passed in (see main.ts).

export interface ReadStateIO {
  /** The saved unread conversation ids, or null when there are none saved yet. */
  load(): string[] | null;
  save(ids: string[]): void;
}

export type UnreadListener = (unread: ReadonlySet<string>) => void;

export class ReadState {
  private unread: Set<string>;
  // What each view has on screen right now, by view id (null: nothing).
  private viewing = new Map<string, string | null>();
  private listeners = new Set<UnreadListener>();

  constructor(private io: ReadStateIO) {
    let saved: string[] | null = null;
    try {
      saved = io.load();
    } catch (e) {
      console.error("[hyo] Couldn't read the unread conversations:", e);
    }
    this.unread = new Set((saved || []).filter((x) => typeof x === "string" && x));
  }

  isUnread(sessionId: string | null | undefined): boolean {
    return !!sessionId && this.unread.has(sessionId);
  }

  /** The unread conversation ids. */
  list(): string[] {
    return [...this.unread];
  }

  /** Someone has this conversation on screen. */
  isViewed(sessionId: string): boolean {
    for (const v of this.viewing.values()) if (v === sessionId) return true;
    return false;
  }

  /** A view reports what it has on screen (null: nothing). What it shows is read. */
  setViewing(viewId: string, sessionId: string | null): void {
    if (this.viewing.get(viewId) === sessionId) return;
    this.viewing.set(viewId, sessionId);
    if (sessionId) this.markRead(sessionId);
  }

  /** A view went away (the panel closed, the phone disconnected). */
  forget(viewId: string): void {
    this.viewing.delete(viewId);
  }

  /** A reply finished. Unread unless someone is looking at it. */
  replyFinished(sessionId: string | null | undefined): void {
    if (!sessionId || this.isViewed(sessionId) || this.unread.has(sessionId)) return;
    this.unread.add(sessionId);
    this.changed();
  }

  markRead(sessionId: string): void {
    if (!this.unread.delete(sessionId)) return;
    this.changed();
  }

  /** A conversation carried on under a new session id stays unread under it. */
  replace(oldId: string, newId: string): void {
    if (!this.unread.delete(oldId)) return;
    if (!this.isViewed(newId)) this.unread.add(newId);
    this.changed();
  }

  subscribe(fn: UnreadListener): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  private changed(): void {
    try {
      this.io.save(this.list());
    } catch (e) {
      console.error("[hyo] Couldn't save the unread conversations:", e);
    }
    const snapshot: ReadonlySet<string> = new Set(this.unread);
    for (const l of [...this.listeners]) {
      try {
        l(snapshot);
      } catch (e) {
        console.error("[hyo] An unread listener failed:", e);
      }
    }
  }
}

/** The file it's saved in, beside the open list in Claude's project folder. */
export const UNREAD_FILE = "hyo-unread.json";

// One per vault on this Mac, made by the plugin's factory (desktop only).
const states = new Map<string, ReadState>();
let makeState: ((cwd: string) => ReadState) | null = null;

export function setReadStateFactory(make: ((cwd: string) => ReadState) | null): void {
  makeState = make;
  states.clear();
}

export function readState(cwd: string): ReadState | null {
  let s = states.get(cwd);
  if (!s && makeState) {
    s = makeState(cwd);
    states.set(cwd, s);
  }
  return s || null;
}
