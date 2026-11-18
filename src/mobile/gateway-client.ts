// Singleton WebSocket client for the Hyo mobile gateway.
//
// Desktop Hyo spawns `claude` locally via child_process and reads
// ~/.claude directly. Mobile has no Node, so every session/history/prompt
// operation instead goes over one shared WebSocket to a gateway process
// running on the Mac (see hyo-mobile-gateway/server/hyo-gateway.mjs for the
// exact wire protocol this client speaks). One physical connection is
// shared by every open chat tab — each message carries a tabId so the
// gateway (and this client) can route concurrent conversations over the
// single pipe.

import { debug } from "./debug";
import { parseEntries, type OpenEntry } from "../open-conversations";
import type { PromptContentBlock } from "../types/content-blocks";
import { isRecord, str } from "../types/gateway-json";

export type ConnectionStatus =
  | "connecting"
  | "connected"
  | "disconnected"
  | "reconnecting";

export type TabMessage =
  // A Claude Code stream-json event, forwarded as the Mac's process wrote it.
  | { type: "stream"; event: unknown }
  // The conversation's process ended. `subscribed`: this tab still hears the
  // conversation (the next message starts a new process). `gone`: the Mac no
  // longer has this tab (it was away too long, or the Mac restarted).
  | { type: "closed"; code: number | null; subscribed?: boolean; gone?: boolean }
  | { type: "error"; error: string };

// The client passes these through as the Mac sent them; the history loader
// (mobile/session-parser.ts) reads them.
/** A page of a conversation's history from the Mac (newest first when opened). */
export interface HistoryReply {
  /** Parsed messages (a paging Mac). */
  messages?: unknown[];
  /** Raw transcript lines (a Mac from before paging). */
  lines?: unknown[];
  /** The conversation's saved voice calls. */
  voiceCalls: unknown[];
  /** Index of the first message in the whole conversation. */
  offset: number;
  total: number;
  model?: string | null;
}

/** What repairing a conversation on the Mac came to (its session-repair.ts result). */
export interface RepairReply {
  success: boolean;
  linesRemoved: number;
  capturedUserText: string | null;
  reason?: string;
}

function isRepairReply(v: unknown): v is RepairReply {
  return (
    isRecord(v) &&
    typeof v.success === "boolean" &&
    typeof v.linesRemoved === "number" &&
    (typeof v.capturedUserText === "string" || v.capturedUserText === null) &&
    (v.reason === undefined || typeof v.reason === "string")
  );
}

export interface ClaudeUpdateResult {
  ok: boolean;
  error?: string;
  /** The gateway Mac runs a Hyo that can't update Claude for the phone. */
  unsupported?: boolean;
}

// A gateway that knows update_claude answers "started" at once. Silence past
// this means an older Hyo on the Mac.
const CLAUDE_UPDATE_ACK_MS = 10_000;
// The update itself (updater, then installer) can take a few minutes.
const CLAUDE_UPDATE_MAX_MS = 8 * 60_000;

export type TabHandler = (msg: TabMessage) => void;

interface PendingRPC<T> {
  resolve: (v: T) => void;
  reject: (e: Error) => void;
  timer: number;
}

const RPC_TIMEOUT_MS = 35_000;
// Opening a conversation waits on this, with "Loading conversation…" on
// screen, so it's shorter than the other requests: long enough for a big
// conversation over a slow connection, short enough not to leave a spinner.
export const HISTORY_TIMEOUT_MS = 30_000;
const MAX_BACKOFF_MS = 30_000;
const MAX_QUEUED_MESSAGES = 200;

/** Search hits from the Mac: session id → the matched line. */
function searchHits(raw: unknown): Record<string, string> {
  const hits: Record<string, string> = {};
  if (!isRecord(raw)) return hits;
  for (const [id, line] of Object.entries(raw)) if (typeof line === "string") hits[id] = line;
  return hits;
}

function genId(): string {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

export class GatewayClient {
  private static instance: GatewayClient | null = null;

  private url: string;
  private ws: WebSocket | null = null;
  private status: ConnectionStatus = "disconnected";
  private statusListeners = new Set<(s: ConnectionStatus) => void>();
  private tabHandlers = new Map<string, TabHandler>();
  private reconnectAttempts = 0;
  private reconnectTimer: number | null = null;
  private destroyed = false;
  private outbox: string[] = [];

  // Lists the Mac sends; the hooks that show them read each row.
  private sessionsQueue: PendingRPC<unknown[]>[] = [];
  private agentsQueue: PendingRPC<unknown[]>[] = [];
  private skillsQueue: PendingRPC<unknown[]>[] = [];
  private searchQueue: PendingRPC<Record<string, string>>[] = [];
  // Live voice: the desktop signs the phone's WebRTC offer and tells it which
  // engine/voice is set. Keyed by requestId.
  private liveSdpPending = new Map<string, PendingRPC<{ sdp: string }>>();
  private liveConfigPending = new Map<string, PendingRPC<{ engine: string; voice: string }>>();
  // History requests, by request id (older Macs answer by session id only).
  private historyPending = new Map<string, PendingRPC<HistoryReply> & { sessionId: string }>();
  // The shared open list (open-conversations.ts): pushed by the Mac whenever
  // it changes. Listeners also run after every reconnect.
  private openListeners = new Set<(entries: OpenEntry[], meta: { ack?: number; sync?: number }) => void>();
  private connectListeners = new Set<() => void>();
  private renamePending = new Map<string, PendingRPC<string>>();
  private repairPending = new Map<string, PendingRPC<RepairReply>>();
  private titlePending = new Map<string, PendingRPC<string | null>>();
  // Claude updates run on the Mac; progress comes back as it goes.
  private claudeUpdatePending = new Map<
    string,
    {
      onPhase: (m: string) => void;
      resolve: (r: ClaudeUpdateResult) => void;
      started: boolean;
      timer: number;
    }
  >();

  // One connection per gateway URL. If settings change the URL, tear down
  // the old socket and open a fresh one.
  static get(url: string): GatewayClient {
    if (GatewayClient.instance && GatewayClient.instance.url === url && !GatewayClient.instance.destroyed) {
      return GatewayClient.instance;
    }
    GatewayClient.instance?.destroy();
    GatewayClient.instance = new GatewayClient(url);
    return GatewayClient.instance;
  }

  private constructor(url: string) {
    this.url = url;
    this.connect();
  }

  // ---- connection status ----

  private setStatus(s: ConnectionStatus): void {
    if (this.status === s) return;
    this.status = s;
    for (const l of this.statusListeners) l(s);
  }

  getStatus(): ConnectionStatus {
    return this.status;
  }

  onStatusChange(listener: (s: ConnectionStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  // ---- connection lifecycle ----

  private connect(): void {
    if (this.destroyed) return;
    if (!this.url) {
      this.setStatus("disconnected");
      return;
    }

    this.setStatus(this.reconnectAttempts > 0 ? "reconnecting" : "connecting");

    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch (e) {
      debug("[hyo-gateway] Failed to construct WebSocket:", e);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      debug("[hyo-gateway] Connected:", this.url);
      this.reconnectAttempts = 0;
      this.setStatus("connected");
      // Reattach FIRST, before flushing any queued prompts. The gateway held
      // each of our tabs' processes in a grace period while the socket was
      // down (it no longer kills them on disconnect). This reattach re-binds
      // those living tabs to the new socket and makes the gateway flush
      // whatever it buffered while we were gone — so a reply that finished
      // mid-background shows up the moment we return. Sending it before the
      // queued prompts means any message typed during the outage lands on the
      // re-bound live process rather than forking a fresh session.
      const tabIds = Array.from(this.tabHandlers.keys());
      if (tabIds.length > 0 && this.ws?.readyState === WebSocket.OPEN) {
        debug("[hyo-gateway] Reattaching tabs:", tabIds.length);
        this.ws.send(JSON.stringify({ type: "reattach", tabIds }));
      }
      // The Mac forgets what a phone was reading when it disconnects: say it again.
      if (this.viewingId !== undefined && this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: "viewing", id: this.viewingId }));
      }
      const queued = this.outbox;
      this.outbox = [];
      for (const msg of queued) {
        if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(msg);
      }
      // After the queue, so anything asked for here is answered with what
      // was sent while offline already applied.
      for (const l of [...this.connectListeners]) {
        try {
          l();
        } catch (e) {
          console.error("[hyo] A gateway reconnect listener failed:", e);
        }
      }
    };

    ws.onmessage = (ev: MessageEvent<unknown>) => {
      let msg: unknown;
      try {
        msg = JSON.parse(typeof ev.data === "string" ? ev.data : String(ev.data));
      } catch {
        return;
      }
      if (isRecord(msg)) this.handleMessage(msg);
    };

    ws.onclose = () => {
      debug("[hyo-gateway] Closed");
      this.ws = null;
      // Do NOT tell tabs they're closed here. The gateway now holds each live
      // tab's process in a grace period when our socket drops (see
      // hyo-gateway.mjs) instead of killing it — so an in-flight conversation
      // is still running on the Mac. Blanking it here is exactly the bug that
      // made backgrounding the app look like it killed the chat. We keep the
      // transports "running", reconnect, and send a `reattach` (in ws.onopen)
      // that flushes whatever streamed while we were gone.
      //
      // The two cases that DO end a tab still settle it correctly on their own:
      // a genuine process exit arrives as a per-tab `gateway/tab_closed`
      // message, and a tab whose grace expired before we reconnected comes back
      // in the `reattached` reply's `gone` list (both handled in handleMessage).
      if (this.destroyed) {
        this.setStatus("disconnected");
        return;
      }
      this.scheduleReconnect();
    };

    ws.onerror = (e) => {
      debug("[hyo-gateway] Socket error:", e);
    };
  }

  private scheduleReconnect(): void {
    if (this.destroyed) return;
    this.setStatus("reconnecting");
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), MAX_BACKOFF_MS);
    this.reconnectAttempts++;
    if (this.reconnectTimer) window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = window.setTimeout(() => this.connect(), delay);
  }

  destroy(): void {
    this.destroyed = true;
    if (this.reconnectTimer) window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    try {
      this.ws?.close();
    } catch {
      // Already closed
    }
    this.ws = null;
    this.tabHandlers.clear();
    this.statusListeners.clear();
    for (const p of this.sessionsQueue) {
      window.clearTimeout(p.timer);
      p.reject(new Error("Gateway connection closed"));
    }
    this.sessionsQueue = [];
    for (const p of this.agentsQueue) {
      window.clearTimeout(p.timer);
      p.reject(new Error("Gateway connection closed"));
    }
    this.agentsQueue = [];
    for (const p of this.skillsQueue) {
      window.clearTimeout(p.timer);
      p.reject(new Error("Gateway connection closed"));
    }
    this.skillsQueue = [];
    for (const p of this.searchQueue) {
      window.clearTimeout(p.timer);
      p.reject(new Error("Gateway connection closed"));
    }
    this.searchQueue = [];
    for (const p of this.historyPending.values()) {
      window.clearTimeout(p.timer);
      p.reject(new Error("Gateway connection closed"));
    }
    this.historyPending.clear();
    this.openListeners.clear();
    this.connectListeners.clear();
    for (const map of [this.renamePending, this.titlePending, this.repairPending]) {
      for (const p of map.values()) {
        window.clearTimeout(p.timer);
        p.reject(new Error("Gateway connection closed"));
      }
      map.clear();
    }
  }

  // ---- outgoing ----

  private send(obj: Record<string, unknown>): void {
    const payload = JSON.stringify(obj);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(payload);
    } else {
      // Queue while disconnected — flushed on reconnect. Bounded so a long
      // outage can't leak memory.
      this.outbox.push(payload);
      if (this.outbox.length > MAX_QUEUED_MESSAGES) this.outbox.shift();
    }
  }

  // ---- incoming message routing ----

  // Everything from the Mac is read defensively: an older or newer Hyo there
  // may send a message with fields this phone doesn't expect.
  private handleMessage(msg: Record<string, unknown>): void {
    switch (msg.type) {
      case "stream": {
        const tabId = str(msg.tabId);
        if (tabId !== undefined) this.tabHandlers.get(tabId)?.({ type: "stream", event: msg.event });
        return;
      }
      case "sessions": {
        const pending = this.sessionsQueue.shift();
        if (pending) {
          window.clearTimeout(pending.timer);
          pending.resolve(Array.isArray(msg.sessions) ? msg.sessions : []);
        }
        return;
      }
      case "agents": {
        const pending = this.agentsQueue.shift();
        if (pending) {
          window.clearTimeout(pending.timer);
          pending.resolve(Array.isArray(msg.agents) ? msg.agents : []);
        }
        return;
      }
      case "skills": {
        const pending = this.skillsQueue.shift();
        if (pending) {
          window.clearTimeout(pending.timer);
          pending.resolve(Array.isArray(msg.skills) ? msg.skills : []);
        }
        return;
      }
      case "search_results": {
        const pending = this.searchQueue.shift();
        if (pending) {
          window.clearTimeout(pending.timer);
          pending.resolve(searchHits(msg.hits));
        }
        return;
      }
      case "history": {
        // voiceCalls: from a gateway that has them; older ones send none.
        const result: HistoryReply = msg.paged
          ? {
              messages: Array.isArray(msg.messages) ? msg.messages : [],
              voiceCalls: Array.isArray(msg.voiceCalls) ? msg.voiceCalls : [],
              offset: typeof msg.offset === "number" ? msg.offset : 0,
              total: typeof msg.total === "number" ? msg.total : 0,
              model: typeof msg.model === "string" ? msg.model : null,
            }
          : { lines: Array.isArray(msg.lines) ? msg.lines : [], voiceCalls: Array.isArray(msg.voiceCalls) ? msg.voiceCalls : [], offset: 0, total: 0 };
        const requestId = str(msg.requestId);
        const byRequest = requestId !== undefined ? this.historyPending.get(requestId) : undefined;
        const waiting = requestId !== undefined && byRequest
          ? [[requestId, byRequest] as const]
          : [...this.historyPending.entries()].filter(([, p]) => p.sessionId === msg.sessionId);
        for (const [id, p] of waiting) {
          this.historyPending.delete(id);
          window.clearTimeout(p.timer);
          p.resolve(result);
        }
        return;
      }
      case "open_list": {
        const entries = parseEntries(msg.entries);
        const meta = {
          ack: typeof msg.ack === "number" ? msg.ack : undefined,
          sync: typeof msg.sync === "number" ? msg.sync : undefined,
        };
        for (const l of [...this.openListeners]) {
          try {
            l(entries, meta);
          } catch (e) {
            console.error("[hyo] Applying the open conversations failed:", e);
          }
        }
        return;
      }
      case "claude_update": {
        const requestId = str(msg.requestId);
        const pending = requestId !== undefined ? this.claudeUpdatePending.get(requestId) : undefined;
        if (requestId === undefined || !pending) return;
        if (msg.phase === "started") {
          pending.started = true;
          window.clearTimeout(pending.timer);
          pending.timer = window.setTimeout(() => {
            this.claudeUpdatePending.delete(requestId);
            pending.resolve({ ok: false, error: "The update took too long" });
          }, CLAUDE_UPDATE_MAX_MS);
        } else if (msg.phase === "progress") {
          if (typeof msg.message === "string") pending.onPhase(msg.message);
        } else if (msg.phase === "done") {
          this.claudeUpdatePending.delete(requestId);
          window.clearTimeout(pending.timer);
          pending.resolve({ ok: !!msg.ok, error: str(msg.error) });
        }
        return;
      }
      case "task_meta_set":
      case "voice_call_saved":
        // Fire-and-forget acks; the list refresh that follows picks up the state.
        return;
      case "live_sdp_answer":
      case "live_sdp_error": {
        const requestId = str(msg.requestId);
        const pending = requestId !== undefined ? this.liveSdpPending.get(requestId) : undefined;
        if (requestId !== undefined && pending) {
          this.liveSdpPending.delete(requestId);
          window.clearTimeout(pending.timer);
          const sdp = str(msg.sdp);
          if (msg.type === "live_sdp_answer" && sdp !== undefined) pending.resolve({ sdp });
          else pending.reject(new Error(str(msg.message) || "The desktop couldn't start the call"));
        }
        return;
      }
      case "live_config": {
        const requestId = str(msg.requestId);
        const pending = requestId !== undefined ? this.liveConfigPending.get(requestId) : undefined;
        if (requestId !== undefined && pending) {
          this.liveConfigPending.delete(requestId);
          window.clearTimeout(pending.timer);
          pending.resolve({ engine: str(msg.engine) || "elevenlabs", voice: str(msg.voice) || "marin" });
        }
        return;
      }
      case "repair_result": {
        const requestId = str(msg.requestId);
        const pending = requestId !== undefined ? this.repairPending.get(requestId) : undefined;
        if (requestId !== undefined && pending) {
          this.repairPending.delete(requestId);
          window.clearTimeout(pending.timer);
          pending.resolve(
            isRepairReply(msg.result)
              ? msg.result
              : { success: false, linesRemoved: 0, capturedUserText: null, reason: "your Mac's answer couldn't be read" }
          );
        }
        return;
      }
      case "renamed": {
        const sessionId = str(msg.sessionId);
        const pending = sessionId !== undefined ? this.renamePending.get(sessionId) : undefined;
        if (sessionId !== undefined && pending) {
          this.renamePending.delete(sessionId);
          window.clearTimeout(pending.timer);
          pending.resolve(str(msg.title) ?? "");
        }
        return;
      }
      case "title": {
        const requestId = str(msg.requestId);
        const pending = requestId !== undefined ? this.titlePending.get(requestId) : undefined;
        if (requestId !== undefined && pending) {
          this.titlePending.delete(requestId);
          window.clearTimeout(pending.timer);
          pending.resolve(str(msg.title) || null);
        }
        return;
      }
      case "gateway": {
        if (msg.subtype === "reattached") {
          // Reply to the reattach we sent on reconnect. `attached` tabs are
          // already taken care of — the gateway flushed their buffered stream
          // events (as normal `stream` messages) before sending this reply, so
          // those conversations just resume on screen. `gone` tabs are the ones
          // whose grace expired (or the gateway restarted) before we got back:
          // their server process no longer exists. Settle each so its spinner
          // clears; the conversation history is preserved and the next prompt
          // resumes it from the saved session id.
          const gone = Array.isArray(msg.gone) ? msg.gone.filter((id): id is string => typeof id === "string") : [];
          for (const tabId of gone) {
            this.tabHandlers.get(tabId)?.({ type: "closed", code: null, gone: true });
          }
          return;
        }
        const tabId = str(msg.tabId);
        if (msg.subtype === "tab_closed" && tabId) {
          this.tabHandlers.get(tabId)?.({ type: "closed", code: typeof msg.code === "number" ? msg.code : null, subscribed: msg.subscribed === true });
          return;
        }
        if (msg.subtype === "error") {
          if (tabId) {
            this.tabHandlers.get(tabId)?.({ type: "error", error: str(msg.error) || "Unknown gateway error" });
          } else {
            debug("[hyo-gateway] Gateway error:", msg.error);
          }
        }
        return;
      }
    }
  }

  // ---- per-tab streaming ----

  registerTab(tabId: string, onEvent: TabHandler): void {
    this.tabHandlers.set(tabId, onEvent);
  }

  unregisterTab(tabId: string): void {
    this.tabHandlers.delete(tabId);
  }

  // `content` carries the full Anthropic content-block array when the message
  // has images or PDFs attached; `text` carries the same message flattened to
  // plain text. Both go on the wire every time. The gateway prefers `content`
  // and falls back to `text`, so a phone running ahead of the Mac's gateway
  // still delivers the words instead of failing the send.
  sendPrompt(
    tabId: string,
    text: string,
    sessionId?: string,
    resume?: boolean,
    askFirst?: boolean,
    appendSystemPrompt?: string,
    agent?: string,
    model?: string,
    content?: PromptContentBlock[],
    extra: { qid?: string; silent?: boolean; permissionMode?: string; effort?: string } = {}
  ): void {
    this.send({ type: "prompt", tabId, text, content, sessionId, resume, askFirst, appendSystemPrompt, agent, model, ...extra });
  }

  sendPermission(
    tabId: string,
    requestId: string,
    behavior: "allow" | "allow_always" | "deny",
    toolName?: string,
    updatedInput?: Record<string, unknown>
  ): void {
    this.send({ type: "permission_response", tabId, requestId, behavior, toolName, updatedInput });
  }

  interrupt(tabId: string): void {
    this.send({ type: "interrupt", tabId });
  }

  /** "Send now" on a message waiting in this conversation: the Mac sends it into the reply under way. */
  sendNow(tabId: string, qid: string): void {
    this.send({ type: "send_now", tabId, qid });
  }

  // What this phone has on screen, for unread replies (read-state.ts on the Mac).
  private viewingId: string | null | undefined = undefined;

  /** Tell the Mac which conversation this phone has on screen (null: none). It's read. */
  setViewing(id: string | null): void {
    if (this.viewingId === id) return;
    this.viewingId = id;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: "viewing", id }));
  }

  /** Start hearing a conversation live in this tab, caught up on any turn under way. */
  attach(tabId: string, sessionId?: string | null): void {
    this.send({ type: "attach", tabId, sessionId: sessionId || undefined });
  }

  /**
   * Repair a conversation poisoned by an orphaned thinking block, on the Mac
   * (the desktop's own repair). Resolves with its result; never hangs.
   */
  repairSession(sessionId: string): Promise<RepairReply> {
    const requestId = genId();
    return new Promise((resolve) => {
      const timer = window.setTimeout(() => {
        this.repairPending.delete(requestId);
        resolve({ success: false, linesRemoved: 0, capturedUserText: null, reason: this.status === "connected" ? "your Mac didn't answer in time" : "can't reach your Mac right now" });
      }, RPC_TIMEOUT_MS);
      this.repairPending.set(requestId, { resolve, reject: () => {}, timer });
      this.send({ type: "repair_session", requestId, sessionId });
    });
  }

  /** Change a conversation's reasoning effort on the Mac. */
  setEffort(tabId: string, sessionId: string | undefined, effort: string): void {
    this.send({ type: "set_effort", tabId, sessionId, effort });
  }

  /** Change a conversation's model on the Mac. */
  setModel(tabId: string, sessionId: string | undefined, model: string): void {
    this.send({ type: "set_model", tabId, sessionId, model });
  }

  /** Change a conversation's permission mode on the Mac. */
  setPermissionMode(tabId: string, sessionId: string | undefined, mode: string): void {
    this.send({ type: "set_permission_mode", tabId, sessionId, mode });
  }

  /** Stop the conversation's process on the Mac so the next message starts a fresh one (once nothing runs in it). */
  restart(tabId: string): void {
    this.send({ type: "restart", tabId });
  }

  stop(tabId: string): void {
    this.send({ type: "stop", tabId });
    this.unregisterTab(tabId);
  }

  // ---- promise-based RPCs ----

  /** Which voice engine and voice the desktop has set; the phone follows it. */
  liveConfig(): Promise<{ engine: string; voice: string }> {
    const requestId = `lc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.liveConfigPending.delete(requestId);
        reject(new Error("live_config timed out"));
      }, RPC_TIMEOUT_MS);
      this.liveConfigPending.set(requestId, { resolve, reject, timer });
      this.send({ type: "live_config", requestId });
    });
  }

  /**
   * Ask the desktop to sign a WebRTC offer with OpenAI and return the answer.
   * The desktop builds the session (its key, voice, personality, the tab's
   * agent identity) so nothing secret lives on the phone.
   */
  liveSdp(
    sdp: string,
    agent: string,
    history: Array<{ role: "user" | "assistant"; text: string }>
  ): Promise<{ sdp: string }> {
    const requestId = `ls_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.liveSdpPending.delete(requestId);
        reject(new Error("The desktop didn't answer the call request in time"));
      }, 20000);
      this.liveSdpPending.set(requestId, { resolve, reject, timer });
      this.send({ type: "live_sdp", requestId, sdp, agent, history });
    });
  }

  listSessions(): Promise<unknown[]> {
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        const idx = this.sessionsQueue.findIndex((p) => p.resolve === resolve);
        if (idx >= 0) this.sessionsQueue.splice(idx, 1);
        reject(new Error("list_sessions timed out"));
      }, RPC_TIMEOUT_MS);
      this.sessionsQueue.push({ resolve, reject, timer });
      this.send({ type: "list_sessions" });
    });
  }

  // Full-text search over past sessions. The gateway reads the files; the
  // phone gets back session id → matched line.
  searchSessions(query: string): Promise<Record<string, string>> {
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        const idx = this.searchQueue.findIndex((p) => p.resolve === resolve);
        if (idx >= 0) this.searchQueue.splice(idx, 1);
        reject(new Error("search_sessions timed out"));
      }, RPC_TIMEOUT_MS);
      this.searchQueue.push({ resolve, reject, timer });
      this.send({ type: "search_sessions", query });
    });
  }

  listAgents(): Promise<unknown[]> {
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        const idx = this.agentsQueue.findIndex((p) => p.resolve === resolve);
        if (idx >= 0) this.agentsQueue.splice(idx, 1);
        reject(new Error("list_agents timed out"));
      }, RPC_TIMEOUT_MS);
      this.agentsQueue.push({ resolve, reject, timer });
      this.send({ type: "list_agents" });
    });
  }

  listSkills(): Promise<unknown[]> {
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        const idx = this.skillsQueue.findIndex((p) => p.resolve === resolve);
        if (idx >= 0) this.skillsQueue.splice(idx, 1);
        reject(new Error("list_skills timed out"));
      }, RPC_TIMEOUT_MS);
      this.skillsQueue.push({ resolve, reject, timer });
      this.send({ type: "list_skills" });
    });
  }

  /**
   * A page of a conversation's history and its saved voice calls: the newest
   * part, or the part before message `before`. With `tabId` (opening it),
   * the Mac also starts sending that tab the conversation live, beginning
   * with any turn under way. Always settles: the answer, or an error naming
   * why after HISTORY_TIMEOUT_MS.
   */
  getHistory(sessionId: string, opts: { tabId?: string; before?: number; timeoutMs?: number } = {}): Promise<HistoryReply> {
    const requestId = `h_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        if (!this.historyPending.delete(requestId)) return;
        reject(
          new Error(
            this.status === "connected"
              ? "Your Mac didn't send it within 30 seconds."
              : "Can't reach your Mac right now."
          )
        );
      }, opts.timeoutMs ?? HISTORY_TIMEOUT_MS);
      this.historyPending.set(requestId, { resolve, reject, timer, sessionId });
      this.send({ type: "get_history", sessionId, requestId, tabId: opts.tabId, before: opts.before });
    });
  }

  // ---- the shared open list ----

  /** Hear the Mac's open list whenever it changes. Returns the unsubscribe. */
  onOpenList(listener: (entries: OpenEntry[], meta: { ack?: number; sync?: number }) => void): () => void {
    this.openListeners.add(listener);
    return () => {
      this.openListeners.delete(listener);
    };
  }

  /** Run after every (re)connect, once what was queued offline has gone. */
  onConnected(listener: () => void): () => void {
    this.connectListeners.add(listener);
    return () => {
      this.connectListeners.delete(listener);
    };
  }

  /** Ask for the whole list (and to be sent every change after it). */
  openSync(requestId: number): void {
    this.send({ type: "open_list", requestId });
  }

  openAdd(id: string, title: string, opId: number): void {
    this.send({ type: "open_add", id, title, opId });
  }

  openRemove(id: string, opId: number): void {
    this.send({ type: "open_remove", id, opId });
  }

  openRename(id: string, title: string, opId: number): void {
    this.send({ type: "open_rename", id, title, opId });
  }

  openReplace(oldId: string, id: string, title: string, opId: number): void {
    this.send({ type: "open_replace", oldId, id, title, opId });
  }

  rename(sessionId: string, title: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.renamePending.delete(sessionId);
        reject(new Error("rename timed out"));
      }, RPC_TIMEOUT_MS);
      this.renamePending.set(sessionId, { resolve, reject, timer });
      this.send({ type: "rename", sessionId, title });
    });
  }

  // Fire-and-forget: save a finished voice call to the conversation's shared
  // metadata on the gateway (insert, or replace the record with that id).
  saveVoiceCall(sessionId: string, call: unknown, title?: string): void {
    this.send({ type: "save_voice_call", sessionId, call, title });
  }

  // Fire-and-forget: persist pinned/closed to the shared metadata on the
  // gateway. Caller refreshes the session list afterwards to see the result.
  setTaskMeta(sessionId: string, patch: { pinned?: boolean; closed?: boolean; lastActive?: string }): void {
    this.send({ type: "set_task_meta", sessionId, patch });
  }

  // Mirrors the server's own behaviour: never rejects, resolves null on
  // failure/timeout so callers can just keep the existing title.
  generateTitle(userMessage: string, assistantMessage: string): Promise<string | null> {
    const requestId = genId();
    return new Promise((resolve) => {
      const timer = window.setTimeout(() => {
        this.titlePending.delete(requestId);
        resolve(null);
      }, RPC_TIMEOUT_MS);
      this.titlePending.set(requestId, { resolve, reject: () => resolve(null), timer });
      this.send({ type: "generate_title", requestId, userMessage, assistantMessage });
    });
  }

  /**
   * Ask the gateway Mac to update Claude. Never rejects: an older gateway
   * that doesn't know the request comes back as `unsupported`.
   */
  updateClaude(required: string, onPhase: (message: string) => void): Promise<ClaudeUpdateResult> {
    const requestId = genId();
    return new Promise((resolve) => {
      const timer = window.setTimeout(() => {
        this.claudeUpdatePending.delete(requestId);
        resolve({ ok: false, unsupported: true });
      }, CLAUDE_UPDATE_ACK_MS);
      this.claudeUpdatePending.set(requestId, { onPhase, resolve, started: false, timer });
      this.send({ type: "update_claude", requestId, required });
    });
  }

  ping(): void {
    this.send({ type: "ping" });
  }
}
