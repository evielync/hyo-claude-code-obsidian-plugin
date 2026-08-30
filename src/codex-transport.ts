import { debug } from "./debug";
import { resolveModelForEngine, resolveEffortForEngine } from "./models";
import type { ChildProcess } from "child_process";
import { Platform } from "obsidian";
import type {
  AgentEvent,
  AgentTransport,
  AgentTransportOptions,
  AgentUsage,
  PermissionBehavior,
} from "./agent-transport";

// Desktop-only transport; Node requires are deferred so this module stays
// importable on mobile, where the gateway client is used instead.
const spawn: typeof import("child_process").spawn = Platform.isMobile
  ? (undefined as any)
  : require("child_process").spawn;

/**
 * Drives OpenAI's Codex App Server (`codex app-server`) for Hyo.
 *
 * The App Server is a long-lived process speaking bidirectional JSON-RPC 2.0
 * over stdio — the same surface OpenAI's own VS Code extension and web app run
 * on. It is chosen over `codex exec --json` because `exec` auto-approves or
 * fails on tool approvals, whereas the App Server sends the client an approval
 * *request* and holds the turn open until it is answered. That is the primitive
 * Hyo's inline permission prompts are built on.
 *
 * Signs in with a ChatGPT subscription rather than a metered API key, which is
 * what keeps Hyo's "runs on the plan you already pay for" promise true on this
 * engine as well as on Claude.
 */
export class CodexTransport implements AgentTransport {
  private proc: ChildProcess | null = null;
  private buffer = "";
  private stopped = false;
  private nextRequestId = 1;
  private pending = new Map<
    number,
    { resolve: (v: any) => void; reject: (e: Error) => void }
  >();
  private threadId: string | null = null;
  private currentTurnId: string | null = null;

  /**
   * Approval requests arrive carrying only an `itemId`, not a description of
   * what is being approved — the details live on the `item/started` event that
   * preceded it. Items are kept here so a prompt can say "write to config.ts"
   * rather than "approve call_abc123".
   */
  private items = new Map<string, any>();

  /**
   * Messages sent before the thread finished starting. Flushed once it has.
   */
  private queuedMessages: string[] = [];

  /** Latest token usage the thread reported, attached to the next turn-complete. */
  private lastUsage: AgentUsage | undefined = undefined;

  /**
   * JSON-RPC id of each open approval request, keyed by the itemId Hyo's UI
   * uses as its request id. Consumed when the user answers.
   */
  private pendingApprovals = new Map<
    string,
    { rpcId: number; kind: "command" | "fileChange" | "generic" }
  >();

  /** JSON-RPC id of each open question, keyed by the item id the UI uses. */
  private pendingQuestions = new Map<string, number>();

  private options: AgentTransportOptions;

  constructor(options: AgentTransportOptions) {
    this.options = options;
  }

  private emit(event: AgentEvent): void {
    this.options.onEvent(event);
  }

  // ---------------------------------------------------------------- transport

  start(): void {
    const { cliPath, cwd } = this.options;

    // Electron apps launched from the Dock inherit a minimal PATH, so the
    // engine can't find node/git/etc. unless we rebuild it here.
    const env = { ...process.env };
    env.PATH = [
      "/usr/local/bin",
      "/opt/homebrew/bin",
      "/opt/homebrew/sbin",
      process.env.HOME + "/.npm-global/bin",
      "/usr/bin",
      "/bin",
      "/usr/sbin",
      "/sbin",
      process.env.HOME + "/.bun/bin",
      process.env.PATH || "",
    ].join(":");

    debug("[hyo] Spawning Codex app-server:", cliPath, "cwd:", cwd);

    this.proc = spawn(cliPath, ["app-server"], {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.proc.stdout?.on("data", (chunk: Buffer) => {
      if (this.stopped) return;
      this.buffer += chunk.toString();
      const lines = this.buffer.split("\n");
      this.buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          this.handleMessage(JSON.parse(line));
        } catch {
          debug("[hyo] Codex non-JSON line:", line.slice(0, 200));
        }
      }
    });

    this.proc.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      debug("[hyo] Codex stderr:", text.slice(0, 500));
      // The app server logs its whole model catalogue and assorted tracing to
      // stderr on startup. Only genuine ERROR lines are worth surfacing;
      // forwarding all of it would bury the chat in noise.
      if (/\bERROR\b/.test(text) && !text.includes("failed to refresh available models")) {
        this.options.onError(text.slice(0, 500));
      }
    });

    this.proc.on("error", (err) => {
      console.error("[hyo] Codex spawn error:", err.message);
      this.options.onError(`Failed to start Codex: ${err.message}`);
      this.options.onClose(1);
    });

    this.proc.on("close", (code) => {
      debug("[hyo] Codex app-server closed with code:", code);
      this.options.onClose(code);
    });

    void this.handshake();
  }

  private async handshake(): Promise<void> {
    try {
      await this.request("initialize", {
        clientInfo: { name: "hyo", title: "Hyo", version: "1" },
        capabilities: null,
      });
      this.notify("initialized", {});

      const { sessionId, resume, model } = this.options;

      let started: any;
      if (resume && sessionId) {
        started = await this.request("thread/resume", { threadId: sessionId });
      } else {
        started = await this.request("thread/start", {
          cwd: this.options.cwd,
          // The model is always sent explicitly. Left to its own devices the
          // app server falls back to `model` in ~/.codex/config.toml, which can
          // name a model the installed CLI is too old to run — the turn then
          // fails with "requires a newer version of Codex" rather than anything
          // that points at the config.
          model: this.resolveModel(model),
          approvalPolicy: this.mapPermissionMode(this.options.permissionMode),
          sandbox: "workspace-write",
          ...(this.options.appendSystemPrompt
            ? { developerInstructions: this.options.appendSystemPrompt }
            : {}),
        });
      }

      this.threadId = started?.thread?.id ?? started?.threadId ?? null;
      if (!this.threadId) {
        this.failPendingTurn("Codex did not return a conversation id.");
        return;
      }
      this.emit({
        type: "session-ready",
        sessionId: this.threadId,
        model: started?.model,
      });
      debug("[hyo] Codex thread ready:", this.threadId);
      this.flushQueue();
    } catch (e: any) {
      this.failPendingTurn(`Codex could not start: ${e?.message ?? e}`);
    }
  }

  /**
   * Something went wrong before any turn could run. Anything queued is dropped
   * and the turn is closed out with a visible error — otherwise the chat shows
   * "Thinking…" indefinitely for a conversation that will never produce one.
   */
  private failPendingTurn(message: string): void {
    this.queuedMessages = [];
    this.emit({ type: "error", message });
    this.emit({ type: "turn-complete", error: message });
    this.options.onError(message);
  }

  sendUserMessage(content: string | unknown[]): void {
    const text =
      typeof content === "string" ? content : this.flattenContent(content);

    // The caller sends the first message on the line after start(), but the
    // handshake (initialize → thread/start) is a few async round trips and the
    // app server takes a while to come up when MCP servers are configured. So
    // the thread usually isn't ready yet. Hold the message and send it when it
    // is — dropping it here is invisible to the user and leaves the chat
    // sitting on "Thinking…" with no turn ever running.
    if (!this.threadId) {
      this.queuedMessages.push(text);
      return;
    }

    this.startTurn(text);
  }

  private flushQueue(): void {
    const queued = this.queuedMessages.splice(0);
    for (const text of queued) this.startTurn(text);
  }

  private startTurn(text: string): void {
    if (!this.threadId) return;
    void this.request("turn/start", {
      threadId: this.threadId,
      input: [{ type: "text", text, text_elements: [] }],
      ...(this.resolveEffort(this.options.effort)
        ? { effort: this.resolveEffort(this.options.effort) }
        : {}),
    }).catch((e) => {
      this.options.onError(`Codex turn failed: ${e?.message ?? e}`);
    });
  }

  respondToPermission(
    requestId: string,
    behavior: PermissionBehavior,
    _toolName?: string,
    _updatedInput?: Record<string, unknown>,
  ): void {
    const entry = this.pendingApprovals.get(requestId);
    if (!entry) {
      debug("[hyo] Codex: no pending approval for", requestId);
      return;
    }
    this.pendingApprovals.delete(requestId);

    // Codex names its decisions differently to Claude Code, and they are not
    // interchangeable: sending Claude's "approved" here is accepted as valid
    // JSON, silently treated as a refusal, and the tool call is dropped with
    // the model reporting that the write was rejected.
    const decision =
      behavior === "deny"
        ? "decline"
        : behavior === "allow_always"
          ? "acceptForSession"
          : "accept";

    this.respond(entry.rpcId, { decision });
  }

  respondToQuestion(requestId: string, answers: Record<string, string>): void {
    const rpcId = this.pendingQuestions.get(requestId);
    if (rpcId === undefined) {
      debug("[hyo] Codex: no pending question for", requestId);
      return;
    }
    this.pendingQuestions.delete(requestId);
    // Codex takes a list per question, so a single choice is a list of one.
    const payload: Record<string, { answers: string[] }> = {};
    for (const [questionId, answer] of Object.entries(answers)) {
      payload[questionId] = { answers: [answer] };
    }
    this.respond(rpcId, { answers: payload });
  }

  interrupt(): void {
    if (!this.threadId) return;
    void this.request("turn/interrupt", {
      threadId: this.threadId,
      ...(this.currentTurnId ? { turnId: this.currentTurnId } : {}),
    }).catch(() => {
      /* interrupting a finished turn is not an error worth surfacing */
    });
  }

  stop(): void {
    this.stopped = true;
    if (this.proc) {
      try {
        this.proc.kill("SIGTERM");
      } catch {
        // already gone
      }
      setTimeout(() => {
        try {
          if (this.proc && !this.proc.killed) this.proc.kill("SIGKILL");
        } catch {
          // already gone
        }
      }, 2000);
    }
  }

  isRunning(): boolean {
    return this.proc !== null && !this.stopped && !this.proc.killed;
  }

  // ------------------------------------------------------------------- rpc

  private request(method: string, params: unknown): Promise<any> {
    const id = this.nextRequestId++;
    this.write({ jsonrpc: "2.0", id, method, params });
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
  }

  private notify(method: string, params: unknown): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  private respond(id: number, result: unknown): void {
    this.write({ jsonrpc: "2.0", id, result });
  }

  private write(msg: unknown): void {
    if (!this.proc?.stdin?.writable) return;
    this.proc.stdin.write(JSON.stringify(msg) + "\n");
  }

  private handleMessage(msg: any): void {
    // Response to something we sent.
    if (msg.id !== undefined && msg.method === undefined) {
      const p = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (!p) return;
      if (msg.error) p.reject(new Error(msg.error?.message ?? JSON.stringify(msg.error)));
      else p.resolve(msg.result);
      return;
    }

    // Server-initiated request — must be answered or the turn hangs.
    if (msg.id !== undefined && msg.method) {
      this.handleServerRequest(msg);
      return;
    }

    this.handleNotification(msg.method, msg.params ?? {});
  }

  private handleServerRequest(msg: any): void {
    const { method, id, params } = msg;

    if (
      method === "item/commandExecution/requestApproval" ||
      method === "item/fileChange/requestApproval"
    ) {
      const isCommand = method === "item/commandExecution/requestApproval";
      const itemId: string = params.itemId;
      const item = this.items.get(itemId) ?? {};

      this.pendingApprovals.set(itemId, {
        rpcId: id,
        kind: isCommand ? "command" : "fileChange",
      });
      this.currentTurnId = params.turnId ?? this.currentTurnId;

      this.emit({
        type: "permission-request",
        requestId: itemId,
        toolName: isCommand ? "Bash" : "Edit",
        input: isCommand
          ? { command: params.command ?? item.command ?? "", cwd: params.cwd ?? item.cwd }
          : { path: item.path ?? item.changes?.[0]?.path, changes: item.changes },
        reason: params.reason ?? undefined,
      });
      return;
    }

    if (method === "item/tool/requestUserInput") {
      // Codex is asking the user something. Answering `{}` here — which the
      // catch-all below would do — reads to Codex as the user having answered
      // nothing, so the question never reaches the screen and the turn carries
      // on regardless.
      this.pendingQuestions.set(params.itemId, id);
      this.emit({
        type: "question-request",
        requestId: params.itemId,
        questions: (params.questions ?? []).map((q: any) => ({
          id: q.id,
          header: q.header || undefined,
          question: q.question,
          options: (q.options ?? []).map((o: any) => ({
            label: o.label,
            description: o.description || undefined,
          })),
          allowOther: !!q.isOther,
          isSecret: !!q.isSecret,
        })),
      });
      return;
    }

    // Anything else the server asks for gets an empty ack. Leaving a server
    // request unanswered stalls the turn indefinitely, so silence is never the
    // safe default here.
    this.respond(id, {});
  }

  private handleNotification(method: string, params: any): void {
    switch (method) {
      case "turn/started":
        this.currentTurnId = params?.turn?.id ?? params?.turnId ?? null;
        return;

      case "item/agentMessage/delta":
        this.emit({ type: "text-delta", text: params.delta ?? "", turnId: params.turnId });
        return;

      case "item/reasoning/textDelta":
      case "item/reasoning/summaryTextDelta":
        this.emit({
          type: "thinking-delta",
          text: params.delta ?? params.text ?? "",
          turnId: params.turnId,
        });
        return;

      case "item/started": {
        const item = params.item;
        if (!item) return;
        this.items.set(item.id, item);
        if (item.type === "commandExecution") {
          this.emit({
            type: "tool-start",
            id: item.id,
            name: "Bash",
            input: { command: item.command, cwd: item.cwd },
          });
        } else if (item.type === "fileChange") {
          this.emit({
            type: "tool-start",
            id: item.id,
            name: "Edit",
            input: { path: item.path, changes: item.changes },
          });
        } else if (item.type === "mcpToolCall") {
          this.emit({
            type: "tool-start",
            id: item.id,
            name: item.tool ?? "MCP",
            input: item.arguments ?? {},
          });
        }
        return;
      }

      case "item/completed": {
        const item = params.item;
        if (!item) return;
        this.items.set(item.id, item);
        if (
          item.type === "commandExecution" ||
          item.type === "fileChange" ||
          item.type === "mcpToolCall"
        ) {
          this.emit({ type: "tool-end", id: item.id });
          this.emit({
            type: "tool-result",
            id: item.id,
            content: item.output ?? item.result ?? item.aggregatedOutput ?? "",
            isError: item.status === "failed",
          });
        }
        return;
      }

      case "thread/tokenUsage/updated": {
        // Held and attached to turn-complete so the UI has one place that
        // updates usage. `total` is the whole conversation, which is what the
        // context meter needs; `last` is only the most recent turn.
        const u = params?.tokenUsage;
        if (!u) return;
        this.lastUsage = {
          inputTokens: u.total?.inputTokens,
          outputTokens: u.total?.outputTokens,
          cachedInputTokens: u.total?.cachedInputTokens,
          totalTokens: u.total?.totalTokens,
          contextWindow: u.modelContextWindow ?? undefined,
        };
        return;
      }

      case "account/rateLimits/updated": {
        const r = params?.rateLimits;
        if (!r) return;
        this.emit({
          type: "rate-limits",
          primaryUsedPercent: r.primary?.usedPercent,
          primaryWindowMins: r.primary?.windowDurationMins ?? undefined,
          // Plans without a second window send null here. Passing that through
          // as undefined keeps the row out of the meter rather than showing a
          // permanently empty bar.
          secondaryUsedPercent: r.secondary?.usedPercent ?? undefined,
          secondaryWindowMins: r.secondary?.windowDurationMins ?? undefined,
          resetsAt: r.primary?.resetsAt ?? undefined,
          planType: r.planType ?? undefined,
        });
        return;
      }

      case "turn/completed": {
        const status = params?.turn?.status;
        this.emit({
          type: "turn-complete",
          usage: this.lastUsage,
          error: status === "failed" ? this.describeTurnError(params?.turn?.error) : undefined,
        });
        this.currentTurnId = null;
        return;
      }

      case "error":
        this.emit({
          type: "error",
          message: params?.error?.message ?? "Codex reported an error",
        });
        return;

      case "thread/status/changed":
        if (params?.status) this.emit({ type: "status", text: String(params.status) });
        return;

      default:
        debug("[hyo] Codex notification ignored:", method);
    }
  }

  // -------------------------------------------------------------- helpers

  private describeTurnError(error: any): string {
    if (!error) return "Turn failed";
    if (typeof error === "string") return error;
    // The app server nests the upstream API error as a JSON string.
    const raw = error.message ?? JSON.stringify(error);
    try {
      const inner = JSON.parse(raw);
      return inner?.error?.message ?? raw;
    } catch {
      return raw;
    }
  }

  /**
   * A tab created under Claude carries an Anthropic model id and possibly the
   * "max" effort, neither of which Codex accepts. Both are resolved to this
   * engine's own values rather than passed through to fail the turn.
   */
  private resolveModel(model: string): string {
    return resolveModelForEngine("codex", model);
  }

  private resolveEffort(effort?: string): string | undefined {
    return effort ? resolveEffortForEngine("codex", effort) : undefined;
  }

  /** Codex's approval policies, from Hyo's permission-mode vocabulary. */
  private mapPermissionMode(mode: string): string {
    switch (mode) {
      case "bypassPermissions":
      case "acceptEdits":
        return "never";
      case "plan":
        return "untrusted";
      default:
        return "on-request";
    }
  }

  private flattenContent(content: unknown[]): string {
    return content
      .map((b: any) => (typeof b === "string" ? b : b?.text ?? ""))
      .join("")
      .trim();
  }
}

export function checkCodexExists(cliPath: string): boolean {
  try {
    const fs = require("fs");
    return fs.existsSync(cliPath);
  } catch {
    return false;
  }
}
