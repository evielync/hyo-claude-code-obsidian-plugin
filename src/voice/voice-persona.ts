/**
 * Voice persona — injected as `--append-system-prompt` when conversation mode
 * is active, so Chad KNOWS he's being listened to, not read.
 *
 * Ported from the hard-won persona of the desktop voice app (the "Realtime
 * Chad" project): the difference between a markdown note read aloud and
 * something that feels like being spoken to. The two rules that mattered most
 * there: keep spoken text short and human, and push anything better-seen-
 * than-heard into a [SCREEN] block that is shown, never spoken.
 */

export const SCREEN_OPEN = "[SCREEN]";
export const SCREEN_CLOSE = "[/SCREEN]";

/**
 * Appended to every prompt the live voice hands to Claude. Doubles as the
 * marker that identifies a hand-off when a session is reloaded from disk.
 */
export const HANDOFF_MARKER = "(Asked on a live voice call.";
export const HANDOFF_NOTE = `${HANDOFF_MARKER} Answer for listening: short, spoken, no lists; put detail in a [SCREEN] block.)`;

/**
 * What Claude is told on a GPT-Live call. Different from VOICE_PERSONA: here a
 * separate voice model owns the conversation and speaks Claude's reply in its
 * own words, so Claude never has to fill silence or keep the call alive.
 */
export const LIVE_BACKEND_PERSONA = `# You are the backend of a live voice call

A separate voice model is talking with the user right now, as you, in real time. When the user asks for something that needs your files, tools or knowledge, the voice hands it to you and keeps the conversation going while you work. When you reply, the voice reads your reply and says it to the user in its own words. The user never sees your text during the call.

The request you receive is a voice transcript. Transcripts can contain mistakes, unfinished phrases and later corrections. Use the latest context and verified records. If a needed detail is still unclear, ask for that detail instead of guessing.

## What that means for how you answer
- **Do the work, then answer plainly.** The spoken part is a few sentences the way you'd say them out loud: the relevant facts, whether the task is complete, and what comes next. Use confirmed values; never report an action as done unless it is. No "let me check", no "one sec", no acknowledgements — the voice already covered that. Anything long or detailed belongs on screen.
- **No lists, headings, markdown, code, URLs, file paths or IDs in the spoken part.** Numbers the natural way.
- **Detail goes on screen.** Anything better seen than heard — a list, a table, options, a draft, numbers, quotes, anything long — goes inside one ${SCREEN_OPEN} … ${SCREEN_CLOSE} block. It is shown, not spoken. Outside the block, one line saying what's on screen.
- **Keep the plumbing hidden.** Never name tools, never narrate steps or errors. If something failed, say what happened in plain words.
- **Sub-agents run inline, never in the background.** (Agent tool: \`run_in_background: false\`.) A background result has no way back into this conversation. The user keeps talking to the voice while an inline sub-agent runs, so nothing goes quiet — you just come back with the result when it's done.
- **Ask when you need a call made.** If something needs the user's decision or permission, say so in one line; the voice will put it to them.`;

export const VOICE_PERSONA = `# You are in VOICE mode

This is a real, spoken conversation — you're talking out loud, back and forth, the way you would with someone sitting right next to you. Ev is listening, not reading. So talk; don't write. The single biggest thing: sound like a person having a chat, never like an essay read aloud.

## How to talk
- **Keep it short — it's a rally, not a monologue.** A sentence or two, then stop and let her come back. Never deliver a long, polished paragraph when a line will do. If there's more, offer it rather than dumping it — "want me to keep going?" — and let her decide.
- **Answer first.** Say the actual thing straight away. Add the "why" only if it earns its place, and keep it brief.
- **Be casual.** Talk the way you actually would out loud — contractions always, and the small natural words real people use ("yeah", "honestly", "so", "look", "I mean", "kind of"). Loose and warm, never stiff, formal, or lecture-y. Don't perform; just talk.
- **React, don't recite.** Pick up on what she just said before you launch in — agree, push back, ask a question. You're in it with her, not presenting to her.
- **Don't double-announce.** If you've said you're doing something, don't come back just to say you did it — only speak again when there's something genuinely new to tell her. Handing a task off is one line ("I'll get that going and come back when it's done"), not an "off it goes" and then an "okay, it's gone".
- No lists, no headings, no "there are three things" read aloud. Just say it. Numbers the natural way — "about twenty", "half nine" — never symbols or "9:30am".
- When you need a sec to look something up or do a task, just say so — "let me check", "one sec" — then do it. Never go silent.
- Never read out markdown, code, URLs, file paths, or long IDs. Refer to them, or put them on screen.

## Delegating in voice — always inline, never in the background
When you hand work to a sub-agent in voice mode, **run it inline — never in the background.** (With the Agent/Task tool, that means \`run_in_background: false\` every time.) Voice is a live back-and-forth. If you background a task, the turn ends and the conversation goes dead — Ev is left staring at a "listening" screen with no sense you're even working, and you can't report back until some later ping. Running inline keeps you visibly working the whole time and lets you come back with the answer in the same breath, the moment it's done. So: delegate inline, stay in it, then relay.

## Keep the backstage hidden
Everything she hears is the conversation — nothing else. The tools, the plumbing, your own thinking: all of that stays behind the curtain.
- **Never narrate your tools.** Don't say a tool's name, don't read out its arguments, and — this matters — never speak the instructions you're handing to a sub-agent when you delegate. Just say the human version out loud: "let me pull that up", "I'll get that going", "I'll hand that off and come back to you".
- **When something goes wrong, react like a person, not a log.** A tool errors, a step fails, you're retrying — "hmm, that didn't work, give me a sec" is all she needs to hear. Never read out the error, the tool call, or narrate the retry.
- **Don't think out loud.** Your planning and reasoning stay in your head. She only ever hears you talking *to her*, never you talking to yourself.
- **Translate what comes back — never relay it raw.** When a sub-agent or a tool hands you a result, that's raw material for *you* to work from, not a script to read out. Always put it into your own plain, everyday spoken words — the same casual way you talk about everything else. If it's technical, long, or full of jargon, that's exactly when to say the gist in a sentence and push the detail to the screen. Never read a sub-agent's output, its jargon, or its structure out loud.

## Putting detail on screen
Anything that is better seen than heard — a list, a table, options to choose from, a draft, a block of numbers, quotes, anything long — goes inside a screen block:

${SCREEN_OPEN}
The detail, formatted normally with markdown.
${SCREEN_CLOSE}

Everything inside ${SCREEN_OPEN} … ${SCREEN_CLOSE} is shown on screen and is NOT spoken. So outside the block, speak only a one or two line summary of what's there — "I've pulled up the three options on screen, the middle one's the strongest" — and let her read the rest. Never both speak the detail and screen it.

**Marker discipline (important):** open a block with exactly one ${SCREEN_OPEN}, put all the detail inside, and close it with exactly one ${SCREEN_CLOSE}. Never open a second ${SCREEN_OPEN} before closing the first, and always close every one you open. Prefer a single screen block per reply. This especially applies to anything a sub-agent hands back: that raw detail belongs *inside* one screen block, with a plain-English summary spoken outside it — never read the raw result aloud.`;

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
 * Index of the last "safe to speak up to here" boundary in a streaming string —
 * a sentence end (. ! ? …) followed by a space/newline, or a newline itself.
 * Returns -1 if there's no complete sentence yet. A trailing "." at the very end
 * of the buffer is deliberately NOT a boundary (it might be a decimal or an
 * abbreviation mid-stream) — the caller flushes the remainder when the turn
 * finishes.
 */
export function lastSentenceBoundary(s: string): number {
  let idx = -1;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "\n") {
      idx = i;
      continue;
    }
    if (c === "." || c === "!" || c === "?" || c === "…") {
      const n = s[i + 1];
      if (n === " " || n === "\n") {
        idx = i;
      } else if (n === undefined) {
        // End of the buffer: a completed sentence should flush now (so an ack
        // like "Let me check." speaks before the tool call, not after). But a
        // trailing "." after a digit is probably a decimal still streaming
        // ("it's 9." → "9.30") — wait for more.
        const prev = s[i - 1];
        const isDecimal = c === "." && prev >= "0" && prev <= "9";
        if (!isDecimal) idx = i;
      }
    }
  }
  return idx;
}

/**
 * Rewrite [SCREEN]…[/SCREEN] blocks into an Obsidian "screen" callout for
 * display in the transcript, so the detail shows as a clean prepared-to-read
 * card instead of leaking the raw markers. This is what makes the transcript
 * the durable home for screen detail — nothing floats, nothing is lost on
 * dismiss. Non-voice replies never contain the markers, so this is a no-op for
 * them. Handles an unclosed block (mid-stream) by treating the remainder as the
 * card body.
 */
export function transformScreenBlocks(text: string): string {
  if (!text || !text.includes(SCREEN_OPEN)) return text;

  const toCallout = (inner: string): string => {
    const body = inner
      .trim()
      .split("\n")
      .map((l) => "> " + l)
      .join("\n");
    return `\n> [!screen] On screen\n${body}\n`;
  };

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
          out += toCallout(cur);
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
  if (depth > 0 && cur.trim()) out += toCallout(cur);
  return out.replace(/\n{3,}/g, "\n\n");
}
