/**
 * One Claude process for the main chat, owned by the Mac.
 *
 * Every other Hyo tab owns its own Claude process. The main chat can't: the
 * same conversation is open on the laptop, on the phone (through the gateway,
 * which runs on the same Mac) and possibly in a second Hyo panel, and two
 * processes writing to one conversation file lose each other's turns. So the
 * main chat's process lives here, once per vault, and every view of it
 * subscribes:
 *
 *   - The desktop panel's session manager uses `MainChatTransport`, which has
 *     ClaudeTransport's shape but sends through the owner.
 *   - The gateway hands the phone's main-chat messages to `gatewayMainChat`,
 *     which subscribes the phone's socket to the same owner.
 *
 * Everyone gets every event from the one process. A message sent from one
 * view reaches the others as `hyo_user_message`, so each shows it and the
 * reply that follows. Detaching (closing a panel, the phone going away) never
 * stops the process; only a restart that's needed (a new system prompt or
 * agent, a Claude update) does, and only when no turn or background job is
 * running.
 *
 * A second copy of Hyo on this Mac (another Obsidian process) can't start a
 * second process on the same conversation either: the owner takes a lock file
 * while its process runs and refuses if a live process holds it.
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
}

/** The parts of ClaudeTransport the owner drives. */
export interface ProcLike {
  spawn(): void;
  sendUserMessage(content: string | any[]): void;
  sendPermissionResponse(requestId: string, behavior: "allow" | "allow_always" | "deny", toolName?: string, updatedInput?: Record<string, unknown>): void;
  sendInterrupt(): void;
  stop(): void;
  isRunning(): boolean;
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

/** What makes a different process: these change the CLI's arguments. */
function specKey(s: OwnerSpec): string {
  return JSON.stringify([s.appendSystemPrompt || "", s.agent || "", s.model, s.cliPath]);
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

export class MainChatOwner {
  private proc: ProcLike | null = null;
  private procSpec: OwnerSpec | null = null;
  private subs = new Map<string, Subscriber>();
  private nextSub = 1;
  private generating = false;
  private jobs: JobMap = {};
  private sessionId: string | null = null;
  private queue: { from: string; spec: OwnerSpec; content: string | any[] }[] = [];

  constructor(private make: MakeProc, private lock?: LockOps) {}

  /** Start receiving every event. Returns the subscriber id. */
  subscribe(sub: Subscriber): string {
    const id = `s${this.nextSub++}`;
    this.subs.set(id, sub);
    // Catch the newcomer up: what's running, and whether a turn is under way.
    const running = jobList(this.jobs);
    if (running.length) {
      sub.onEvent({
        type: "system",
        subtype: "background_tasks_changed",
        tasks: running.map((j) => ({ task_id: j.id, description: j.title, task_type: "local_agent" })),
      });
    }
    if (this.generating) sub.onEvent({ type: "hyo_busy" });
    return id;
  }

  /** Stop receiving events. Never stops the process. */
  detach(id: string): void {
    this.subs.delete(id);
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

  /**
   * A message for the main chat. Starts the process if there isn't one, swaps
   * it first if it was started with different arguments and nothing is
   * running, and holds the message while a turn is under way so turns never
   * interleave. The other views are told what was said.
   */
  send(from: string, spec: OwnerSpec, content: string | any[]): void {
    if (this.generating) {
      this.queue.push({ from, spec, content });
      return;
    }
    this.dispatch(from, spec, content);
  }

  private dispatch(from: string, spec: OwnerSpec, content: string | any[]): void {
    if (this.proc && this.proc.isRunning() && this.procSpec && specKey(this.procSpec) !== specKey(spec) && !this.busy) {
      this.stopProc();
    }
    if (!this.proc || !this.proc.isRunning()) {
      if (!this.start(spec)) return;
    }
    this.generating = true;
    const text = displayText(content);
    for (const [id, s] of this.subs) {
      if (id !== from) s.onEvent({ type: "hyo_user_message", text });
    }
    this.proc!.sendUserMessage(content);
  }

  private start(spec: OwnerSpec): boolean {
    if (this.lock && !this.lock.acquire()) {
      for (const s of this.subs.values()) {
        s.onError?.("The main chat is already running in another copy of Obsidian on this computer. Use that one, or quit it and try again.");
        s.onEvent({ type: "hyo_owner_refused" });
      }
      return false;
    }
    // Carry on the conversation the process has been running, if it knows one.
    const sessionId = spec.sessionId ?? this.sessionId;
    const full: OwnerSpec = { ...spec, sessionId, resume: spec.sessionId ? !!spec.resume : !!this.sessionId || !!spec.resume };
    const proc = this.make(full, {
      onMessage: (e) => this.onMessage(proc, e),
      onError: (e) => {
        if (this.proc !== proc) return;
        for (const s of this.subs.values()) s.onError?.(e);
      },
      onClose: (code) => {
        if (this.proc !== proc) return; // a process we stopped on purpose
        this.proc = null;
        this.procSpec = null;
        this.generating = false;
        this.jobs = {};
        this.queue = [];
        this.lock?.release();
        for (const s of this.subs.values()) s.onClose?.(code);
      },
    });
    this.proc = proc;
    this.procSpec = full;
    proc.spawn();
    return true;
  }

  private onMessage(proc: ProcLike, e: any): void {
    if (this.proc !== proc) return;
    if (e?.type === "system") {
      if (e.subtype === "init" && e.session_id) this.sessionId = e.session_id;
      const next = applyJobEvent(this.jobs, e);
      if (next) this.jobs = next;
    }
    for (const s of this.subs.values()) s.onEvent(e);
    if (e?.type === "result" && !e.parent_tool_use_id && !e.isSidechain) {
      this.generating = false;
      const next = this.queue.shift();
      if (next) this.dispatch(next.from, next.spec, next.content);
    }
    // A turn Claude starts itself (a job finished) is a turn under way too.
    if (!this.generating && (e?.type === "assistant" || e?.type === "stream_event") && !e.parent_tool_use_id && !e.isSidechain) {
      this.generating = true;
    }
  }

  permission(from: string, requestId: string, behavior: "allow" | "allow_always" | "deny", toolName?: string, updatedInput?: Record<string, unknown>): void {
    this.proc?.sendPermissionResponse(requestId, behavior, toolName, updatedInput);
    for (const [id, s] of this.subs) {
      if (id !== from) s.onEvent({ type: "hyo_permission_answered", requestId, behavior });
    }
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
    this.stopProc();
    this.subs.clear();
  }

  private stopProc(): void {
    const p = this.proc;
    this.proc = null;
    this.procSpec = null;
    this.generating = false;
    this.jobs = {};
    this.lock?.release();
    try {
      p?.stop();
    } catch {
      /* already gone */
    }
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

// ---- The gateway's side -----------------------------------------------------

export interface GatewayClientSink {
  send: (obj: unknown) => void;
}

/** Each phone socket's subscription, so a reconnect doesn't double it. */
const phoneSubs = new WeakMap<object, string>();

/**
 * A phone message for the main chat (its tabId is MAIN_CHAT_WIRE_ID). The
 * phone attaches to the Mac's process; it never gets one of its own, and its
 * `stop` only detaches. Returns false if the message isn't the main chat's.
 */
export function gatewayMainChat(
  owner: MainChatOwner,
  m: any,
  ws: object,
  sink: GatewayClientSink,
  specFor: (m: any) => OwnerSpec
): boolean {
  const isMain = m?.tabId === MAIN_CHAT_WIRE_ID || (Array.isArray(m?.tabIds) && m.tabIds.includes(MAIN_CHAT_WIRE_ID));
  if (!isMain) return false;
  const attach = (): string => {
    const have = phoneSubs.get(ws);
    if (have) return have;
    const id = owner.subscribe({
      onEvent: (event) => sink.send({ type: "stream", tabId: MAIN_CHAT_WIRE_ID, event }),
      onClose: (code) => sink.send({ type: "gateway", subtype: "tab_closed", tabId: MAIN_CHAT_WIRE_ID, code }),
      onError: (error) => sink.send({ type: "gateway", subtype: "error", tabId: MAIN_CHAT_WIRE_ID, error }),
    });
    phoneSubs.set(ws, id);
    return id;
  };
  switch (m.type) {
    case "reattach":
      attach();
      return false; // the gateway still answers the other tabs in the list
    case "prompt": {
      const from = attach();
      const content = Array.isArray(m.content) && m.content.length ? m.content : [{ type: "text", text: m.text }];
      owner.send(from, specFor(m), content);
      return true;
    }
    case "permission_response":
      owner.permission(attach(), m.requestId, m.behavior, m.toolName, m.updatedInput);
      return true;
    case "interrupt":
      owner.interrupt();
      return true;
    case "stop": {
      const id = phoneSubs.get(ws);
      if (id) owner.detach(id);
      phoneSubs.delete(ws);
      return true;
    }
  }
  return false;
}

/** The phone's socket closed: it stops receiving; the process carries on. */
export function gatewayClientGone(owner: MainChatOwner | null, ws: object): void {
  const id = phoneSubs.get(ws);
  if (id && owner) owner.detach(id);
  phoneSubs.delete(ws);
}

// ---- One owner per vault on this Mac ---------------------------------------

const owners = new Map<string, MainChatOwner>();
let makeDefault: ((cwd: string) => MainChatOwner) | null = null;

/** Set once by the plugin (desktop) with the real Claude process factory. */
export function setMainChatOwnerFactory(make: (cwd: string) => MainChatOwner): void {
  makeDefault = make;
}

export function mainChatOwner(cwd: string): MainChatOwner | null {
  let o = owners.get(cwd);
  if (!o && makeDefault) {
    o = makeDefault(cwd);
    owners.set(cwd, o);
  }
  return o || null;
}

export function shutdownMainChats(): void {
  for (const o of owners.values()) o.shutdown();
  owners.clear();
}

// ---- The desktop panel's side ----------------------------------------------

/**
 * ClaudeTransport's shape for the main chat tab: it subscribes to the owner
 * instead of starting a process. `stop()` detaches; the process carries on.
 */
export class MainChatTransport implements ProcLike {
  private sub: string | null = null;

  constructor(
    private owner: MainChatOwner,
    private spec: OwnerSpec,
    private on: { onMessage: (e: any) => void; onError: (e: string) => void; onClose: (code: number | null) => void }
  ) {}

  spawn(): void {
    if (this.sub) return;
    this.sub = this.owner.subscribe({
      onEvent: (e) => this.on.onMessage(e),
      onError: (e) => this.on.onError(e),
      onClose: (code) => this.on.onClose(code),
    });
  }

  sendUserMessage(content: string | any[]): void {
    if (!this.sub) this.spawn();
    this.owner.send(this.sub!, this.spec, content);
  }

  sendPermissionResponse(requestId: string, behavior: "allow" | "allow_always" | "deny", toolName?: string, updatedInput?: Record<string, unknown>): void {
    if (this.sub) this.owner.permission(this.sub, requestId, behavior, toolName, updatedInput);
  }

  sendInterrupt(): void {
    this.owner.interrupt();
  }

  stop(): void {
    if (this.sub) this.owner.detach(this.sub);
    this.sub = null;
  }

  /** Ask for a fresh process on the next message (see MainChatOwner.restart). */
  restartProcess(): boolean {
    return this.owner.restart();
  }

  isRunning(): boolean {
    return !!this.sub;
  }
}
