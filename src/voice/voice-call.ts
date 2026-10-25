/**
 * One voice call, kept as one record. Spoken turns never go into the chat:
 * the call collapses into a single "Voice chat · 01:38" line where it ended
 * (after the work done on it, the way Grok Bot does it), and tapping the
 * line opens this record's transcript. Claude's work
 * from the call's hand-offs shows in the chat as normal messages.
 *
 * Pure (no Obsidian, no Node), shared by desktop, the phone and the gateway.
 * Persisted in session-metadata.json under `voiceCalls`, next to where the
 * older per-turn `voiceTurns` lived; those are read back as calls.
 */

export type CallSide = "user" | "agent";
export type CallEndReason = "hung-up" | "disconnected" | "failed";
export type CallEngine = "gpt-live" | "elevenlabs";

export interface VoiceCallTurn {
  side: CallSide;
  text: string;
  at: string; // ISO
}

export interface VoiceCallHandoff {
  id: string;
  request: string;
  at: string; // ISO
  /** Claude's reply, as given to the voice. Empty until it lands. */
  answer?: string;
  answeredAt?: string;
  /** Still running when the call ended: its result went to the chat instead. */
  afterCall?: boolean;
}

export interface VoiceCallRecord {
  id: string;
  engine: CallEngine;
  startedAt: string; // ISO
  endedAt?: string;
  durationMs?: number;
  endReason?: CallEndReason;
  turns: VoiceCallTurn[];
  handoffs: VoiceCallHandoff[];
  /**
   * Where the line sits: before the Claude message at this index. Set at
   * hang-up to the finished Claude messages so far, so the line comes after
   * everything that happened on the call; a hand-off still running lands
   * after it. Same counting as the old VoiceTurn.after.
   */
  after: number;
  /**
   * How many finished Claude messages there were at hang-up. Anything Claude
   * finishes past this landed after the call — what the next greeting can
   * mention.
   */
  endAfter?: number;
  /**
   * How many of `turns` Claude has been given. The rest ride along with the
   * next thing sent to Claude in that conversation — a hand-off or a typed
   * message, even after a reopen.
   */
  claudeSaw?: number;
}

let seq = 0;
export function newCallId(now: number = Date.now()): string {
  return `call_${now.toString(36)}_${(++seq).toString(36)}`;
}

export function startCall(engine: CallEngine, after: number, now: number = Date.now()): VoiceCallRecord {
  return {
    id: newCallId(now),
    engine,
    startedAt: new Date(now).toISOString(),
    turns: [],
    handoffs: [],
    after,
  };
}

/** A finished spoken turn. Consecutive turns from the same side merge. */
export function addTurn(call: VoiceCallRecord, side: CallSide, text: string, now: number = Date.now(), mergeFrom = 0): void {
  const t = text.replace(/\s+/g, " ").trim();
  if (!t) return;
  const last = call.turns[call.turns.length - 1];
  // Never merge into a turn that's already gone out with a job (index < mergeFrom).
  if (last && call.turns.length - 1 >= mergeFrom && last.side === side && now - Date.parse(last.at) < 1500) {
    last.text = `${last.text} ${t}`;
    return;
  }
  call.turns.push({ side, text: t, at: new Date(now).toISOString() });
}

export function addHandoff(call: VoiceCallRecord, id: string, request: string, now: number = Date.now()): void {
  call.handoffs.push({ id, request: request.trim(), at: new Date(now).toISOString() });
}

/** The oldest hand-off without an answer gets this one (Claude answers in order). */
export function answerHandoff(call: VoiceCallRecord, answer: string, now: number = Date.now()): VoiceCallHandoff | null {
  const h = call.handoffs.find((x) => x.answer === undefined && !x.afterCall);
  if (!h) return null;
  h.answer = answer.trim();
  h.answeredAt = new Date(now).toISOString();
  return h;
}

export function endCall(call: VoiceCallRecord, reason: CallEndReason, now: number = Date.now()): VoiceCallRecord {
  if (call.endedAt) return call;
  call.endedAt = new Date(now).toISOString();
  call.durationMs = Math.max(0, now - Date.parse(call.startedAt));
  call.endReason = reason;
  for (const h of call.handoffs) if (h.answer === undefined) h.afterCall = true;
  return call;
}

/** A call worth keeping: someone said something, or something was handed off. */
export function callHasContent(call: VoiceCallRecord): boolean {
  return call.turns.length > 0 || call.handoffs.length > 0;
}

/** 01:38, or 1:02:05 past the hour. */
export function formatCallDuration(ms: number | undefined): string {
  const s = Math.max(0, Math.round((ms || 0) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}

export function endReasonLabel(reason: CallEndReason | undefined): string {
  if (reason === "disconnected") return "The call dropped";
  if (reason === "failed") return "The call couldn't connect";
  return "You hung up";
}

// ---------------------------------------------------------------------------
// Older sessions: per-turn `voiceTurns` → calls
// ---------------------------------------------------------------------------

export interface LegacyVoiceTurn {
  side: CallSide;
  text: string;
  at: string;
  after: number;
}

const LEGACY_GAP_MS = 10 * 60 * 1000;

/**
 * Turns saved by 0.6.x, one per line, grouped back into calls: a new call
 * starts after a ten-minute silence. The line sits where the last turn was.
 */
export function callsFromLegacyTurns(turns: LegacyVoiceTurn[]): VoiceCallRecord[] {
  const calls: VoiceCallRecord[] = [];
  let cur: VoiceCallRecord | null = null;
  let lastAt = 0;
  for (const t of turns) {
    const at = Date.parse(t.at) || lastAt;
    if (!cur || at - lastAt > LEGACY_GAP_MS) {
      cur = {
        id: `legacy_${at.toString(36)}_${calls.length}`,
        engine: "gpt-live",
        startedAt: new Date(at).toISOString(),
        turns: [],
        handoffs: [],
        after: t.after,
      };
      calls.push(cur);
    }
    cur.turns.push({ side: t.side, text: t.text, at: new Date(at).toISOString() });
    cur.after = t.after;
    cur.endedAt = new Date(at).toISOString();
    cur.durationMs = at - Date.parse(cur.startedAt);
    cur.endReason = "hung-up";
    // 0.6.x showed these turns in the thread and sent them with the next
    // message; treat them as already seen.
    cur.claudeSaw = cur.turns.length;
    lastAt = at;
  }
  return calls;
}

/** Saved calls first, then any older turns that no saved call already covers. */
export function mergeStoredCalls(calls: VoiceCallRecord[] | undefined, legacy: LegacyVoiceTurn[] | undefined): VoiceCallRecord[] {
  const out = [...(calls || [])];
  if (legacy?.length) out.push(...callsFromLegacyTurns(legacy));
  return out.sort((a, b) => a.after - b.after || Date.parse(a.startedAt) - Date.parse(b.startedAt));
}

/** Insert or replace (by id). */
export function upsertCall(list: VoiceCallRecord[] | undefined, call: VoiceCallRecord): VoiceCallRecord[] {
  const out = (list || []).filter((c) => c.id !== call.id);
  out.push(call);
  return out;
}

// ---------------------------------------------------------------------------
// The thread
// ---------------------------------------------------------------------------

/** Anything with an optional call record on it — desktop and phone messages both fit. */
export interface CallCarrier {
  voiceCall?: VoiceCallRecord;
}

/** How many messages count as Claude's (call lines don't). */
export function claudeMessageCount<M extends CallCarrier>(messages: M[]): number {
  let n = 0;
  for (const m of messages) if (!m.voiceCall) n++;
  return n;
}

/**
 * Thread calls into the Claude messages: each call line goes in before the
 * Claude message at index `after` (where the call ended). `make` turns a
 * record into a message.
 */
export function threadCalls<M extends CallCarrier>(
  claudeMessages: M[],
  calls: VoiceCallRecord[],
  make: (call: VoiceCallRecord) => M
): M[] {
  if (!calls.length) return claudeMessages;
  const sorted = [...calls].sort((a, b) => a.after - b.after || Date.parse(a.startedAt) - Date.parse(b.startedAt));
  const out: M[] = [];
  let ci = 0;
  for (let i = 0; i <= claudeMessages.length; i++) {
    while (ci < sorted.length && sorted[ci].after <= i) out.push(make(sorted[ci++]));
    if (i < claudeMessages.length) out.push(claudeMessages[i]);
  }
  while (ci < sorted.length) out.push(make(sorted[ci++]));
  return out;
}

/** Insert one call line where it belongs in an existing thread. */
export function insertCallLine<M extends CallCarrier>(messages: M[], line: M & { voiceCall: VoiceCallRecord }): M[] {
  const after = line.voiceCall.after;
  let claude = 0;
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].voiceCall) continue;
    if (claude === after) return [...messages.slice(0, i), line, ...messages.slice(i)];
    claude++;
  }
  return [...messages, line];
}

// ---------------------------------------------------------------------------
// Hand-off prompts
// ---------------------------------------------------------------------------

/** Appended to every prompt the live voice hands to Claude; also how a hand-off is recognised on reload. */
export const HANDOFF_MARKER = "(Asked on a live voice call.";
export const VOICE_EXCERPT_END = "[End of voice call excerpt]";

/** The spoken request inside a hand-off prompt: after any voice-call excerpt, before the marker. */
export function handoffRequestText(content: string): string {
  let t = content;
  const i = t.indexOf(VOICE_EXCERPT_END);
  if (i >= 0) t = t.slice(i + VOICE_EXCERPT_END.length);
  const j = t.indexOf(HANDOFF_MARKER);
  if (j >= 0) t = t.slice(0, j);
  return t.trim();
}

/**
 * Spoken turns Claude hasn't seen, as a block to put in front of whatever
 * goes to Claude next (a hand-off or a typed message).
 */
export function unseenTurnsBlock(turns: VoiceCallTurn[]): string {
  if (!turns.length) return "";
  const lines = turns.map((t) => `${t.side === "user" ? "User" : "You (voice)"}: ${t.text}`);
  return `[Said on a voice call just now — your voice model handled these turns; you haven't seen them yet]\n${lines.join("\n")}\n${VOICE_EXCERPT_END}`;
}

// ---------------------------------------------------------------------------
// Replies → what the voice says
// ---------------------------------------------------------------------------

const SCREEN_RE = /\[SCREEN\][\s\S]*?(\[\/SCREEN\]|$)/g;

/** Markdown → something a voice can read: no syntax, links as their words. */
export function plainForVoice(md: string): string {
  return md
    .replace(SCREEN_RE, " ")
    .replace(/\[\/?SCREEN\]/g, " ")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
    .replace(/\[\[([^\]]+)\]\]/g, (_m, p: string) => p.split("/").pop() || p)
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(^|[\s(])[*_]([^*_\n]+)[*_](?=[\s).,!?:;]|$)/g, "$1$2")
    .replace(/^>\s?/gm, "")
    .replace(/[ \t]+/g, " ")
    .trim();
}

/** The spoken part fits one append (≤ 500 tokens). */
export const SPOKEN_MAX_CHARS = 1200;

/**
 * What the voice says for Claude's reply: the spoken part (everything
 * outside [SCREEN] blocks, which stay in the chat), as plain words. As 0.6.x:
 * an empty spoken part with detail on screen is "It's on screen now."
 */
export function spokenForVoice(markdown: string): string {
  const plain = plainForVoice(markdown || "");
  if (plain.length > SPOKEN_MAX_CHARS) {
    // Claude wrote more than a spoken answer: the facts up front, the rest
    // stays in the chat (docs: give GPT-Live the relevant facts; keep
    // lengthy output in the backend). One append, never a burst.
    const cut = plain.slice(0, SPOKEN_MAX_CHARS - 40);
    const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "), cut.lastIndexOf("\n"));
    return `${(end > 200 ? cut.slice(0, end + 1) : cut).trim()} (The rest is in the chat.)`;
  }
  if (plain) return plain;
  return (markdown || "").includes("[SCREEN]") ? "It's in the chat now." : "Done.";
}

/** Finished Claude messages right now — where a call ending now goes (`after`, `endAfter`). */
export function finishedClaudeCount<M extends CallCarrier & { streaming?: boolean }>(messages: M[]): number {
  let n = 0;
  for (const m of messages) if (!m.voiceCall && !m.streaming) n++;
  return n;
}

// ---------------------------------------------------------------------------
// What Claude hasn't heard yet
// ---------------------------------------------------------------------------

/**
 * Spoken turns Claude hasn't been given, from the finished calls in a thread
 * plus the call that's on now (if any). Returns the turns, in order, and the
 * records it advanced (`claudeSaw` moved to the end) so the caller can save
 * them. ElevenLabs calls are skipped: there, every turn already went to Claude.
 */
export function takeUnseenTurns<M extends CallCarrier>(
  messages: M[],
  current: VoiceCallRecord | null = null
): { turns: VoiceCallTurn[]; advanced: VoiceCallRecord[] } {
  const turns: VoiceCallTurn[] = [];
  const advanced: VoiceCallRecord[] = [];
  const take = (c: VoiceCallRecord) => {
    if (c.engine !== "gpt-live") return;
    const from = c.claudeSaw ?? 0;
    if (from >= c.turns.length) return;
    turns.push(...c.turns.slice(from));
    c.claudeSaw = c.turns.length;
    advanced.push(c);
  };
  for (const m of messages) if (m.voiceCall && m.voiceCall !== current) take(m.voiceCall);
  if (current) take(current);
  return { turns, advanced };
}

// ---------------------------------------------------------------------------
// Conversations that start as a call
// ---------------------------------------------------------------------------

/** A fresh session id for Claude (`--session-id` takes a UUID). */
export function newSessionId(): string {
  const c: any = (globalThis as any).crypto;
  if (c?.randomUUID) return c.randomUUID();
  const b = new Uint8Array(16);
  if (c?.getRandomValues) c.getRandomValues(b);
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/**
 * How to start Claude for a tab. A conversation Hyo has named but Claude
 * hasn't written yet (it began as a call) starts with `--session-id`, so it
 * becomes that same conversation; one Claude has written is resumed.
 */
export function sessionSpawn(cliSessionId: string | null, pending: boolean | undefined): { sessionId?: string; resume: boolean } {
  if (!cliSessionId) return { resume: false };
  return { sessionId: cliSessionId, resume: !pending };
}

/** A title for a conversation that began as a call: the first thing the user said. */
export function titleFromCall(call: VoiceCallRecord, max = 40): string {
  const first = call.turns.find((t) => t.side === "user")?.text || "";
  if (!first) return "Voice chat";
  return first.length > max ? first.slice(0, max).trimEnd() + "..." : first;
}

export interface MetaEntry {
  customTitle?: string;
  pinned?: boolean;
  closed?: boolean;
  lastActive?: string;
  voiceCalls?: VoiceCallRecord[];
  voiceTurns?: LegacyVoiceTurn[];
}

export interface CallOnlySession {
  id: string;
  title: string;
  date: number; // ms
  lastRole: "user" | "assistant" | null;
  lastSnippet: string;
  pinned: boolean;
  closed: boolean;
  lastActive?: string;
}

/**
 * Conversations that exist only as voice calls in Hyo's metadata — nothing
 * was ever sent to Claude, so there's no transcript file — listed so they
 * show in history like any other.
 */
export function callOnlySessions(metadata: Record<string, MetaEntry>, hasTranscript: (id: string) => boolean): CallOnlySession[] {
  const out: CallOnlySession[] = [];
  for (const [id, m] of Object.entries(metadata || {})) {
    const calls = m?.voiceCalls || [];
    if (!calls.length || hasTranscript(id)) continue;
    const sorted = [...calls].sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
    const last = sorted[sorted.length - 1];
    const lastTurn = last.turns[last.turns.length - 1];
    out.push({
      id,
      title: m.customTitle || titleFromCall(sorted[0], 60),
      date: Date.parse(last.endedAt || last.startedAt) || 0,
      lastRole: lastTurn ? (lastTurn.side === "user" ? "user" : "assistant") : null,
      lastSnippet: lastTurn ? lastTurn.text.slice(0, 160) : "",
      pinned: !!m.pinned,
      closed: !!m.closed,
      lastActive: m.lastActive,
    });
  }
  return out;
}

/**
 * Stamp a finished call with where it goes in the thread: after the Claude
 * messages that are done, so a reply still streaming lands after the line.
 */
export function placeAtHangUp<M extends CallCarrier & { streaming?: boolean }>(call: VoiceCallRecord, messages: M[]): VoiceCallRecord {
  const n = finishedClaudeCount(messages);
  call.after = n;
  call.endAfter = n;
  return call;
}

/**
 * What adding a finished call does to its tab, worked out in one place (the
 * desktop and phone session managers both use it): the conversation id to
 * save under — the tab's, or a new one if Claude was never used in it — and
 * the title for a conversation that began as this call.
 */
export function callHome(tab: { cliSessionId: string | null; title: string }, call: VoiceCallRecord, mint: () => string = newSessionId): {
  sessionId: string;
  minted: boolean;
  title?: string;
} {
  if (tab.cliSessionId) return { sessionId: tab.cliSessionId, minted: false };
  return { sessionId: mint(), minted: true, title: tab.title === "New conversation" ? titleFromCall(call) : undefined };
}

// ---------------------------------------------------------------------------
// The job Claude is handed
// ---------------------------------------------------------------------------

/**
 * What goes to Claude when the voice hands over a job. GPT-Live's
 * delegation event carries only an id, so the request is built from what
 * was said: everything the user has said since the last job, word for word
 * (closed turns plus the one still being spoken). In front of it, as in
 * 0.6.x, the call turns Claude hasn't seen yet (including what the voice
 * said, so a "yes" to the voice's question makes sense); after it 0.6.x's
 * hand-off note.
 *
 * `since` is the index of the first turn after the last job; `open` is the
 * user's words still being transcribed when the job was handed over.
 */
export function handoffTask(
  turns: VoiceCallTurn[],
  since: number,
  claudeSaw: number,
  open: string
): { prompt: string; said: string } {
  const norm = (t: string) => t.replace(/\s+/g, " ").trim();
  const recent = turns.slice(since);
  const userWords = recent.filter((t) => t.side === "user").map((t) => norm(t.text)).filter(Boolean);
  const o = norm(open);
  if (o && !userWords.some((w) => w === o || w.endsWith(o))) userWords.push(o);
  const said = userWords.join(" ");
  if (!said) return { prompt: "", said: "" };
  const unseen = turns.slice(Math.min(claudeSaw, since)).filter((t) => norm(t.text));
  const parts: string[] = [];
  if (unseen.length) parts.push(unseenTurnsBlock(unseen));
  parts.push(said);
  parts.push(HANDOFF_NOTE_TEXT);
  return { prompt: parts.join("\n\n"), said };
}

/** 0.6.x's note on every hand-off (also in voice-persona.ts as HANDOFF_NOTE). */
export const HANDOFF_NOTE_TEXT = `${HANDOFF_MARKER} Answer for listening: short, spoken, no lists; put detail in a [SCREEN] block.)`;

/**
 * Words that only answer the voice or agree ("Done", "yes", "go ahead",
 * "I've allowed it", "mhm"). Grok: "Any confirming noise is agreement" and
 * "Asking again for something you already started is the same errand:
 * start nothing." While a job is running, these are never a new job.
 */
const ACK_WORDS = new Set(
  "done yes yeah yep yup ok okay k sure go ahead allowed allow it i i've ive have did clicked that's thats all set right cool great perfect thanks thank you mhm mm hmm uh huh alright fine sounds good there it is now".split(" ")
);
export function isJustAcknowledgement(text: string): boolean {
  const words = text
    .toLowerCase()
    .replace(/[^a-z' ]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length || words.length > 8) return false;
  return words.every((w) => ACK_WORDS.has(w));
}

/** About you from a chosen note: its body, without the frontmatter block. */
export function aboutYouFromNote(text: string): string {
  return (text || "").replace(/^---\s*\n[\s\S]*?\n---\s*(\n|$)/, "").trim();
}
