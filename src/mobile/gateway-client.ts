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

export type ConnectionStatus =
  | "connecting"
  | "connected"
  | "disconnected"
  | "reconnecting";

export type TabMessage =
  | { type: "stream"; event: any }
  | { type: "closed"; code: number | null }
  | { type: "error"; error: string };

export type TabHandler = (msg: TabMessage) => void;

interface PendingRPC<T> {
  resolve: (v: T) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const RPC_TIMEOUT_MS = 35_000;
const MAX_BACKOFF_MS = 30_000;
const MAX_QUEUED_MESSAGES = 200;

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
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;
  private outbox: string[] = [];

  private sessionsQueue: PendingRPC<any[]>[] = [];
  private agentsQueue: PendingRPC<any[]>[] = [];
  private historyPending = new Map<string, PendingRPC<any[]>>();
  private renamePending = new Map<string, PendingRPC<string>>();
  private titlePending = new Map<string, PendingRPC<string | null>>();

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
      const queued = this.outbox;
      this.outbox = [];
      for (const msg of queued) {
        if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(msg);
      }
    };

    ws.onmessage = (ev) => {
      let msg: any;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      this.handleMessage(msg);
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
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  destroy(): void {
    this.destroyed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
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
      clearTimeout(p.timer);
      p.reject(new Error("Gateway connection closed"));
    }
    this.sessionsQueue = [];
    for (const p of this.agentsQueue) {
      clearTimeout(p.timer);
      p.reject(new Error("Gateway connection closed"));
    }
    this.agentsQueue = [];
    for (const map of [this.historyPending, this.renamePending, this.titlePending]) {
      for (const p of map.values()) {
        clearTimeout(p.timer);
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

  private handleMessage(msg: any): void {
    switch (msg.type) {
      case "stream": {
        this.tabHandlers.get(msg.tabId)?.({ type: "stream", event: msg.event });
        return;
      }
      case "sessions": {
        const pending = this.sessionsQueue.shift();
        if (pending) {
          clearTimeout(pending.timer);
          pending.resolve(msg.sessions || []);
        }
        return;
      }
      case "agents": {
        const pending = this.agentsQueue.shift();
        if (pending) {
          clearTimeout(pending.timer);
          pending.resolve(msg.agents || []);
        }
        return;
      }
      case "history": {
        const pending = this.historyPending.get(msg.sessionId);
        if (pending) {
          this.historyPending.delete(msg.sessionId);
          clearTimeout(pending.timer);
          pending.resolve(msg.lines || []);
        }
        return;
      }
      case "task_meta_set":
        // Fire-and-forget ack; the list refresh that follows picks up the state.
        return;
      case "renamed": {
        const pending = this.renamePending.get(msg.sessionId);
        if (pending) {
          this.renamePending.delete(msg.sessionId);
          clearTimeout(pending.timer);
          pending.resolve(msg.title);
        }
        return;
      }
      case "title": {
        const pending = this.titlePending.get(msg.requestId);
        if (pending) {
          this.titlePending.delete(msg.requestId);
          clearTimeout(pending.timer);
          pending.resolve(msg.title || null);
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
          const gone: string[] = Array.isArray(msg.gone) ? msg.gone : [];
          for (const tabId of gone) {
            this.tabHandlers.get(tabId)?.({ type: "closed", code: null });
          }
          return;
        }
        if (msg.subtype === "tab_closed" && msg.tabId) {
          this.tabHandlers.get(msg.tabId)?.({ type: "closed", code: msg.code ?? null });
          return;
        }
        if (msg.subtype === "error") {
          if (msg.tabId) {
            this.tabHandlers.get(msg.tabId)?.({ type: "error", error: msg.error || "Unknown gateway error" });
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

  sendPrompt(tabId: string, text: string, sessionId?: string, resume?: boolean, askFirst?: boolean, appendSystemPrompt?: string, agent?: string, model?: string): void {
    this.send({ type: "prompt", tabId, text, sessionId, resume, askFirst, appendSystemPrompt, agent, model });
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

  stop(tabId: string): void {
    this.send({ type: "stop", tabId });
    this.unregisterTab(tabId);
  }

  // ---- promise-based RPCs ----

  listSessions(): Promise<any[]> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.sessionsQueue.findIndex((p) => p.resolve === resolve);
        if (idx >= 0) this.sessionsQueue.splice(idx, 1);
        reject(new Error("list_sessions timed out"));
      }, RPC_TIMEOUT_MS);
      this.sessionsQueue.push({ resolve, reject, timer });
      this.send({ type: "list_sessions" });
    });
  }

  listAgents(): Promise<any[]> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.agentsQueue.findIndex((p) => p.resolve === resolve);
        if (idx >= 0) this.agentsQueue.splice(idx, 1);
        reject(new Error("list_agents timed out"));
      }, RPC_TIMEOUT_MS);
      this.agentsQueue.push({ resolve, reject, timer });
      this.send({ type: "list_agents" });
    });
  }

  getHistory(sessionId: string): Promise<any[]> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.historyPending.delete(sessionId);
        reject(new Error("get_history timed out"));
      }, RPC_TIMEOUT_MS);
      this.historyPending.set(sessionId, { resolve, reject, timer });
      this.send({ type: "get_history", sessionId });
    });
  }

  rename(sessionId: string, title: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.renamePending.delete(sessionId);
        reject(new Error("rename timed out"));
      }, RPC_TIMEOUT_MS);
      this.renamePending.set(sessionId, { resolve, reject, timer });
      this.send({ type: "rename", sessionId, title });
    });
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
      const timer = setTimeout(() => {
        this.titlePending.delete(requestId);
        resolve(null);
      }, RPC_TIMEOUT_MS);
      this.titlePending.set(requestId, { resolve, reject: () => resolve(null), timer });
      this.send({ type: "generate_title", requestId, userMessage, assistantMessage });
    });
  }

  ping(): void {
    this.send({ type: "ping" });
  }
}
