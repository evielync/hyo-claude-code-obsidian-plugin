// Which message a conversation is titled from, and whether its title is still
// Hyo's own placeholder (and so free to replace with a generated one).
//
// Shared by the desktop and phone session managers and the History lists on
// both, so a conversation that opens with "Hi Norm" is titled the same way
// everywhere. Pure: no Obsidian, no Node built-ins.

export const NEW_CONVERSATION_TITLE = "New conversation";

// A bare greeting opener ("hi chad", "hey", "good morning") carries no topic,
// so it's skipped when picking what to title a conversation from.
export function isTrivialOpener(text: string): boolean {
  const s = text.trim().toLowerCase().replace(/[.!,?'"]/g, "");
  if (!s) return true;
  if (s.split(/\s+/).length > 6) return false;
  return /^(hi|hey|hello|hiya|heya|yo|sup|hola|morning|good morning|good afternoon|good evening|hey there)\b/.test(
    s
  );
}

// The title a tab gets the moment its first message is sent.
export function firstSendTitle(text: string): string {
  return text.slice(0, 40) + (text.length > 40 ? "..." : "");
}

// The title History shows for a conversation nobody has named.
export function historyFallbackTitle(text: string): string {
  return text.slice(0, 60).replace(/\n/g, " ").trim();
}

/**
 * The first of `candidates` that isn't a bare greeting, or the first one if
 * they all are. Used by History, which has to show something either way.
 */
export function pickTitleText(candidates: string[]): string | null {
  let first: string | null = null;
  for (const c of candidates) {
    if (!c) continue;
    if (first === null) first = c;
    if (!isTrivialOpener(c)) return c;
  }
  return first;
}

export interface TitleMessage {
  role: string;
  content: unknown;
  displayText?: string;
  isCompaction?: boolean;
  voice?: unknown;
}

const textOf = (m: TitleMessage) => m.displayText || (typeof m.content === "string" ? m.content : "");

/**
 * The exchange to title a conversation from: the first user message with real
 * substance and the reply after it. Null while there's only a greeting (or no
 * reply yet), so the next turn tries again.
 */
export function titleSource(messages: TitleMessage[]): { userText: string; assistantText: string } | null {
  const userIdx = messages.findIndex((m) => m.role === "user" && !m.isCompaction && !isTrivialOpener(textOf(m)));
  if (userIdx < 0) return null;
  const reply = messages.slice(userIdx + 1).find((m) => m.role === "assistant" && !m.isCompaction && !m.voice);
  if (!reply) return null;
  const userText = textOf(messages[userIdx]);
  if (!userText) return null;
  return { userText, assistantText: typeof reply.content === "string" ? reply.content : "" };
}

/**
 * True while the title is still one Hyo set on its own: "New conversation",
 * or the words of an opening user message (up to the first one with
 * substance) exactly as Hyo copies them in, on first send or as the History
 * fallback. Anything else was typed by someone, or already generated, and is
 * left alone.
 */
export function isAutoTitle(title: string, messages: TitleMessage[]): boolean {
  if (title === NEW_CONVERSATION_TITLE) return true;
  for (const m of messages) {
    if (m.role !== "user" || m.isCompaction) continue;
    const t = textOf(m);
    if (!t) continue;
    if (title === firstSendTitle(t) || title === historyFallbackTitle(t)) return true;
    if (!isTrivialOpener(t)) break;
  }
  return false;
}

/**
 * What to generate a title from, or null if this conversation shouldn't get
 * one now (only a greeting so far, or its title was set by hand).
 */
export function autoTitleRequest(
  title: string,
  messages: TitleMessage[]
): { userText: string; assistantText: string } | null {
  const src = titleSource(messages);
  if (!src) return null;
  return isAutoTitle(title, messages) ? src : null;
}
