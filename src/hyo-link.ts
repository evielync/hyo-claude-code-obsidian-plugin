import { useEffect, useRef } from "react";

// Hyo's own link, so a Shortcut or anything that opens a URL can jump
// straight into the chat panel without a second plugin:
//
//   obsidian://hyo?vault=<vault>                      opens Hyo
//   obsidian://hyo?vault=<vault>&session=<id>         opens that conversation
//   obsidian://hyo?vault=<vault>&prompt=<text>        a new conversation with
//                                                     <text> in the message box
//
// session and prompt together put the text in that conversation's box. The
// text is never sent for you: it waits in the box so you can check it first.
// main.ts registers the handler; the chat panel (desktop and phone) picks the
// request up through useHyoLink.

export interface HyoLinkRequest {
  session?: string;
  prompt?: string;
}

/** The request a link carries, or null when it only opens Hyo. */
export function parseHyoLink(params: Record<string, string | undefined>): HyoLinkRequest | null {
  const session = (params.session || "").trim();
  const prompt = params.prompt || "";
  if (!session && !prompt.trim()) return null;
  const req: HyoLinkRequest = {};
  if (session) req.session = session;
  if (prompt.trim()) req.prompt = prompt;
  return req;
}

/** Where the plugin parks a link request until the chat panel takes it. */
export interface HyoLinkHost {
  pendingLink: HyoLinkRequest | null;
  openLink: ((req: HyoLinkRequest) => void) | null;
}

interface LinkTab {
  id: string;
  cliSessionId: string | null;
}

interface UseHyoLinkArgs<P extends { id: string }> {
  host: HyoLinkHost;
  tabs: LinkTab[];
  activeTabId: string;
  pastSessions: P[];
  newTab: () => void;
  switchTab: (id: string) => void;
  openPastSession: (p: P) => void;
  // Makes a stand-in for a conversation History hasn't loaded (older than
  // its window), so it can still be opened by id.
  pastFor: (id: string) => P;
  setDraft: (tabId: string, text: string) => void;
}

export function useHyoLink<P extends { id: string }>(args: UseHyoLinkArgs<P>): void {
  const argsRef = useRef(args);
  argsRef.current = args;

  // Text waiting to go into a message box, and how to know it's the right tab:
  // either the tab for a given conversation, or the new tab (any tab that
  // isn't the one that was active when the link arrived).
  const pendingDraft = useRef<{ text: string; session?: string; fromTab?: string } | null>(null);

  useEffect(() => {
    const host = args.host;
    const open = (req: HyoLinkRequest) => {
      const a = argsRef.current;
      if (req.session) {
        const live = a.tabs.find((t) => t.cliSessionId === req.session);
        if (live) a.switchTab(live.id);
        else a.openPastSession(a.pastSessions.find((p) => p.id === req.session) || a.pastFor(req.session));
        if (req.prompt) pendingDraft.current = { text: req.prompt, session: req.session };
      } else if (req.prompt) {
        pendingDraft.current = { text: req.prompt, fromTab: a.activeTabId };
        a.newTab();
      }
      flush();
    };
    host.openLink = open;
    if (host.pendingLink) {
      const req = host.pendingLink;
      host.pendingLink = null;
      open(req);
    }
    return () => {
      if (host.openLink === open) host.openLink = null;
    };
  }, [args.host]);

  function flush() {
    const p = pendingDraft.current;
    if (!p) return;
    const a = argsRef.current;
    const active = a.tabs.find((t) => t.id === a.activeTabId);
    const ready = p.session ? active?.cliSessionId === p.session : !!active && a.activeTabId !== p.fromTab;
    if (!ready) return;
    pendingDraft.current = null;
    a.setDraft(a.activeTabId, p.text);
  }

  useEffect(flush, [args.activeTabId, args.tabs]);
}
