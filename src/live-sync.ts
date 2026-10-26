/**
 * What a chat shows when its conversation is shared live with other views.
 *
 * Every view of a conversation (desktop panels, the phone) is subscribed to
 * the Mac's one process for it (session-owner.ts), so a turn can start from
 * anywhere. These turn the owner's announcements into changes to the chat:
 *
 *   - `hyo_user_message`: a turn started. The sender already shows it (its
 *     `sendId` matches) or shows it queued (`queuedId`); anyone else adds it.
 *   - `hyo_queued`: a message is waiting for the turn under way. Shown queued
 *     on every view; a sender that showed it as sent moves it back to waiting.
 *   - `hyo_permission_answered`: answered somewhere; the card closes here too.
 *   - `hyo_replay`: catching up on a turn under way when the chat opens (or
 *     comes back after the connection dropped); the in-progress reply is
 *     rebuilt from the turn's events.
 *   - `hyo_queue_dropped`: messages that will never go (Claude stopped).
 *
 * Pure: shared by the desktop and phone session managers.
 */

import { openReply } from "./reply-stream";
import { startQueued } from "./send-queue";

export interface LiveMsg {
  role: string;
  content?: any;
  displayText?: string;
  streaming?: boolean;
  queuedId?: string;
  /** The id this message went to the owner with. */
  sendId?: string;
  voice?: boolean;
  voiceCall?: unknown;
  selfStarted?: boolean;
  thinking?: string;
  toolCalls?: any[];
  orderedBlocks?: any[];
  permissionRequests?: { requestId: string; resolved?: "allowed" | "denied" }[];
  planReview?: { requestId: string; resolved?: "approved" | "rejected" } | null;
  askQuestion?: { id: string } | null;
}

/** A fresh reply slot for a turn. */
export function emptyReply<M extends LiveMsg>(extra: Partial<M> = {}): M {
  return { role: "assistant", content: "", thinking: "", toolCalls: [], orderedBlocks: [], streaming: true, ...extra } as unknown as M;
}

function isEmptyReply(m: LiveMsg | undefined): boolean {
  return (
    !!m &&
    m.role === "assistant" &&
    !m.voiceCall &&
    !(typeof m.content === "string" ? m.content : "") &&
    !(m.toolCalls || []).length &&
    !(m.orderedBlocks || []).length
  );
}

export type TurnStart = "started-queued" | "already-shown" | "added";

/**
 * A turn started in the shared conversation. Returns the chat and what kind
 * of start it was: one of this view's queued messages going now, the
 * message this view just sent, or someone else's.
 */
export function turnStarted<M extends LiveMsg>(messages: M[], ev: { qid?: string; text?: string }): { messages: M[]; kind: TurnStart } {
  const qid = ev.qid;
  if (qid && messages.some((m) => m.queuedId === qid)) {
    return { messages: startQueued(messages, qid, emptyReply<M>()), kind: "started-queued" };
  }
  if (qid && messages.some((m) => m.sendId === qid)) return { messages, kind: "already-shown" };
  const said: M[] = ev.text ? [{ role: "user", content: ev.text, displayText: ev.text, sendId: qid } as M] : [];
  return { messages: openReply([...messages, ...said], emptyReply<M>()), kind: "added" };
}

/** A message waiting for the turn under way: shown queued, at the end. */
export function queued<M extends LiveMsg>(messages: M[], ev: { qid: string; text?: string }): M[] {
  if (messages.some((m) => m.queuedId === ev.qid)) return messages;
  const at = messages.findIndex((m) => m.sendId === ev.qid);
  if (at >= 0) {
    // This view showed it as sent, but another turn got there first: it waits.
    const msg = messages[at];
    const rest = [...messages.slice(0, at), ...messages.slice(at + 1)];
    if (isEmptyReply(rest[at])) rest.splice(at, 1);
    else if (rest[at]?.role === "assistant" && rest[at]?.streaming) rest[at] = { ...rest[at], selfStarted: true };
    return [...rest, { ...msg, queuedId: ev.qid }];
  }
  return [...messages, { role: "user", content: ev.text || "", displayText: ev.text || "", queuedId: ev.qid, sendId: ev.qid } as M];
}

/** Answered on another view (or this one): the card, question or plan closes everywhere. */
export function permissionAnswered<M extends LiveMsg>(messages: M[], ev: { requestId: string; behavior: string }): M[] {
  const deny = ev.behavior === "deny";
  let changed = false;
  const out = messages.map((m) => {
    let next = m;
    if (m.permissionRequests?.some((r) => r.requestId === ev.requestId && !r.resolved)) {
      next = {
        ...next,
        permissionRequests: m.permissionRequests.map((r) => (r.requestId === ev.requestId ? { ...r, resolved: deny ? ("denied" as const) : ("allowed" as const) } : r)),
      };
    }
    if (m.planReview && m.planReview.requestId === ev.requestId && !m.planReview.resolved) {
      next = { ...next, planReview: { ...m.planReview, resolved: deny ? ("rejected" as const) : ("approved" as const) } };
    }
    if (m.askQuestion && m.askQuestion.id === ev.requestId) next = { ...next, askQuestion: null };
    if (next !== m) changed = true;
    return next;
  });
  return changed ? out : messages;
}

/**
 * Before replaying a turn under way: take away whatever of it this chat
 * already shows (its reply, possibly half-built), so the replay rebuilds it
 * once. Ends with the turn's message (if a person sent it) and a fresh reply.
 */
export function replayBase<M extends LiveMsg>(messages: M[], turn: { qid?: string; text?: string; selfStarted?: boolean }): M[] {
  const qid = turn.qid;
  const at = qid ? messages.findIndex((m) => m.sendId === qid || m.queuedId === qid) : -1;
  if (at >= 0) {
    // Everything after its message is the turn's reply (anything queued
    // after it comes back with the replay's queue).
    const sent = { ...messages[at] };
    delete sent.queuedId;
    const before = messages.slice(0, at).map((m) => (m.role === "assistant" && m.streaming ? { ...m, streaming: false } : m));
    return [...before, sent, emptyReply<M>()];
  }
  let base = messages.filter((m) => !m.queuedId);
  const last = base[base.length - 1];
  if (last && last.role === "assistant" && last.streaming && !last.voiceCall) base = base.slice(0, -1);
  if (turn.selfStarted) return openReply(base, emptyReply<M>({ selfStarted: true } as Partial<M>));
  const said: M[] = turn.text ? [{ role: "user", content: turn.text, displayText: turn.text, sendId: qid } as M] : [];
  return openReply([...base, ...said], emptyReply<M>());
}

/** Messages that will never go: no longer waiting, with a line saying so. */
export function queueDropped<M extends LiveMsg>(messages: M[], qids: string[], reason?: string): M[] {
  const ids = new Set(qids);
  if (!messages.some((m) => m.queuedId && ids.has(m.queuedId))) return messages;
  const out = messages.map((m) => {
    if (!m.queuedId || !ids.has(m.queuedId)) return m;
    const c = { ...m };
    delete c.queuedId;
    return c;
  });
  const why =
    reason === "refused"
      ? "_Claude couldn't start for this conversation, so the message above wasn't sent. Send it again once the reason above is sorted._"
      : "_Claude stopped before the message above could go. Send it again to carry on._";
  return [...out, { role: "assistant", content: why, streaming: false, toolCalls: [], orderedBlocks: [] } as unknown as M];
}

/** A tab is still busy while a message of its is waiting to go. */
export function hasQueued(messages: LiveMsg[]): boolean {
  return messages.some((m) => !!m.queuedId);
}
