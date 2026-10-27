/**
 * One Claude process per conversation, owned by the Mac.
 *
 * A conversation can be open in several places at once: a Hyo panel on the
 * laptop, a second panel, and the phone (through the gateway, which runs on
 * the same Mac). Two processes writing to one conversation file lose each
 * other's turns and split the transcript, so every conversation's process
 * lives here, once, and every view of it subscribes:
 *
 *   - A desktop panel's session manager uses `OwnerTransport`, which has
 *     ClaudeTransport's shape but sends through the owner.
 *   - The gateway subscribes each of the phone's open conversations to the
 *     same owner (`gatewaySession`), tagged with the phone's tab id.
 *
 * Owners are keyed by working directory and Claude session id. The main chat
 * is one more owner, keyed by working directory alone: its session id can
 * change underneath it, it holds a lock against a second copy of Obsidian, and
 * it is never let go for being idle.
 *
 * Everyone gets every event from the one process. A message sent from one
 * view reaches all of them as `hyo_user_message` (with the sender's id for it,
 * so the sender knows it's its own). A message sent while a turn runs is held
 * and every view shows it queued (`hyo_queued`) until its turn starts, so
 * turns never interleave. A permission, question or plan answered in one view
 * is answered once, and the others are told (`hyo_permission_answered`).
 *
 * Someone opening a conversation mid-turn is caught up with `hyo_replay`: the
 * turn's events so far, the messages waiting, and any question still open.
 * History read from disk stops where the turn began (`turnStartLine`), so the
 * replay never doubles what history already shows.
 *
 * Leaving (closing a panel, closing the conversation on the phone, the phone
 * going away) never stops the process. An owner with nobody watching and
 * nothing running is let go after a grace period, and its process with it. An
 * idle process is also stopped after a long quiet spell; the next message
 * resumes the conversation in a fresh one.
 */

import { applyJobEvent, hasRunningJobs, jobList, type JobMap } from "./background-jobs";

/** The id the phone uses for the main chat on the wire. */
export const MAIN_CHAT_WIRE_ID = "hyo-main-chat";

export interface OwnerSpec {
  cliPath: string;
  cwd: string;
  model: string;
  effort?: string;
  permissionMode: string;
  agent?: string;
  sessionId?: string | null;
  resume?: boolean;
  appendSystemPrompt?: string;
  maxOutputTokens?: number;
  /** Ask-first on the phone: which settings files the CLI reads, plus the phone's own allowlist. */
  settingSources?: string;
  settingsPath?: string;
  /**
   * Use the model and agent the conversation is already running on; this
   * spec's own only apply when it starts the process. The phone sends this,
   * so a conversation started on the laptop keeps the laptop's choices.
   */
  adopt?: boolean;
}

/** The parts of ClaudeTransport the owner drives. */
export interface ProcLike {
  spawn(): void;
  sendUserMessage(content: string | any[]): void;
  sendPermissionResponse(
    requestId: string,
    behavior: "allow" | "allow_always" | "deny",
    toolName?: string,
    updatedInput?: Record<string, unknown>,
    destination?: string
  ): void;
  sendInterrupt(): void;
  stop(): void;
  isRunning(): boolean;
  /** Change the permission mode of the running process; returns the request's id (its answer comes back as a control_response). */
  setPermissionMode?(mode: string): string | void;
}

/** What a conversation's process is really running with, as every view shows it. */
export interface SessionInfo {
  permissionMode: string;
  /** The model and agent, once the conversation has run here. */
  model?: string;
  agent?: string;
}

/** The CLI reports "manual" (Ask first) under its older name. */
export function normalizeMode(mode: string | undefined | null): string {
  if (!mode || mode === "default") return "manual";
  return mode;
}

export type MakeProc = (
  spec: OwnerSpec,
  on: { onMessage: (e: any) => void; onError: (e: string) => void; onClose: (code: number | null) => void }
) => ProcLike;

export interface Subscriber {
  onEvent: (event: any) => void;
  onClose?: (code: number | null) => void;
  onError?: (error: string) => void;
}

export interface LockOps {
  /** Take the lock for this conversation; false if another live process holds it. */
  acquire(): boolean;
  release(): void;
}

export interface OwnerOptions {
  /** The main chat's lock against a second copy of Obsidian on this Mac. */
  lock?: LockOps;
  /** Never let go for being idle (the main chat). */
  keep?: boolean;
  /** The conversation this owner carries on. */
  sessionId?: string | null;
  /** How many lines the conversation's transcript has right now (null if unknown). */
  transcriptLines?: (sessionId: string) => number | null;
  /** How long an owner with nobody watching and nothing running waits before it's let go. */
  graceMs?: number;
  /** How long an idle process is kept before it's stopped (0: never). */
  procIdleMs?: number;
  onRelease?: (owner: SessionOwner) => void;
  /** Claude reported a session id this owner wasn't keyed by. */
  onSessionId?: (owner: SessionOwner, sessionId: string) => void;
  onTurnEnd?: (owner: SessionOwner) => void;
}

/** The turn under way, kept so someone opening the conversation mid-turn can be caught up. */
interface TurnRecord {
  qid?: string;
  text?: string;
  selfStarted?: boolean;
  startLine: number | null;
  events: any[];
}

interface QueuedSend {
  qid: string;
  /** Carries on the reply before it, with no message of its own (the nudge after a compaction). */
  silent?: boolean;
  from: string;
  spec: OwnerSpec;
  content: string | any[];
  text: string;
}

export const DEFAULT_GRACE_MS = 3 * 60_000;
export const DEFAULT_PROC_IDLE_MS = 30 * 60_000;
const MAX_REPLAY_EVENTS = 20_000;
// A process that dies this soon after starting, with messages waiting, isn't
// started again for them: it would only die again.
const CRASH_LOOP_MS = 5_000;

/** What makes a different process: these change the CLI's arguments. */
function specKey(s: OwnerSpec): string {
  return JSON.stringify([s.appendSystemPrompt || "", s.agent || "", s.model, s.cliPath]);
}

function isSidechain(e: any): boolean {
  return !!(e?.isSidechain || e?.parent_tool_use_id);
}

function isMainContent(e: any): boolean {
  if (!e || isSidechain(e)) return false;
  if (e.type === "assistant") return true;
  if (e.type === "stream_event") {
    const t = (e.event || e).type;
    return t === "content_block_start" || t === "content_block_delta";
  }
  return false;
}

function genQid(): string {
  return "q-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
}

/** The person's words from a message: text blocks, without the hidden reminders. */
export function displayText(content: string | any[]): string {
  const raw =
    typeof content === "string"
      ? content
      : (content || [])
          .filter((b: any) => b?.type === "text")
          .map((b: any) => b.text || "")
          .join("\n");
  return raw.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
}

const unref = <T>(t: T): T => {
  try {
    (t as any)?.unref?.();
  } catch {
    /* timers without unref (the browser) */
  }
  return t;
};

export class SessionOwner {
  private proc: ProcLike | null = null;
  private procSpec: OwnerSpec | null = null;
  // The spec the conversation last ran on, kept after its process stops, so
  // an adopting sender (the phone) carries on with it.
  private lastSpec: OwnerSpec | null = null;
  private procStartedAt = 0;
  private subs = new Map<string, Subscriber>();
  private nextSub = 1;
  private generating = false;
  private jobs: JobMap = {};
  private _sessionId: string | null;
  private queue: QueuedSend[] = [];
  private turn: TurnRecord | null = null;
  // Asks Claude is waiting on (permissions, questions, plans), by request id.
  private openAsks = new Map<string, any>();
  private answered = new Set<string>();
  private graceTimer: ReturnType<typeof setTimeout> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private released = false;
  private _seq = 0;
  // The permission mode the conversation runs in (what Claude last reported,
  // or what was last chosen), the mode its process was launched with, and a
  // mode change Claude couldn't make in place (it needs a fresh process).
  private mode: string | null = null;
  private launchedMode: string | null = null;
  private modeRequest: { id: string; mode: string } | null = null;
  private relaunchWhenIdle = false;
  private lastInfo = "";

  constructor(private make: MakeProc, private opts: OwnerOptions = {}) {
    this._sessionId = opts.sessionId ?? null;
  }

  // ---- what views read ----

  get sessionId(): string | null {
    return this._sessionId;
  }

  get subscribers(): number {
    return this.subs.size;
  }

  get busy(): boolean {
    return this.generating || hasRunningJobs(this.jobs);
  }

  get running(): boolean {
    return !!this.proc && this.proc.isRunning();
  }

  get isReleased(): boolean {
    return this.released;
  }

  /** Changes whenever a turn starts or ends: history read before a change may be out of date. */
  get seq(): number {
    return this._seq;
  }

  /** Where the turn under way began in the transcript; history read for a newcomer stops here. */
  get turnStartLine(): number | null {
    return this.turn ? this.turn.startLine : null;
  }

  get turnInProgress(): boolean {
    return !!this.turn;
  }

  /** What the conversation's process is really running with (null before it has ever run). */
  get info(): SessionInfo | null {
    const spec = this.procSpec || this.lastSpec;
    if (!spec && !this.mode) return null;
    return {
      permissionMode: normalizeMode(this.mode ?? spec?.permissionMode),
      ...(spec ? { model: spec.model, agent: spec.agent || "" } : {}),
    };
  }

  /** Tell every view what the conversation runs with, when that changes. */
  private announceInfo(): void {
    const info = this.info;
    if (!info) return;
    const key = JSON.stringify(info);
    if (key === this.lastInfo) return;
    this.lastInfo = key;
    this.broadcast({ type: "hyo_session_info", ...info });
  }

  /**
   * Change the conversation's permission mode, from any view. Claude changes
   * it in place where it can; a mode it can only start in (Never ask, for a
   * process launched asking) takes a fresh process, once nothing is running,
   * which carries on the conversation. Every view shows the new mode.
   */
  setPermissionMode(mode: string): void {
    const m = normalizeMode(mode);
    this.mode = m;
    if (this.lastSpec) this.lastSpec = { ...this.lastSpec, permissionMode: m };
    if (this.procSpec) this.procSpec = { ...this.procSpec, permissionMode: m };
    if (this.proc && this.proc.isRunning() && m !== this.launchedMode) {
      const id = this.proc.setPermissionMode?.(m);
      if (id) this.modeRequest = { id, mode: m };
      else this.relaunch();
    }
    this.announceInfo();
  }

  /** A fresh process for the conversation now, or as soon as nothing is running. */
  private relaunch(): void {
    if (!this.busy && !this.queue.length) this.stopProc();
    else this.relaunchWhenIdle = true;
  }

  // ---- subscribing ----

  /** Start receiving every event, caught up on what's under way. Returns the subscriber id. */
  subscribe(sub: Subscriber): string {
    const id = `s${this.nextSub++}`;
    this.subs.set(id, sub);
    this.released = false;
    this.cancelGrace();
    const running = jobList(this.jobs);
    if (running.length) {
      sub.onEvent({
        type: "system",
        subtype: "background_tasks_changed",
        tasks: running.map((j) => ({ task_id: j.id, description: j.title, task_type: "local_agent" })),
      });
    }
    const info = this.info;
    if (info) sub.onEvent({ type: "hyo_session_info", ...info });
    const replay = this.replay();
    if (replay) sub.onEvent(replay);
    return id;
  }

  /** What someone opening the conversation now needs to see, or null if nothing's going on. */
  private replay(): any | null {
    const t = this.turn;
    const inTurn = new Set<string>();
    if (t) for (const e of t.events) if (e?.type === "control_request" && e.request_id) inTurn.add(e.request_id);
    const asks = [...this.openAsks.entries()].filter(([id]) => !inTurn.has(id)).map(([, e]) => e);
    if (!t && !this.queue.length && !asks.length) return null;
    return {
      type: "hyo_replay",
      turn: t ? { qid: t.qid, text: t.text, selfStarted: !!t.selfStarted, events: [...t.events] } : null,
      queued: this.queue.filter((q) => !q.silent).map((q) => ({ qid: q.qid, text: q.text })),
      asks,
    };
  }

  /** Stop receiving events. Never stops the process or a turn. */
  detach(id: string): void {
    this.subs.delete(id);
    this.maybeRelease();
  }

  private broadcast(e: any, except?: string): void {
    for (const [id, s] of [...this.subs]) {
      if (id === except) continue;
      try {
        s.onEvent(e);
      } catch (err) {
        console.error("[hyo] A conversation view failed to take an event:", err);
      }
    }
  }

  // ---- sending ----

  /**
   * A message for the conversation. Starts the process if there isn't one,
   * swaps it first if it was started with different arguments and nothing
   * is running, and holds the message while a turn is under way so turns
   * never interleave. Every view is told what was said (or that it's
   * waiting). `qid` is the sender's id for this message.
   */
  send(from: string, spec: OwnerSpec, content: string | any[], qid?: string, opts: { silent?: boolean } = {}): string {
    const item: QueuedSend = { qid: qid || genQid(), from, spec, content, text: displayText(content), ...(opts.silent ? { silent: true } : {}) };
    this.cancelGrace();
    if (this.generating) {
      this.queue.push(item);
      if (!item.silent) this.broadcast({ type: "hyo_queued", qid: item.qid, text: item.text });
      return item.qid;
    }
    this.dispatch(item);
    return item.qid;
  }

  private dispatch(item: QueuedSend): void {
    let spec = item.spec;
    const base = this.procSpec || this.lastSpec;
    if (spec.adopt && base) {
      spec = { ...spec, model: base.model, agent: base.agent, effort: base.effort };
    }
    // A conversation keeps its permission mode whichever view sends.
    if (this.mode) spec = { ...spec, permissionMode: this.mode };
    if (this.proc && this.proc.isRunning() && this.procSpec && specKey(this.procSpec) !== specKey(spec) && !this.busy) {
      this.stopProc();
    }
    if (!this.proc || !this.proc.isRunning()) {
      if (!this.start(spec)) {
        this.drop([item, ...this.queue.splice(0)], "refused");
        return;
      }
    }
    this.cancelIdle();
    this.generating = true;
    this._seq++;
    this.turn = { qid: item.qid, text: item.text, startLine: this.lines(), events: [] };
    this.broadcast({ type: "hyo_user_message", qid: item.qid, text: item.text, ...(item.silent ? { silent: true } : {}) });
    this.proc!.sendUserMessage(item.content);
  }

  private lines(): number | null {
    if (!this._sessionId || !this.opts.transcriptLines) return null;
    try {
      return this.opts.transcriptLines(this._sessionId);
    } catch {
      return null;
    }
  }

  /** Messages that will never go: everyone stops showing them as waiting. */
  private drop(items: QueuedSend[], reason: "refused" | "stopped"): void {
    if (!items.length) return;
    this.broadcast({ type: "hyo_queue_dropped", qids: items.map((i) => i.qid), reason });
  }

  private start(spec: OwnerSpec): boolean {
    if (this.opts.lock && !this.opts.lock.acquire()) {
      for (const s of this.subs.values()) {
        s.onError?.("The main chat is already running in another copy of Obsidian on this computer. Use that one, or quit it and try again.");
        s.onEvent({ type: "hyo_owner_refused" });
      }
      return false;
    }
    // Carry on the conversation the owner has been running, if it knows one.
    const sessionId = spec.sessionId ?? this._sessionId;
    const full: OwnerSpec = { ...spec, sessionId, resume: spec.sessionId ? !!spec.resume : !!this._sessionId || !!spec.resume };
    const proc = this.make(full, {
      onMessage: (e) => this.onMessage(proc, e),
      onError: (e) => {
        if (this.proc !== proc) return;
        for (const s of this.subs.values()) s.onError?.(e);
      },
      onClose: (code) => this.onProcClose(proc, code),
    });
    this.proc = proc;
    this.procSpec = full;
    this.lastSpec = full;
    this.procStartedAt = Date.now();
    this.launchedMode = normalizeMode(full.permissionMode);
    if (!this.mode) this.mode = this.launchedMode;
    this.relaunchWhenIdle = false;
    this.modeRequest = null;
    proc.spawn();
    this.announceInfo();
    return true;
  }

  private onProcClose(proc: ProcLike, code: number | null): void {
    if (this.proc !== proc) return; // a process we stopped on purpose
    const quick = Date.now() - this.procStartedAt < CRASH_LOOP_MS;
    this.proc = null;
    this.procSpec = null;
    if (this.generating) this._seq++;
    this.generating = false;
    this.turn = null;
    this.jobs = {};
    this.openAsks.clear();
    this.opts.lock?.release();
    for (const s of [...this.subs.values()]) s.onClose?.(code);
    // Messages still waiting: start again for them, unless it just died on
    // starting (it would only die again).
    const next = this.queue.shift();
    if (next) {
      if (quick && code !== 0) this.drop([next, ...this.queue.splice(0)], "stopped");
      else this.dispatch(next);
    }
    this.maybeRelease();
  }

  private onMessage(proc: ProcLike, e: any): void {
    if (this.proc !== proc) return;
    if (e?.type === "system") {
      if (e.subtype === "init" && e.session_id && e.session_id !== this._sessionId) {
        this._sessionId = e.session_id;
        this.opts.onSessionId?.(this, e.session_id);
      }
      const next = applyJobEvent(this.jobs, e);
      if (next) this.jobs = next;
    }
    // What Claude reports its permission mode is, and how a change went.
    if (e?.type === "system" && typeof e.permissionMode === "string" && (e.subtype === "init" || e.subtype === "status")) {
      const reported = normalizeMode(e.permissionMode);
      if (!this.modeRequest || this.modeRequest.mode === reported) {
        this.mode = reported;
        if (this.procSpec) this.procSpec = { ...this.procSpec, permissionMode: reported };
        if (this.lastSpec) this.lastSpec = { ...this.lastSpec, permissionMode: reported };
      }
    }
    if (e?.type === "control_response" && this.modeRequest && e.response?.request_id === this.modeRequest.id) {
      const asked = this.modeRequest.mode;
      this.modeRequest = null;
      // Claude can't switch to it in place: start a fresh process in it.
      if (e.response?.subtype === "error") this.relaunch();
      else this.mode = asked;
    }
    if (e?.type === "control_request" && e.request_id && e.request?.subtype === "can_use_tool") {
      this.openAsks.set(e.request_id, e);
      this.answered.delete(e.request_id);
    }
    // A turn Claude starts itself (a job finished) is a turn under way too.
    if (!this.generating && isMainContent(e)) {
      this.generating = true;
      this._seq++;
      this.cancelIdle();
      this.turn = { selfStarted: true, startLine: this.lines(), events: [] };
    }
    this.record(e);
    this.broadcast(e);
    if (e?.type === "system" || e?.type === "control_response") this.announceInfo();
    if (e?.type === "result" && !isSidechain(e)) {
      this.generating = false;
      this.turn = null;
      this._seq++;
      try {
        this.opts.onTurnEnd?.(this);
      } catch (err) {
        console.error("[hyo] A turn-end listener failed:", err);
      }
      const next = this.queue.shift();
      if (next) this.dispatch(next);
      else this.whenQuiet();
    } else if (e?.type === "system" && !this.busy) {
      this.whenQuiet();
    }
  }

  /** Keep the turn's events for a newcomer, without every streamed fragment of a finished message. */
  private record(e: any): void {
    const t = this.turn;
    if (!t) return;
    if (e?.type === "assistant" && !isSidechain(e)) {
      // The complete message carries everything its fragments did.
      let i = t.events.length - 1;
      while (i >= 0) {
        const x = t.events[i];
        if (!isSidechain(x) && (x?.type === "assistant" || x?.type === "user")) break;
        i--;
      }
      const tail = t.events.slice(i + 1).filter((x) => !(x?.type === "stream_event" && !isSidechain(x)));
      t.events = [...t.events.slice(0, i + 1), ...tail];
    }
    t.events.push(e);
    if (t.events.length > MAX_REPLAY_EVENTS) {
      const at = t.events.findIndex((x) => x?.type === "stream_event");
      t.events.splice(at >= 0 ? at : 0, 1);
    }
  }

  // ---- answering ----

  /** A permission, question or plan answered in one view: answered once, and everyone's told. */
  permission(
    from: string,
    requestId: string,
    behavior: "allow" | "allow_always" | "deny",
    toolName?: string,
    updatedInput?: Record<string, unknown>,
    destination?: string
  ): boolean {
    if (this.answered.has(requestId)) return false;
    this.answered.add(requestId);
    this.openAsks.delete(requestId);
    this.proc?.sendPermissionResponse(requestId, behavior, toolName, updatedInput, destination);
    const told = { type: "hyo_permission_answered", requestId, behavior };
    this.record(told);
    this.broadcast(told, from);
    return true;
  }

  interrupt(): void {
    this.proc?.sendInterrupt();
  }

  /**
   * Stop the process so the next message starts a fresh one (after a Claude
   * update or sign-in, a repaired conversation, a different agent). Refused
   * while a turn or background job is running; returns whether it stopped.
   */
  restart(): boolean {
    if (this.busy) return false;
    this.stopProc();
    return true;
  }

  /** Obsidian is closing: stop for good. */
  shutdown(): void {
    this.cancelGrace();
    this.cancelIdle();
    this.stopProc();
    this.subs.clear();
    this.queue = [];
    this.released = true;
  }

  private stopProc(): void {
    const p = this.proc;
    this.proc = null;
    this.procSpec = null;
    this.generating = false;
    this.turn = null;
    this.jobs = {};
    this.openAsks.clear();
    this.opts.lock?.release();
    try {
      p?.stop();
    } catch {
      /* already gone */
    }
  }

  // ---- letting go ----

  /** Nothing is running: stop an idle process after a long quiet spell, and let go if nobody's watching. */
  private whenQuiet(): void {
    if (this.busy || this.queue.length) return;
    if (this.relaunchWhenIdle) {
      this.relaunchWhenIdle = false;
      this.stopProc();
    }
    const idleMs = this.opts.procIdleMs ?? DEFAULT_PROC_IDLE_MS;
    if (!this.opts.keep && idleMs > 0 && this.proc && !this.idleTimer) {
      this.idleTimer = unref(
        setTimeout(() => {
          this.idleTimer = null;
          if (!this.busy && !this.queue.length && !this.openAsks.size) this.stopProc();
        }, idleMs)
      );
    }
    this.maybeRelease();
  }

  private maybeRelease(): void {
    if (this.opts.keep || this.released || this.subs.size > 0 || this.busy || this.queue.length || this.graceTimer) return;
    const ms = this.opts.graceMs ?? DEFAULT_GRACE_MS;
    const go = () => {
      this.graceTimer = null;
      if (this.subs.size > 0 || this.busy || this.queue.length) return;
      this.release();
    };
    if (ms <= 0) go();
    else this.graceTimer = unref(setTimeout(go, ms));
  }

  private release(): void {
    this.released = true;
    this.cancelIdle();
    this.stopProc();
    try {
      this.opts.onRelease?.(this);
    } catch (err) {
      console.error("[hyo] Letting go of a conversation failed:", err);
    }
  }

  private cancelGrace(): void {
    if (this.graceTimer) clearTimeout(this.graceTimer);
    this.graceTimer = null;
  }

  private cancelIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }
}

/** The main chat is one owner like any other, kept for good. */
export class MainChatOwner extends SessionOwner {
  constructor(make: MakeProc, lock?: LockOps, opts: OwnerOptions = {}) {
    super(make, { ...opts, lock, keep: true });
  }
}

// ---- The lock between copies of Hyo on one Mac -----------------------------

export interface LockRecord {
  pid: number;
}

/** Another live process holds this lock. */
export function lockHeldByOther(rec: LockRecord | null, myPid: number, alive: (pid: number) => boolean): boolean {
  return !!rec && rec.pid !== myPid && alive(rec.pid);
}

/** A lock file next to Hyo's other per-machine state (~/.hyo). Desktop only. */
export function fileLock(file: string, pid: number = process.pid): LockOps {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require("fs");
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const path = require("path");
  const alive = (p: number) => {
    try {
      process.kill(p, 0);
      return true;
    } catch (e: any) {
      return e?.code === "EPERM";
    }
  };
  return {
    acquire() {
      let rec: LockRecord | null = null;
      try {
        rec = JSON.parse(fs.readFileSync(file, "utf8"));
      } catch {
        /* no lock */
      }
      if (lockHeldByOther(rec, pid, alive)) return false;
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify({ pid }));
      } catch {
        /* can't write it: carry on unlocked rather than refuse */
      }
      return true;
    },
    release() {
      try {
        const rec = JSON.parse(fs.readFileSync(file, "utf8"));
        if (rec?.pid === pid) fs.unlinkSync(file);
      } catch {
        /* already gone */
      }
    },
  };
}

// ---- One owner per conversation on this Mac --------------------------------

export interface OwnerFactory {
  make: MakeProc;
  /** The main chat's lock for a working directory. */
  mainLock?: (cwd: string) => LockOps | undefined;
  transcriptLines?: (cwd: string, sessionId: string) => number | null;
  graceMs?: number;
  procIdleMs?: number;
}

const owners = new Map<string, SessionOwner>();
let factory: OwnerFactory | null = null;
const turnListeners = new Set<(cwd: string, owner: SessionOwner) => void>();

const keyOf = (cwd: string, sessionId: string) => `${cwd}\u0000${sessionId}`;
const mainKey = (cwd: string) => `${cwd}\u0000\u0000main`;

/** Set once by the plugin (desktop) with the real Claude process factory. Null clears it. */
export function setSessionOwnerFactory(f: OwnerFactory | null): void {
  factory = f;
}

function optionsFor(cwd: string, sessionId: string | null): OwnerOptions {
  return {
    sessionId,
    transcriptLines: factory?.transcriptLines ? (sid) => factory!.transcriptLines!(cwd, sid) : undefined,
    graceMs: factory?.graceMs,
    procIdleMs: factory?.procIdleMs,
    onTurnEnd: (o) => {
      for (const l of [...turnListeners]) {
        try {
          l(cwd, o);
        } catch (e) {
          console.error("[hyo] A turn listener failed:", e);
        }
      }
    },
    onSessionId: (o, sid) => {
      // Findable by the id Claude reports too (a conversation forked on resume).
      if (!o.isReleased && !owners.has(keyOf(cwd, sid)) && [...owners.values()].includes(o)) owners.set(keyOf(cwd, sid), o);
    },
    onRelease: (o) => {
      for (const [k, v] of [...owners]) if (v === o) owners.delete(k);
    },
  };
}

/** The main chat's owner for a working directory (made on first use). */
export function mainChatOwner(cwd: string): SessionOwner | null {
  let o = owners.get(mainKey(cwd));
  if (!o && factory) {
    const base = optionsFor(cwd, null);
    o = new MainChatOwner(factory.make, factory.mainLock?.(cwd), { ...base, onSessionId: undefined, onRelease: undefined });
    owners.set(mainKey(cwd), o);
  }
  return o || null;
}

/** The owner of one conversation, made on first use (null without a factory: mobile, tests). */
export function sessionOwner(cwd: string, sessionId: string): SessionOwner | null {
  if (!sessionId) return null;
  let o = owners.get(keyOf(cwd, sessionId));
  if (o && o.isReleased) {
    owners.delete(keyOf(cwd, sessionId));
    o = undefined;
  }
  if (!o && factory) {
    o = new SessionOwner(factory.make, optionsFor(cwd, sessionId));
    owners.set(keyOf(cwd, sessionId), o);
  }
  return o || null;
}

/** The owner of a conversation if there is one, without making it. */
export function findSessionOwner(cwd: string, sessionId: string): SessionOwner | null {
  const o = owners.get(keyOf(cwd, sessionId));
  return o && !o.isReleased ? o : null;
}

/** How many conversations have an owner right now (main chats included). */
export function ownerCount(): number {
  return new Set(owners.values()).size;
}

/** Hear every turn that ends, in any conversation (the gateway refreshes the phone's Open rows). */
export function onTurnEnded(fn: (cwd: string, owner: SessionOwner) => void): () => void {
  turnListeners.add(fn);
  return () => {
    turnListeners.delete(fn);
  };
}

/** Restart every idle process (Claude was updated). Busy ones swap on their next message. */
export function restartIdleOwners(): void {
  for (const o of new Set(owners.values())) o.restart();
}

/** Obsidian is closing: every conversation's process stops. */
export function shutdownSessionOwners(): void {
  for (const o of new Set(owners.values())) o.shutdown();
  owners.clear();
}

// ---- The desktop panel's side ----------------------------------------------

/**
 * ClaudeTransport's shape for a desktop tab: it subscribes to the
 * conversation's owner instead of starting a process. `stop()` detaches; the
 * process carries on.
 */
export class OwnerTransport implements ProcLike {
  private sub: string | null = null;
  private specFor: () => OwnerSpec;

  constructor(
    readonly owner: SessionOwner,
    spec: OwnerSpec | (() => OwnerSpec),
    private on: { onMessage: (e: any) => void; onError: (e: string) => void; onClose: (code: number | null) => void }
  ) {
    this.specFor = typeof spec === "function" ? spec : () => spec;
  }

  spawn(): void {
    if (this.sub) return;
    this.sub = this.owner.subscribe({
      onEvent: (e) => this.on.onMessage(e),
      onError: (e) => this.on.onError(e),
      onClose: (code) => this.on.onClose(code),
    });
  }

  sendUserMessage(content: string | any[], opts: { qid?: string; silent?: boolean } = {}): void {
    if (!this.sub) this.spawn();
    this.owner.send(this.sub!, this.specFor(), content, opts.qid, { silent: opts.silent });
  }

  sendPermissionResponse(requestId: string, behavior: "allow" | "allow_always" | "deny", toolName?: string, updatedInput?: Record<string, unknown>): void {
    if (!this.sub) this.spawn();
    this.owner.permission(this.sub!, requestId, behavior, toolName, updatedInput);
  }

  sendInterrupt(): void {
    this.owner.interrupt();
  }

  stop(): void {
    if (this.sub) this.owner.detach(this.sub);
    this.sub = null;
  }

  /** Ask for a fresh process on the next message (see SessionOwner.restart). */
  restartProcess(): boolean {
    return this.owner.restart();
  }

  /** Change the conversation's permission mode (every view shows it). */
  setPermissionMode(mode: string): void {
    this.owner.setPermissionMode(mode);
  }

  isRunning(): boolean {
    return !!this.sub;
  }
}

/** The main chat's transport is the same thing. */
export const MainChatTransport = OwnerTransport;

// ---- The gateway's side -----------------------------------------------------

export interface GatewayClientSink {
  send: (obj: unknown) => void;
  /** The socket is still open. */
  isOpen?: () => boolean;
}

export interface GatewaySessionContext {
  cwd: string;
  /** The spec a phone message asks for (its model, agent, ask-first and persona). */
  specFor: (m: any, sessionId: string | null) => OwnerSpec;
  /** A fresh conversation id, for a phone that didn't send one. */
  mintId: () => string;
  /** "Always allow" on the phone also goes on the phone's own allowlist. */
  allowOnPhone?: (toolName: string) => void;
}

/** One of the phone's open conversations, subscribed to its owner. */
interface PhoneTab {
  tabId: string;
  owner: SessionOwner;
  sub: string;
  ws: object | null;
  sink: GatewayClientSink | null;
  outbox: unknown[];
  grace: ReturnType<typeof setTimeout> | null;
}

export const PHONE_GRACE_MS = 3 * 60_000;
const MAX_OUTBOX = 5000;
const phoneTabs = new Map<string, PhoneTab>();

function phoneEmit(pt: PhoneTab, obj: unknown): void {
  if (pt.sink && (!pt.sink.isOpen || pt.sink.isOpen())) {
    try {
      pt.sink.send(obj);
      return;
    } catch {
      /* fall through to holding it */
    }
  }
  pt.outbox.push(obj);
  if (pt.outbox.length > MAX_OUTBOX) pt.outbox.splice(0, pt.outbox.length - MAX_OUTBOX);
}

function bindPhone(pt: PhoneTab, ws: object, sink: GatewayClientSink): void {
  pt.ws = ws;
  pt.sink = sink;
  if (pt.grace) clearTimeout(pt.grace);
  pt.grace = null;
  const held = pt.outbox;
  pt.outbox = [];
  for (const o of held) phoneEmit(pt, o);
}

function dropPhoneTab(tabId: string): void {
  const pt = phoneTabs.get(tabId);
  if (!pt) return;
  if (pt.grace) clearTimeout(pt.grace);
  phoneTabs.delete(tabId);
  pt.owner.detach(pt.sub);
}

/** Subscribe one of the phone's tabs to a conversation's owner (once; a reconnect rebinds it). */
function phoneTabFor(tabId: string, owner: SessionOwner, ws: object, sink: GatewayClientSink): PhoneTab {
  const have = phoneTabs.get(tabId);
  if (have && have.owner === owner && !owner.isReleased) {
    if (have.ws !== ws || !have.sink) bindPhone(have, ws, sink);
    return have;
  }
  if (have) dropPhoneTab(tabId);
  const pt: PhoneTab = { tabId, owner, sub: "", ws, sink, outbox: [], grace: null };
  phoneTabs.set(tabId, pt);
  pt.sub = owner.subscribe({
    onEvent: (event) => phoneEmit(pt, { type: "stream", tabId, event }),
    // The process ended; the phone stays subscribed and the next message starts another.
    onClose: (code) => phoneEmit(pt, { type: "gateway", subtype: "tab_closed", tabId, code, subscribed: true }),
    onError: (error) => phoneEmit(pt, { type: "gateway", subtype: "error", tabId, error }),
  });
  return pt;
}

function ownerFor(ctx: GatewaySessionContext, tabId: string, sessionId: string | null): SessionOwner | null {
  if (tabId === MAIN_CHAT_WIRE_ID) return mainChatOwner(ctx.cwd);
  return sessionId ? sessionOwner(ctx.cwd, sessionId) : null;
}

/** Subscribe a phone tab to a conversation now (opening it, or the main chat). */
export function gatewayAttach(ctx: GatewaySessionContext, tabId: string, sessionId: string | null, ws: object, sink: GatewayClientSink): boolean {
  const owner = ownerFor(ctx, tabId, sessionId);
  if (!owner) return false;
  phoneTabFor(tabId, owner, ws, sink);
  return true;
}

/**
 * A phone message about a conversation (it carries a tabId). The phone's
 * conversations attach to the Mac's owners; the phone never gets a process
 * of its own, and its `stop` only detaches. Returns false for a message
 * that isn't about a conversation. `reattach` is answered here in full.
 */
export function gatewaySession(m: any, ws: object, sink: GatewayClientSink, ctx: GatewaySessionContext): boolean {
  const tabId: string | undefined = typeof m?.tabId === "string" ? m.tabId : undefined;
  switch (m?.type) {
    case "reattach": {
      const ids: string[] = Array.isArray(m.tabIds) ? m.tabIds : tabId ? [tabId] : [];
      const attached: string[] = [];
      const gone: string[] = [];
      for (const id of ids) {
        const pt = phoneTabs.get(id);
        if (pt && !pt.owner.isReleased) {
          bindPhone(pt, ws, sink);
          attached.push(id);
        } else if (id === MAIN_CHAT_WIRE_ID && gatewayAttach(ctx, id, null, ws, sink)) {
          attached.push(id);
        } else {
          if (pt) dropPhoneTab(id);
          gone.push(id);
        }
      }
      sink.send({ type: "gateway", subtype: "reattached", attached, gone });
      return true;
    }
    case "attach": {
      if (!tabId) return true;
      const sid = typeof m.sessionId === "string" && m.sessionId ? m.sessionId : null;
      if (!gatewayAttach(ctx, tabId, sid, ws, sink)) {
        sink.send({ type: "gateway", subtype: "error", tabId, error: "Hyo on your Mac isn't ready to open that conversation. Open Hyo on the Mac and try again." });
      }
      return true;
    }
    case "prompt": {
      if (!tabId) return true;
      let sid: string | null = typeof m.sessionId === "string" && m.sessionId ? m.sessionId : null;
      if (tabId !== MAIN_CHAT_WIRE_ID && !sid) sid = phoneTabs.get(tabId)?.owner.sessionId || ctx.mintId();
      const owner = ownerFor(ctx, tabId, sid);
      if (!owner) {
        sink.send({ type: "gateway", subtype: "error", tabId, error: "Hyo on your Mac isn't ready to run Claude. Open Hyo on the Mac and try again." });
        return true;
      }
      const pt = phoneTabFor(tabId, owner, ws, sink);
      const content = Array.isArray(m.content) && m.content.length ? m.content : [{ type: "text", text: m.text }];
      owner.send(pt.sub, ctx.specFor(m, tabId === MAIN_CHAT_WIRE_ID ? m.sessionId || null : sid), content, typeof m.qid === "string" ? m.qid : undefined, { silent: m.silent === true });
      return true;
    }
    case "permission_response": {
      const pt = tabId ? phoneTabs.get(tabId) : undefined;
      if (!pt) return true;
      // "Always allow" from the phone lasts for this process and goes on the
      // phone's own list, never into the desktop's rules.
      if (m.behavior === "allow_always" && m.toolName) ctx.allowOnPhone?.(m.toolName);
      pt.owner.permission(pt.sub, m.requestId, m.behavior, m.toolName, m.updatedInput, "session");
      return true;
    }
    case "interrupt":
      if (tabId) phoneTabs.get(tabId)?.owner.interrupt();
      return true;
    case "restart":
      if (tabId) phoneTabs.get(tabId)?.owner.restart();
      return true;
    case "set_permission_mode": {
      // From the phone, for the conversation in that tab (it may not be
      // subscribed yet: a conversation it just opened).
      if (!tabId || typeof m.mode !== "string") return true;
      const pt = phoneTabs.get(tabId);
      const sid = typeof m.sessionId === "string" && m.sessionId ? m.sessionId : null;
      const owner = pt?.owner || ownerFor(ctx, tabId, sid);
      owner?.setPermissionMode(m.mode);
      return true;
    }
    case "stop":
      if (tabId) dropPhoneTab(tabId);
      return true;
  }
  return false;
}

/** The phone's socket closed: its conversations' events wait a while for it; the processes carry on. */
export function gatewaySessionGone(ws: object, graceMs: number = PHONE_GRACE_MS): void {
  for (const pt of phoneTabs.values()) {
    if (pt.ws !== ws) continue;
    pt.ws = null;
    pt.sink = null;
    if (!pt.grace) {
      const id = pt.tabId;
      pt.grace = unref(setTimeout(() => dropPhoneTab(id), graceMs));
    }
  }
}

/** The gateway stopped: the phone's subscriptions end (the processes don't). */
export function gatewaySessionReset(): void {
  for (const id of [...phoneTabs.keys()]) dropPhoneTab(id);
}

/** How many of the phone's tabs are subscribed (tests). */
export function phoneTabCount(): number {
  return phoneTabs.size;
}
