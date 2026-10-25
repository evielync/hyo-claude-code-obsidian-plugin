/**
 * Messages sent while Claude is still answering wait their turn.
 *
 * Claude's process answers one turn at a time, and the chat writes the
 * streaming reply into the last reply slot. A message sent mid-turn used to
 * get its own slot straight away, so the reply still streaming spilled into
 * it and the turn boundaries fell apart: replies replaced each other, and on
 * a call the voice never heard the later answers. Now a message sent while a
 * turn runs shows at once, marked queued, and goes to Claude when the turn
 * ends; its reply slot is made then, right after it.
 *
 * Pure: shared by the desktop and phone session managers.
 */

export interface QueueMsg {
  role: string;
  streaming?: boolean;
  /** Shown in the chat, waiting for Claude to finish the current turn. */
  queuedId?: string;
}

/** Add an outgoing message: with its reply slot now, or queued if Claude is busy. */
export function addOutgoing<M extends QueueMsg>(messages: M[], user: M, reply: M, busy: boolean, queuedId: string): M[] {
  if (busy) return [...messages, { ...user, queuedId }];
  return [...messages, user, reply];
}

/** The oldest message waiting to go, if any. */
export function nextQueued<M extends QueueMsg>(messages: M[]): M | null {
  return messages.find((m) => !!m.queuedId) || null;
}

/** It's going now: it stops being queued, and its reply slot goes right after it. */
export function startQueued<M extends QueueMsg>(messages: M[], queuedId: string, reply: M): M[] {
  const i = messages.findIndex((m) => m.queuedId === queuedId);
  if (i < 0) return [...messages, reply];
  const sent = { ...messages[i] };
  delete sent.queuedId;
  return [...messages.slice(0, i), sent, reply, ...messages.slice(i + 1)];
}

/** The reply being written: the last reply slot that isn't a call line. */
export function lastReplyIndex<M extends QueueMsg & { voiceCall?: unknown }>(messages: M[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant" && !messages[i].voiceCall) return i;
  }
  return -1;
}
