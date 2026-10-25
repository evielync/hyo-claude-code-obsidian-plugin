import { GptLiveSession, liveLog, type GptLiveOptions, type GptLiveState, type LiveTransport } from "./gpt-live";
import {
  startCall,
  addTurn,
  addHandoff,
  answerHandoff,
  endCall,
  callHasContent,
  spokenForVoice,
  handoffTask,
  isJustAcknowledgement,
  type CallEndReason,
  type VoiceCallRecord,
} from "./voice-call";

/**
 * One GPT-Live call, the same on desktop and the phone: the session, the
 * call's record, and the hand-offs Claude is working on. The React hooks
 * only render it.
 *
 * The conversation behaviour is 0.6.x's (the version Ev prefers):
 *   - a hand-off gets one silent "started on this" note, short silent
 *     progress notes while Claude works, and one spoken "still working" if
 *     it runs past 25 seconds;
 *   - Claude's finished reply goes back as the spoken part only (its
 *     [SCREEN] detail stays in the chat), as one commentary append;
 *   - a result overtaken by a newer request is kept silent.
 * On top of that, the real fixes:
 *   - Claude gets everything the user said since the last hand-off, word
 *     for word (the delegation event carries no text);
 *   - one job per ask: a repeat delegation with nothing new said, or the
 *     same words again, starts nothing;
 *   - while a job runs, an answer to the voice ("done", "yes") starts nothing;
 *   - hanging up never touches Claude: a running job finishes in the chat.
 */

export interface LiveUi {
  status: "off" | "connecting" | "connected" | "live";
  side: "user" | "agent" | null;
  level: number;
}

export interface LiveCallOptions {
  /** Session settings; the callbacks are supplied here. */
  session: Omit<GptLiveOptions, "onState" | "onTurn" | "onLevel" | "onFirstSpeech" | "onDelegation" | "onError" | "transport">;
  /** Transports to try in order (desktop: WebRTC then WebSocket). */
  transports: LiveTransport[];
  /** Claude messages in the thread when the call started — where its line goes. */
  after: number;
  /**
   * A job for Claude: `prompt` is the whole request (the call so far that
   * Claude hasn't heard, and everything the user said since the last job,
   * word for word); `said` is just the user's words, for the record.
   */
  onHandoff: (prompt: string, said: string) => void;
  /** A finished spoken turn (for whatever goes to Claude next). */
  onTurn?: (side: "user" | "agent", text: string) => void;
  onUi: (ui: LiveUi) => void;
  /** The line is live and listening (once per call): play the connect chime. */
  onLive?: () => void;
  /** The call is over (hung up, dropped, or never connected). The record, if anything happened. */
  onEnded: (record: VoiceCallRecord | null, reason: CallEndReason) => void;
  onError: (message: string) => void;
  /** Tests swap in a fake session. */
  createSession?: (opts: GptLiveOptions) => GptLiveSession;
}

/** 0.6.x: one spoken "still working" if a hand-off runs this long. */
export const STILL_WORKING_MS = 25000;
/** How long a hand-off waits for a trailing transcript before deciding nothing new was said. */
export const TRANSCRIPT_GRACE_MS = 800;
/** Progress notes are silent and at most one per this long (the latest step wins). */
export const PROGRESS_GAP_MS = 5000;

export const NOTE_STARTED = "The backend agent has started on this. No result yet.";
export const NOTE_QUEUED = "The backend agent will start on this as soon as it finishes the earlier request. No result yet.";
export const NOTE_SAME_ERRAND =
  "That is the request already with the backend agent, not a new one. Nothing new was started; its result will come back on its own.";
export const NOTE_ANSWER_TO_YOU =
  "That was the user answering you, not a new request. The backend agent is still working on the earlier request; no result yet. Nothing new was started.";
export const NOTE_NOTHING_HEARD = "No request text was heard for this hand-off; ask the user to say it again.";
export const NOTE_ALLOWED = "The user allowed it on screen. The backend agent is carrying on; there's nothing for them to say or do.";
export const NOTE_DECLINED = "The user declined it on screen. The backend agent is carrying on without that step.";
export const SAY_STILL_WORKING = "Still working on it; it's taking a little longer than usual.";

export class LiveCall {
  private session: GptLiveSession | null = null;
  private record: VoiceCallRecord;
  private queue: string[] = []; // delegation ids with Claude, oldest first
  // Turns before this index were part of an earlier job.
  private jobBoundary = 0;
  // What the user was still saying when the last job went (open, not yet a turn).
  private sentOpen = "";
  private lastSaid = "";
  // Turns whose opening already went with a job (index → the words sent).
  private seenPrefix = new Map<number, string>();
  private stillTimer: number | null = null;
  private progressTimer: number | null = null;
  private lastProgressAt = -Infinity;
  private pendingProgress: string | null = null;
  private ended = false;
  private ui: LiveUi = { status: "off", side: null, level: 0 };
  private levels = { user: 0, agent: 0 };

  constructor(private opts: LiveCallOptions) {
    this.record = startCall("gpt-live", opts.after);
  }

  get callRecord(): VoiceCallRecord {
    return this.record;
  }

  /** A hand-off is with Claude right now. */
  get working(): boolean {
    return this.queue.length > 0;
  }

  private setUi(patch: Partial<LiveUi>): void {
    this.ui = { ...this.ui, ...patch };
    this.opts.onUi(this.ui);
  }

  async start(): Promise<void> {
    this.setUi({ status: "connecting" });
    let lastErr: unknown = null;
    for (const transport of this.opts.transports) {
      if (this.ended) return;
      const s = this.makeSession(transport);
      this.session = s;
      try {
        await s.start();
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        liveLog(`!! ${transport} failed: ${err instanceof Error ? err.message : String(err)}`);
        this.session = null;
        s.stop();
      }
    }
    if (this.ended) return; // hung up while connecting
    if (lastErr) {
      this.opts.onError(`couldn't start the call — ${lastErr instanceof Error ? lastErr.message : "error"}`);
      this.finish("failed");
    }
  }

  private makeSession(transport: LiveTransport): GptLiveSession {
    const make = this.opts.createSession || ((o: GptLiveOptions) => new GptLiveSession(o));
    const s: GptLiveSession = make({
      ...this.opts.session,
      transport,
      onState: (st: GptLiveState) => {
        if (st === "connecting") this.setUi({ status: "connecting" });
        else if (st === "closed") {
          // Closed without us hanging up: the call dropped.
          if (this.session === s && !this.ended) this.finish("disconnected");
        } else if (this.ui.status !== "live") {
          // No greeting: the call is live the moment it can hear.
          this.setUi({ status: "live" });
          this.opts.onLive?.();
        }
      },
      onTurn: (side, text) => {
        const before = this.record.turns.length;
        addTurn(this.record, side, text, Date.now(), this.jobBoundary);
        const norm = text.replace(/\s+/g, " ").trim();
        if (side === "user" && this.sentOpen && norm === this.sentOpen) {
          // Already went to Claude with its job while still being said:
          // seen, and not part of the next job.
          this.sentOpen = "";
          if ((this.record.claudeSaw ?? 0) >= before) this.record.claudeSaw = this.record.turns.length;
          if (this.jobBoundary >= before) this.jobBoundary = this.record.turns.length;
        } else if (side === "user" && this.sentOpen && norm.startsWith(this.sentOpen)) {
          // They kept talking after the job went: only the rest is new.
          this.seenPrefix.set(this.record.turns.length - 1, this.sentOpen);
          this.sentOpen = "";
        } else if (side === "user") {
          this.sentOpen = "";
        }
        this.opts.onTurn?.(side, text);
      },
      onLevel: (side, level) => {
        this.levels[side] = level;
        const top = this.levels.user >= this.levels.agent ? "user" : "agent";
        const val = Math.max(this.levels.user, this.levels.agent);
        this.setUi({ level: val, side: val > 0.05 ? top : null });
      },
      onDelegation: (id, text) => this.delegation(id, text),
      onError: (msg) => this.opts.onError(msg),
    });
    return s;
  }

  private delegation(id: string, open: string, retried = false): void {
    if (this.ended) return;
    const t = this.record.turns.map((x, i) => {
      const p = this.seenPrefix.get(i);
      return p && x.text.startsWith(p) ? { ...x, text: x.text.slice(p.length).trim() } : x;
    });
    let o = open.replace(/\s+/g, " ").trim();
    // Still the same open turn that already went with the last job: only
    // what's been said since counts as new.
    if (this.sentOpen && o.startsWith(this.sentOpen)) o = o.slice(this.sentOpen.length).trim();
    const { prompt, said } = handoffTask(t, this.jobBoundary, this.record.claudeSaw ?? 0, o);
    const norm = normalise(said);
    if (!said && !retried) {
      // The transcript can trail the hand-off by a moment: look again shortly.
      window.setTimeout(() => this.delegation(id, this.session?.openUserText ?? "", true), TRANSCRIPT_GRACE_MS);
      return;
    }
    if (!said) {
      // Nothing new since the last job: the voice asking again for the same errand.
      this.session?.appendThinking(this.lastSaid ? NOTE_SAME_ERRAND : NOTE_NOTHING_HEARD, id);
      return;
    }
    const ack = isJustAcknowledgement(said);
    if (this.queue.length && (ack || norm === this.lastSaid)) {
      // Their answer to the voice ("Done" after allowing a permission) while
      // the job runs, or the same words again: the same errand, so start
      // nothing (Ev's 22 Oct call: "Done" became a second job and two
      // answers came back).
      this.markSent(t.length, o);
      this.session?.appendThinking(ack ? NOTE_ANSWER_TO_YOU : NOTE_SAME_ERRAND, id);
      return;
    }
    const queued = this.queue.length > 0;
    this.queue.push(id);
    this.lastSaid = norm;
    addHandoff(this.record, id, said);
    // Claude hears all of this with the job; the next job starts after it.
    this.markSent(t.length, o);
    this.session?.appendThinking(queued ? NOTE_QUEUED : NOTE_STARTED, id);
    if (!queued) this.armStillWorking(id);
    this.opts.onHandoff(prompt, said);
  }

  private markSent(turnCount: number, open: string): void {
    this.jobBoundary = turnCount;
    this.record.claudeSaw = turnCount;
    if (open) this.sentOpen = this.sentOpen ? `${this.sentOpen} ${open}` : open;
  }

  private armStillWorking(id: string): void {
    this.clearStillWorking();
    this.stillTimer = window.setTimeout(() => {
      this.stillTimer = null;
      if (!this.ended && this.queue[0] === id) this.session?.appendCommentary(SAY_STILL_WORKING, id);
    }, STILL_WORKING_MS);
  }

  private clearStillWorking(): void {
    if (this.stillTimer) clearTimeout(this.stillTimer);
    this.stillTimer = null;
  }

  /** Claude took a step on the current hand-off: a short silent note, paced. */
  step(label: string | null): void {
    if (!this.session || !label || !this.queue.length || this.ended) return;
    this.pendingProgress = label;
    const wait = this.lastProgressAt + PROGRESS_GAP_MS - performance.now();
    if (wait <= 0) return this.flushProgress();
    if (!this.progressTimer) this.progressTimer = window.setTimeout(() => this.flushProgress(), wait);
  }

  private flushProgress(): void {
    if (this.progressTimer) clearTimeout(this.progressTimer);
    this.progressTimer = null;
    const label = this.pendingProgress;
    this.pendingProgress = null;
    if (!label || !this.session || this.ended || !this.queue.length) return;
    this.lastProgressAt = performance.now();
    this.session.appendThinking(`The backend agent is ${label}. No result yet.`, this.queue[0]);
  }

  /** Silent context for the voice (e.g. a permission answered on screen). */
  note(text: string): void {
    this.session?.appendThinking(text, this.queue[0] ?? null);
  }

  /** A permission ask answered on screen: the voice knows, quietly, so nobody has to say "done". */
  permissionAnswered(allowed: boolean): void {
    this.note(allowed ? NOTE_ALLOWED : NOTE_DECLINED);
  }

  /** Something on screen needs the user (permission ask, question): the voice knows, as in 0.6.x. */
  notifyAttention(text: string): void {
    this.session?.appendThinking(text, this.queue[0] ?? null);
  }

  /**
   * Claude finished a reply. If a hand-off is open, it's the answer: its
   * spoken part goes to the voice to say. Otherwise it came from something
   * typed in the chat: the voice knows it, silently (the user is reading it).
   */
  finishReply(markdown: string): void {
    const s = this.session;
    if (!s || this.ended) return;
    const spoken = spokenForVoice(markdown);
    if (!this.queue.length) {
      s.appendThinking(`The user typed a message in the chat during the call, and your reply there was: ${spoken}`, null);
      return;
    }
    const id = this.queue.shift()!;
    answerHandoff(this.record, spoken);
    this.pendingProgress = null;
    if (this.queue.length > 0) {
      // A newer request is already waiting: this result is out of date for
      // the voice (docs: "discard an outdated result"). Keep it as silent
      // context — it's in the chat — and let the newer one speak.
      s.appendThinking(`Earlier result, now superseded: ${spoken}`, id);
      this.armStillWorking(this.queue[0]);
      return;
    }
    this.clearStillWorking();
    s.appendCommentary(spoken, id);
  }

  setMuted(muted: boolean): void {
    this.session?.setMuted(muted);
  }

  /** The user hung up. */
  hangUp(): void {
    this.finish("hung-up");
  }

  private finish(reason: CallEndReason): void {
    if (this.ended) return;
    this.ended = true;
    this.clearStillWorking();
    if (this.progressTimer) clearTimeout(this.progressTimer);
    this.progressTimer = null;
    const s = this.session;
    this.session = null;
    try {
      s?.stop();
    } catch {}
    endCall(this.record, reason);
    this.setUi({ status: "off", side: null, level: 0 });
    this.opts.onEnded(callHasContent(this.record) ? this.record : null, reason);
  }
}

function normalise(t: string): string {
  return t.toLowerCase().replace(/[^\p{L}\p{N} ]+/gu, "").replace(/\s+/g, " ").trim();
}
