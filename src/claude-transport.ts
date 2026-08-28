import { debug } from "./debug";
import type { ChildProcess } from "child_process";
import { Platform } from "obsidian";
// Desktop-only transport; Node requires deferred so importing this module is
// mobile-safe (GatewayTransport is used on mobile; this class isn't instantiated there).
const spawn: typeof import("child_process").spawn = Platform.isMobile ? (undefined as any) : require("child_process").spawn;
const randomUUID: typeof import("crypto").randomUUID = Platform.isMobile ? (undefined as any) : require("crypto").randomUUID;
import { isNative1M, baseModelId } from "./models";
import { supportsEffortFlag, probeCliCapabilities } from "./cli-capabilities";
import type { AgentTransport, PermissionBehavior } from "./agent-transport";

// Current models run 1M context natively and don't accept a "[1m]" suffix —
// the API doesn't recognize it as a valid variant and silently falls back to
// 200K context instead of erroring. Any model string carrying that stale
// suffix (e.g. from a tab created before the 0.3.6 ID fix, or typed into the
// custom model field by analogy with Opus/Sonnet 4.6, which DO need it) gets
// normalized here, right at the CLI boundary, so it can never silently
// degrade context again.
//
// Originally special-cased to Sonnet 5; generalised so every natively-1M model
// is covered rather than only the one that happened to get reported.
export function normalizeModelId(id: string): string {
  if (isNative1M(id) && id.includes("[1m]")) {
    return baseModelId(id);
  }
  return id;
}

export interface TransportOptions {
  cliPath: string;
  cwd: string;
  model: string;
  effort?: string;
  permissionMode: string;
  agent?: string;
  sessionId?: string;
  resume?: boolean;
  maxOutputTokens?: number;
  /**
   * Extra text appended to the system prompt for this spawn (via
   * `--append-system-prompt`). Used to switch Chad into the voice persona when
   * conversation mode is on. Undefined in normal text mode so responses stay
   * rich/markdown.
   */
  appendSystemPrompt?: string;
  onMessage: (msg: any) => void;
  onError: (error: string) => void;
  onClose: (code: number | null) => void;
}

export class ClaudeTransport implements AgentTransport {
  private proc: ChildProcess | null = null;
  private buffer = "";
  private stopped = false;
  /**
   * request_id -> the tool input the CLI asked permission for. Entries are
   * consumed when the corresponding permission response is sent; the whole map
   * dies with the transport, so it can't grow unbounded across sessions.
   */
  private pendingToolInput = new Map<string, Record<string, unknown>>();
  private options: TransportOptions;

  constructor(options: TransportOptions) {
    this.options = options;
  }

  spawn(): void {
    const { cliPath, cwd, model, permissionMode, agent, sessionId, resume } =
      this.options;

    const args = [
      "--output-format",
      "stream-json",
      "--input-format",
      "stream-json",
      "--verbose",
      "--model",
      normalizeModelId(model),
      "--permission-mode",
      permissionMode,
      "--permission-prompt-tool",
      "stdio",
      "--no-chrome",
    ];

    if (resume && sessionId) {
      args.push("--resume", sessionId);
    } else if (sessionId) {
      args.push("--session-id", sessionId);
    }

    // All agents are loaded via --agent <name> from ~/.claude/agents/.
    if (agent) {
      args.push("--agent", agent);
    }

    // Voice conversation mode appends the voice persona to the system prompt so
    // Chad speaks for listening, not reading. Only present when conversation
    // mode is on — text mode keeps the default (rich markdown) behaviour.
    if (this.options.appendSystemPrompt) {
      args.push("--append-system-prompt", this.options.appendSystemPrompt);
    }

    // Reasoning effort, via the flag where the CLI supports it. Older builds
    // have no such flag and would refuse to start, so those fall back to the
    // environment variable below. See cli-capabilities.ts for why detection
    // runs off `--help` rather than a version comparison.
    const effort = this.options.effort;
    const useEffortFlag = !!effort && supportsEffortFlag(cliPath);
    if (useEffortFlag) {
      args.push("--effort", effort!);
    }
    // Kick off a probe if this CLI hasn't been checked yet, so later spawns in
    // this session can use the flag. Fire-and-forget: the fallback below keeps
    // effort working in the meantime.
    void probeCliCapabilities(cliPath);

    // Build PATH — Electron apps launched from Dock have minimal PATH
    const env = { ...process.env };
    if (this.options.maxOutputTokens && this.options.maxOutputTokens > 0) {
      env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(this.options.maxOutputTokens);
    }
    // Effort fallback for CLIs without the flag — an unrecognised env var is
    // ignored, so this is safe on every version. Skipped when the flag was
    // already passed, to avoid setting the same thing two ways.
    //
    // Effort replaced the "--max-thinking-tokens 31999" that used to be pinned
    // onto every spawn. Both control the same thing (how much the model thinks
    // before answering), and a hardcoded thinking budget would have overridden
    // whatever the user picked, leaving the selector doing nothing. Effort owns
    // reasoning depth now; there is deliberately no second dial.
    if (effort && !useEffortFlag) {
      env.CLAUDE_CODE_EFFORT_LEVEL = effort;
    }
    env.PATH = [
      "/usr/local/bin",
      "/opt/homebrew/bin",
      "/opt/homebrew/sbin",
      process.env.HOME + "/.npm-global/bin",
      process.env.HOME + "/.nvm/versions/node/v22.15.0/bin",
      "/usr/bin",
      "/bin",
      "/usr/sbin",
      "/sbin",
      process.env.HOME + "/.bun/bin",
      process.env.PATH || "",
    ].join(":");

    debug("[hyo] Spawning CLI:", cliPath, args.join(" "));
    debug("[hyo] CWD:", cwd);
    // Effort is passed via the environment, not argv, so it wouldn't show up
    // in the spawn line above — log it explicitly or it's unverifiable.
    debug(
      "[hyo] Effort:",
      effort ?? "(unset — CLI default)",
      useEffortFlag ? "via --effort flag" : "via CLAUDE_CODE_EFFORT_LEVEL"
    );

    this.proc = spawn(cliPath, args, {
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
          const parsed = JSON.parse(line);

          if (parsed.type === "system" && parsed.subtype === "init") {
            debug("[hyo] CLI ready, session:", parsed.session_id);
          }

          // Remember the input the CLI asked permission for, keyed by
          // request_id so concurrent tool calls can't clobber each other.
          // sendPermissionResponse must echo this back — see the note there.
          if (
            parsed.type === "control_request" &&
            parsed.request?.subtype === "can_use_tool"
          ) {
            this.pendingToolInput.set(
              parsed.request_id,
              parsed.request.input ?? {},
            );
          }

          this.options.onMessage(parsed);
        } catch {
          debug("[hyo] Non-JSON line:", line.slice(0, 200));
        }
      }
    });

    this.proc.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      debug("[hyo] stderr:", text.slice(0, 500));
      if (!text.includes("[debug]")) {
        this.options.onError(text);
      }
    });

    this.proc.on("error", (err) => {
      console.error("[hyo] Spawn error:", err.message);
      this.options.onError(`Failed to start Claude: ${err.message}`);
      this.options.onClose(1);
    });

    this.proc.on("close", (code) => {
      debug("[hyo] CLI closed with code:", code);
      // Flush remaining buffer
      if (this.buffer.trim()) {
        try {
          const parsed = JSON.parse(this.buffer);
          this.options.onMessage(parsed);
        } catch {
          // Ignore
        }
      }
      this.options.onClose(code);
    });
  }

  sendUserMessage(content: string | any[]): void {
    if (!this.proc?.stdin?.writable) return;

    const messageContent =
      typeof content === "string" ? [{ type: "text", text: content }] : content;

    const msg =
      JSON.stringify({
        type: "user",
        message: { role: "user", content: messageContent },
      }) + "\n";

    this.proc.stdin.write(msg);
  }

  sendPermissionResponse(
    requestId: string,
    behavior: "allow" | "allow_always" | "deny",
    toolName?: string,
    updatedInput?: Record<string, unknown>,
  ): void {
    if (!this.proc?.stdin?.writable) return;

    // `updatedInput` is authoritative in the CLI's permission protocol: on an
    // allow it REPLACES the tool's original input rather than merging with it,
    // and it is required (omitting it fails schema validation). Defaulting it
    // to `{}` therefore ran every approved tool call with its arguments
    // stripped — "path must be of type string, received undefined" and friends.
    // Callers only pass an explicit input when the user genuinely edited it
    // (e.g. AskUserQuestion answers); otherwise echo back what the CLI sent us.
    const originalInput = this.pendingToolInput.get(requestId) ?? {};
    this.pendingToolInput.delete(requestId);
    const resolvedInput = updatedInput ?? originalInput;

    let response: Record<string, unknown>;

    if (behavior === "deny") {
      response = {
        behavior: "deny",
        message: "Denied by user",
        decisionClassification: "user_reject",
      };
    } else if (behavior === "allow_always" && toolName) {
      // Claude Code's schema only accepts "allow" or "deny" as the behavior.
      // "Always allow" is expressed by adding a session-level permission rule
      // via the updatedPermissions array on an "allow" response.
      response = {
        behavior: "allow",
        updatedInput: resolvedInput,
        decisionClassification: "user_permanent",
        updatedPermissions: [
          {
            type: "addRules",
            rules: [{ toolName }],
            behavior: "allow",
            destination: "localSettings",
          },
        ],
      };
    } else {
      response = {
        behavior: "allow",
        updatedInput: resolvedInput,
        decisionClassification: "user_temporary",
      };
    }

    const msg =
      JSON.stringify({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: requestId,
          response,
        },
      }) + "\n";

    this.proc.stdin.write(msg);
  }

  sendInterrupt(): void {
    if (!this.proc?.stdin?.writable) return;

    const msg =
      JSON.stringify({
        type: "control_request",
        request_id: randomUUID(),
        request: { subtype: "interrupt" },
      }) + "\n";

    this.proc.stdin.write(msg);
  }

  stop(): void {
    this.stopped = true;
    if (this.proc) {
      try {
        this.proc.kill("SIGTERM");
      } catch {
        // Process already dead
      }
      setTimeout(() => {
        try {
          if (this.proc && !this.proc.killed) {
            this.proc.kill("SIGKILL");
          }
        } catch {
          // Already dead
        }
      }, 2000);
    }
  }

  isRunning(): boolean {
    return this.proc !== null && !this.stopped && !this.proc.killed;
  }

  // ---------------------------------------------------------- AgentTransport
  // Engine-neutral names, so the chat engine drives Claude and Codex through
  // the same calls. The original names stay as the implementation because the
  // session manager, voice mode and mobile gateway all call them directly.

  start(): void {
    this.spawn();
  }

  respondToPermission(
    requestId: string,
    behavior: PermissionBehavior,
    toolName?: string,
    updatedInput?: Record<string, unknown>,
  ): void {
    this.sendPermissionResponse(requestId, behavior, toolName, updatedInput);
  }

  interrupt(): void {
    this.sendInterrupt();
  }
}

export function checkCliExists(cliPath: string): boolean {
  try {
    const fs = require("fs");
    return fs.existsSync(cliPath);
  } catch {
    return false;
  }
}
