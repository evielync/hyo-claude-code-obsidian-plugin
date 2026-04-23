import { spawn, ChildProcess } from "child_process";
import { randomUUID } from "crypto";

export interface TransportOptions {
  cliPath: string;
  cwd: string;
  model: string;
  permissionMode: string;
  agent?: string;
  sessionId?: string;
  resume?: boolean;
  onMessage: (msg: any) => void;
  onError: (error: string) => void;
  onClose: (code: number | null) => void;
}

export class ClaudeTransport {
  private proc: ChildProcess | null = null;
  private buffer = "";
  private stopped = false;
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
      model,
      "--max-thinking-tokens",
      "31999",
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

    // Build PATH — Electron apps launched from Dock have minimal PATH
    const env = { ...process.env };
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

    console.log("[hyo] Spawning CLI:", cliPath, args.join(" "));
    console.log("[hyo] CWD:", cwd);

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
            console.log("[hyo] CLI ready, session:", parsed.session_id);
          }

          this.options.onMessage(parsed);
        } catch {
          console.log("[hyo] Non-JSON line:", line.slice(0, 200));
        }
      }
    });

    this.proc.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      console.log("[hyo] stderr:", text.slice(0, 500));
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
      console.log("[hyo] CLI closed with code:", code);
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

  sendPermissionResponse(requestId: string, behavior: "allow" | "allow_always" | "deny"): void {
    if (!this.proc?.stdin?.writable) return;

    const response =
      behavior === "deny"
        ? { behavior: "deny", message: "Denied by user" }
        : { behavior, updatedInput: {} };

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
}

export function checkCliExists(cliPath: string): boolean {
  try {
    const fs = require("fs");
    return fs.existsSync(cliPath);
  } catch {
    return false;
  }
}
