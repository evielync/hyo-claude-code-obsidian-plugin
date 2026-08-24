// Mobile replacement for ClaudeTransport. Same public interface (spawn,
// sendUserMessage, sendPermissionResponse, sendInterrupt, stop, isRunning)
// so the hooks that drive the chat UI (useSessionManager, useChatEngine)
// need almost no change — only the object they `new` up.
//
// Desktop's ClaudeTransport owns a real `claude` child_process per tab.
// GatewayTransport owns nothing locally: it registers this tab's id with
// the shared GatewayClient socket and forwards whatever the gateway streams
// back for that tabId to `onMessage`, exactly like ClaudeTransport forwards
// parsed stdout lines.

import { debug } from "./debug";
import { GatewayClient } from "./gateway-client";

// Sonnet 5 runs 1M context natively and doesn't accept a "[1m]" suffix —
// kept here (moved from the retired claude-transport.ts) since settings/UI
// no longer carry a model field at all, but stale saved data could.
export function normalizeModelId(id: string): string {
  if (id.startsWith("claude-sonnet-5") && id.includes("[1m]")) {
    return "claude-sonnet-5";
  }
  return id;
}

export interface TransportOptions {
  gatewayUrl: string;
  // Identifies this conversation to the gateway. Should stay stable for the
  // lifetime of a chat tab so reconnects/interrupts/stops target the right
  // server-side process. Auto-generated if omitted.
  tabId?: string;
  sessionId?: string;
  resume?: boolean;
  // Voice mode only: the spoken-conversation persona, sent with every prompt so
  // the gateway applies it via --append-system-prompt on any (re)spawn. Undefined
  // in text mode, so text sessions are unchanged.
  appendSystemPrompt?: string;
  onMessage: (msg: any) => void;
  onError: (error: string) => void;
  onClose: (code: number | null) => void;
  // Kept for structural parity with ClaudeTransport's TransportOptions —
  // the gateway locks these server-side (always agent "chad", Sonnet 5,
  // permission-mode "default"), so none of these are sent over the wire.
  cliPath?: string;
  cwd?: string;
  model?: string;
  permissionMode?: string;
  agent?: string;
  maxOutputTokens?: number;
}

function genTabId(): string {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

// The gateway's `prompt` RPC only carries plain text — image/PDF blocks
// aren't part of the current wire protocol. Flatten any content array to
// text, noting what had to be dropped, rather than silently losing it.
function flattenContentBlocks(blocks: any[]): string {
  const textParts: string[] = [];
  let droppedMedia = 0;
  for (const b of blocks) {
    if (b?.type === "text" && b.text) textParts.push(b.text);
    else if (b?.type === "image" || b?.type === "document") droppedMedia++;
  }
  if (droppedMedia > 0) {
    textParts.push(
      `[${droppedMedia} attached image/PDF file(s) were not sent — image and PDF attachments aren't supported over the mobile gateway yet.]`
    );
  }
  return textParts.join("\n\n");
}

export class GatewayTransport {
  private client: GatewayClient;
  private tabId: string;
  private options: TransportOptions;
  private running = false;

  constructor(options: TransportOptions) {
    this.options = options;
    this.tabId = options.tabId || genTabId();
    this.client = GatewayClient.get(options.gatewayUrl);
  }

  spawn(): void {
    this.client.registerTab(this.tabId, (msg) => {
      if (msg.type === "stream") {
        // Learn the CLI's real session id the moment it reports one. The
        // gateway kills every live process when the socket drops and
        // respawns on the next prompt, so the id we send has to track the
        // live session — not stay frozen at whatever we were constructed
        // with (undefined, for a chat that started fresh). Without this, a
        // respawn silently starts a brand-new session and the conversation
        // loses all its history.
        const ev = msg.event;
        if (ev?.type === "system" && ev?.subtype === "init" && ev.session_id) {
          this.options.sessionId = ev.session_id;
          this.options.resume = true;
        }
        this.options.onMessage(ev);
      } else if (msg.type === "closed") {
        this.running = false;
        this.options.onClose(msg.code);
      } else if (msg.type === "error") {
        this.options.onError(msg.error);
      }
    });
    this.running = true;
    debug("[hyo-gateway] Tab registered:", this.tabId);
  }

  sendUserMessage(content: string | any[], askFirst?: boolean): void {
    const text = typeof content === "string" ? content : flattenContentBlocks(content);
    // sessionId/resume are consulted by the gateway whenever it has no live
    // process for this tabId — the first prompt, and again after any socket
    // drop (the gateway reaps its processes on disconnect). They're kept
    // current from the CLI's own init event, so a respawn resumes the same
    // session rather than starting a fresh one. askFirst likewise reflects
    // the live "Ask First" toggle at send time rather than being fixed at spawn.
    this.client.sendPrompt(this.tabId, text, this.options.sessionId, this.options.resume, askFirst, this.options.appendSystemPrompt, this.options.agent, this.options.model);
  }

  sendPermissionResponse(
    requestId: string,
    behavior: "allow" | "allow_always" | "deny",
    toolName?: string,
    updatedInput?: Record<string, unknown>
  ): void {
    this.client.sendPermission(this.tabId, requestId, behavior, toolName, updatedInput);
  }

  sendInterrupt(): void {
    this.client.interrupt(this.tabId);
  }

  stop(): void {
    this.running = false;
    this.client.stop(this.tabId);
  }

  isRunning(): boolean {
    return this.running;
  }
}

// Desktop used this to gate onboarding on whether the local CLI binary
// existed. There's no local CLI on mobile — the gateway owns the Claude
// process — so this always reports true. Connection health is surfaced
// separately via GatewayClient's connection-status observable.
export function checkCliExists(_cliPath: string): boolean {
  return true;
}
