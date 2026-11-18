/**
 * What Claude is told while a voice call is on (LIVE_BACKEND_PERSONA,
 * injected as `--append-system-prompt`), and the [SCREEN]…[/SCREEN] markers
 * that replies from older voice calls carry: detail meant to be shown, never
 * spoken. Those replies are still in saved conversations, so the markers are
 * still read: stripped from what the voice is given, and shown as ordinary
 * chat text.
 */

const SCREEN_OPEN = "[SCREEN]";
const SCREEN_CLOSE = "[/SCREEN]";

/**
 * Appended to every prompt the live voice hands to Claude. Starts with
 * HANDOFF_MARKER, which is how a hand-off is recognised when a session is
 * reloaded from disk.
 */
export { HANDOFF_MARKER, HANDOFF_NOTE_TEXT as HANDOFF_NOTE } from "./voice-call";

/**
 * What Claude is told on a GPT-Live call. A separate voice model owns the
 * conversation and speaks Claude's reply in its
 * own words, so Claude never has to fill silence or keep the call alive.
 * The 0.6.x wording (OpenAI's "Start with your existing backend prompt"
 * shape), with the call bar's change: the user has the chat open beside the
 * call, so the reply is a normal chat reply whose opening works spoken.
 */
export const LIVE_BACKEND_PERSONA = `# You are the backend of a live voice call

A separate voice model is talking with the user right now, as you, in real time. When the user asks for something that needs your files, tools or knowledge, the voice hands it to you and keeps the conversation going while you work. When you reply, the voice says the opening of your reply to the user in its own words. Your whole reply also shows in the chat beside the call.

The request you receive is a voice transcript. Transcripts can contain mistakes, unfinished phrases and later corrections. Use the latest context and verified records. If a needed detail is still unclear, ask for that detail instead of guessing.

## What that means for how you answer
- **Write a normal chat reply that opens with the spoken answer.** Open with a few sentences the way you'd say them out loud: the relevant facts, whether the task is complete, and what comes next. The voice says that opening. Put any detail below it, formatted normally (lists, tables, drafts, links); the user reads it in the chat. Don't repeat detail that's already in the chat.
- **The opening is for listening.** No lists, headings, markdown, code, URLs, file paths or IDs in those first sentences. Numbers the natural way. Use confirmed values; never report an action as done unless it is. No "let me check", no "one sec", no acknowledgements — the voice already covered that.
- **Keep the plumbing hidden in the opening.** Never name tools or narrate steps there. If something failed, say what happened in plain words.
- **Sub-agents run inline, never in the background.** (Agent tool: \`run_in_background: false\`.) A background result has no way back into this conversation. The user keeps talking to the voice while an inline sub-agent runs, so nothing goes quiet — you just come back with the result when it's done.
- **Ask when you need a call made.** If something needs the user's decision or permission, say so in one line; the voice will put it to them.`;

/**
 * Make a screen block render cleanly. Obsidian's markdown renderer only
 * recognises a table when a blank line precedes it; models often put a table
 * straight under a bold heading line, which then shows as raw pipes.
 */
function tidyScreen(text: string): string {
  const lines = text.trim().split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const isTableRow = /^\s*\|/.test(line);
    const prev = out.length ? out[out.length - 1] : "";
    if (isTableRow && prev.trim() && !/^\s*\|/.test(prev)) out.push("");
    out.push(line);
  }
  return out.join("\n");
}

/**
 * Split a voice-mode reply into what gets spoken and what gets shown.
 *
 * `spoken` is the reply with every [SCREEN]…[/SCREEN] block removed (so the
 * detail is never read aloud). `screens` holds the inner text of each block, in
 * order, for the transient panel. An unclosed [SCREEN] (partial stream) is
 * treated as running to the end so nothing leaks into the spoken text.
 */
export function parseVoiceResponse(content: string): {
  spoken: string;
  screens: string[];
} {
  if (!content || !content.includes(SCREEN_OPEN)) {
    return { spoken: (content || "").trim(), screens: [] };
  }

  // Depth-counted walk so malformed markers can NEVER leak detail into speech:
  // the model sometimes double-opens ([SCREEN] … [SCREEN] … [/SCREEN]) or forgets
  // to close. Anything at depth ≥ 1 is screen content (markers stripped); only
  // depth-0 text is spoken. An unbalanced/unclosed block runs to the end as
  // screen — so the worst case is detail shown but silent, never spoken.
  const screens: string[] = [];
  let spoken = "";
  let cur = "";
  let depth = 0;
  let i = 0;
  while (i < content.length) {
    if (content.startsWith(SCREEN_OPEN, i)) {
      depth++;
      i += SCREEN_OPEN.length;
      continue;
    }
    if (content.startsWith(SCREEN_CLOSE, i)) {
      if (depth > 0) {
        depth--;
        if (depth === 0) {
          screens.push(tidyScreen(cur));
          cur = "";
        }
      }
      i += SCREEN_CLOSE.length;
      continue;
    }
    if (depth > 0) cur += content[i];
    else spoken += content[i];
    i++;
  }
  if (depth > 0 && cur.trim()) screens.push(tidyScreen(cur)); // unclosed at end

  // Collapse the blank lines the removed blocks leave behind.
  spoken = spoken.replace(/\n{3,}/g, "\n\n").trim();
  return { spoken, screens: screens.filter((s) => s.length > 0) };
}

/**
 * Show a reply's [SCREEN]…[/SCREEN] detail as part of the reply: the markers
 * go and the detail reads as normal chat text. The chat is open beside a
 * call, so detail needs no card of its own. (Replies saved by older voice
 * calls still carry the markers.) Non-voice replies never
 * contain them, so this is a no-op for them. An unclosed block (mid-stream)
 * runs to the end.
 */
export function transformScreenBlocks(text: string): string {
  if (!text || !text.includes(SCREEN_OPEN)) return text;

  const toDetail = (inner: string): string => `\n\n${tidyScreen(inner)}\n\n`;

  // Same depth-counted walk as parseVoiceResponse, so malformed/double-opened or
  // unclosed markers still render as one clean callout with no raw tags showing.
  let out = "";
  let cur = "";
  let depth = 0;
  let i = 0;
  while (i < text.length) {
    if (text.startsWith(SCREEN_OPEN, i)) {
      depth++;
      i += SCREEN_OPEN.length;
      continue;
    }
    if (text.startsWith(SCREEN_CLOSE, i)) {
      if (depth > 0) {
        depth--;
        if (depth === 0) {
          out += toDetail(cur);
          cur = "";
        }
      }
      i += SCREEN_CLOSE.length;
      continue;
    }
    if (depth > 0) cur += text[i];
    else out += text[i];
    i++;
  }
  if (depth > 0 && cur.trim()) out += toDetail(cur);
  return out.replace(/\n{3,}/g, "\n\n");
}
