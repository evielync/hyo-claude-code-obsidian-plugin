/**
 * The main chat: one long conversation with the person's own agent, pinned as
 * the first tab, that never blocks. Almost every ask goes to a background
 * agent (Claude Code's Agent tool with run_in_background), the chat answers at
 * once with a line naming the job, and each result comes back as its own
 * reply when Claude Code's task notification starts a new turn.
 *
 * The behaviour comes from the instructions, the way Grok Bot does it. The
 * wording below is Cursor 3.24.18's "Multitask Mode" prompt (afe / ife / lfe in
 * module-81719.js, the same agent family as Grok Bot; research copy in
 * ~/Dropbox/chad/research/grok-bot-text-delegation/multitask-mode-prompt.raw.js),
 * ported with three changes for Claude Code inside Hyo:
 *   - "coding agent" and the `Task` tool become the person's agent and Claude
 *     Code's `Agent` tool; follow-ups to running work go through SendMessage.
 *   - Cursor shows each worker's summary to the user itself, so it tells the
 *     model not to restate results. Hyo shows only the main chat's replies,
 *     so the model reports each result in plain words. (Ours.)
 *   - The reply on delegating is one short line naming the job ("Checking your
 *     personal Gmail for Westpac."), what Grok Bot does. (Ours.)
 *
 * Pure apart from the strings: shared by desktop, phone and the tests.
 */

export const MAIN_CHAT_PROMPT = [
  "# Main chat",
  "",
  "This is the main chat: one long, ongoing conversation with the person. They send you several asks in a row and expect you to stay free for the next one, the whole time.",
  "",
  "You are not just a worker. You are also a coordinator who pushes meaningful work to asynchronous agents through your `Agent` tool, with `run_in_background` set to `true`.",
  "",
  "Your priority is to efficiently and accurately complete the user's request with help from background workers. For most non-trivial user requests, usually launch or resume one coherent worker subagent and let that worker send back its response.",
  "",
  "After delegating the only coherent worker task for a user request, do not continue doing the same investigation, implementation, or answer synthesis in the foreground. Only do distinct coordination work, answer a new independent user question, or synthesize after multiple workers return.",
  "",
  "NEVER await or sleep while waiting for a running subagent to complete. Just end your response and you will be notified when the subagent completes.",
  "",
  "DO NOT aggressively decompose small or medium tasks into many sibling agents. This is primarily about moving substantial work out of the foreground, not about maximizing the number of parallel agents.",
  "",
  "IMPORTANT RULE: After starting a background subagent to handle the user's request, you MUST end your response IMMEDIATELY. You will be woken up via an automated system notification when the subagent completes. DO NOT WAIT FOR THE ASYNC SUBAGENT TO COMPLETE! DO NOT REPEAT WORK IN THE FOREGROUND THAT THE AGENT IS DOING!",
  "",
  "## When to delegate",
  "",
  "You should generally delegate to a background subagent whenever any of the below criteria are met:",
  "- When completing the task requires running a possibly long-running shell command.",
  "- When the task to be completed will likely take more than just one tool call.",
  "- When the task requires making any non-trivial edits.",
  "- When the task consists of an end-to-end loop such as \"Find where X is, and change it\" or \"Work out why this happened and fix it.\" These are usually one worker task, not several sibling agents.",
  "- When using a background subagent would allow you to coordinate other independent top-level task(s) that are required to fulfill the user's request(s).",
  "",
  "When to use multiple sibling background subagents:",
  "- When the request naturally separates into independent top-level deliverables or separate user asks.",
  "",
  "When not to delegate tasks to background subagents:",
  "- When the task is a single, straightforward task that can be completed in just one quick tool call (and that tool call is not a long-running shell command).",
  "- When answering quick clarification questions from the user, where all context required to answer the question is already available in your chat history, or is discoverable via just one quick tool call. (Otherwise, start or resume one coherent subagent to answer the user's question.)",
  "",
  "For trivial user requests (i.e. user requests that can be fully completed with NO or ONE tool calls), disregard these delegation instructions and fulfill the request directly.",
  "",
  "In the foreground, act as the coordinator: route work and launch or resume agents. Before each foreground tool call, distinguish coordination work from the worker task you already delegated. If the next tool call would do the delegated worker task, stop.",
  "",
  "If the user adds to or changes an ask that is still running, send it to that agent with SendMessage instead of starting the work again.",
  "",
  "Give each background agent a brief it can work from alone: what to find or do, where to look, and what done looks like. Background agents can't ask the user questions, so put everything they need in the brief.",
  "",
  "## What the user sees",
  "",
  "When you delegate, reply with one short line that names the job in plain words, for example \"Checking your personal Gmail for Westpac.\" Then end your turn.",
  "",
  "The user does not see the background agents' reports, only your replies. When an agent finishes and you are woken with its result, tell the user what came of it in plain words: the answer itself, not how it was found. When several finish together, cover each.",
  "",
  "DO NOT mention these steps to the user. You may explain the thought process behind your task decomposition, delegation, and parallelization if asked, but DO NOT share the details of your thought process preemptively. Your ability to multitask should feel natural and seamless to the user.",
].join("\n");

/**
 * Sent with every message in the main chat, the job lfe() does in Cursor:
 * without it the model slides back into doing the work itself as the chat
 * gets long. Wrapped as a system reminder, which both history parsers already
 * strip, so it never shows as part of the person's message.
 */
export const MAIN_CHAT_REMINDER =
  "<system-reminder>\n" +
  "You are still in the main chat. You MUST follow the earlier instructions for asynchronous delegation and parallelization of work.\n" +
  "Decide whether to delegate the user request to a background subagent (default action), parallelize the request across multiple subagents, or address the request directly.\n" +
  "Remember: work in the foreground prohibits multitasking. Reserve for requests requiring zero or one (non-long-running) tool calls.\n" +
  "Do NOT perform foreground work which duplicates work already delegated to subagent(s).\n" +
  "</system-reminder>";

/** The person's message with the reminder after it. Slash commands go as they are. */
export function withMainChatReminder(content: string | any[]): string | any[] {
  if (typeof content === "string") {
    if (content.trimStart().startsWith("/")) return content;
    return `${content}\n\n${MAIN_CHAT_REMINDER}`;
  }
  if (!Array.isArray(content)) return content;
  return [...content, { type: "text", text: MAIN_CHAT_REMINDER }];
}

/** Everything a tab appends to the system prompt: the main chat's part, then the voice persona. */
export function appendedPrompt(isMain: boolean | undefined, persona: string | undefined): string | undefined {
  const parts = [isMain ? MAIN_CHAT_PROMPT : "", persona || ""].filter(Boolean);
  return parts.length ? parts.join("\n\n") : undefined;
}

// ---- The pinned tab ---------------------------------------------------------

export const MAIN_CHAT_TITLE = "Main chat";

interface TabLike {
  id: string;
  isMain?: boolean;
  cliSessionId: string | null;
  messages: unknown[];
}

/** The main chat always sits first; every other tab keeps its order. */
export function mainFirst<T extends TabLike>(tabs: T[]): T[] {
  const i = tabs.findIndex((t) => t.isMain);
  if (i <= 0) return tabs;
  return [tabs[i], ...tabs.slice(0, i), ...tabs.slice(i + 1)];
}

/**
 * Tabs with the main chat on or off. On: a main tab is added first if there
 * isn't one (`make` builds it). Off: the main tab becomes an ordinary tab, so
 * nothing running in it is stopped.
 */
export function withMainChat<T extends TabLike>(tabs: T[], enabled: boolean, make: () => T): T[] {
  const has = tabs.some((t) => t.isMain);
  if (enabled) return has ? mainFirst(tabs) : [make(), ...tabs];
  if (!has) return tabs;
  return tabs.map((t) => (t.isMain ? { ...t, isMain: false } : t));
}

/** The main chat can't be closed. */
export function canCloseTab(tab: { isMain?: boolean } | undefined): boolean {
  return !!tab && !tab.isMain;
}

/**
 * Where a dragged tab may land. Nothing moves the main chat or drops in front
 * of it; returns false to refuse the move.
 */
export function canReorder(tabs: TabLike[], draggedId: string, targetId: string, after: boolean): boolean {
  const dragged = tabs.find((t) => t.id === draggedId);
  const target = tabs.find((t) => t.id === targetId);
  if (!dragged || !target || dragged.isMain) return false;
  if (target.isMain && !after) return false;
  return true;
}

/**
 * The tab to show when Hyo opens. With the main chat on and nothing else
 * restored, it's the main chat; otherwise the tab that was active last time.
 */
export function startupActive(tabs: TabLike[], restoredActiveId: string | null | undefined): string | undefined {
  const others = tabs.filter((t) => !t.isMain && (t.cliSessionId || t.messages.length > 0));
  const main = tabs.find((t) => t.isMain);
  if (main && others.length === 0) return main.id;
  if (restoredActiveId) {
    const hit = tabs.find((t) => (t as any).cliSessionId === restoredActiveId);
    if (hit) return hit.id;
  }
  return (others[others.length - 1] || main || tabs[0])?.id;
}
