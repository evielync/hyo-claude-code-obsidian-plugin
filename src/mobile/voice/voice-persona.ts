/**
 * The [SCREEN]…[/SCREEN] markers that replies from older voice calls carry:
 * detail meant to be shown, never spoken. Those replies are still in saved
 * conversations, so they're shown here as ordinary chat text.
 */

const SCREEN_OPEN = "[SCREEN]";
const SCREEN_CLOSE = "[/SCREEN]";

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

  const toDetail = (inner: string): string => `\n\n${inner.trim()}\n\n`;

  // Depth-counted, so malformed/double-opened or unclosed markers still render
  // as one clean block with no raw tags showing.
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
