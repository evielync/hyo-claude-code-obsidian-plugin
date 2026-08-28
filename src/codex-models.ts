import { debug } from "./debug";
import { Platform } from "obsidian";
import type { ModelOption } from "./models";
import { CODEX_MODEL_OPTIONS } from "./models";

const spawn: typeof import("child_process").spawn = Platform.isMobile
  ? (undefined as any)
  : require("child_process").spawn;

/**
 * Asks the Codex app server which models the signed-in account can actually
 * use, instead of shipping a list Hyo has to keep up to date.
 *
 * Worth knowing when this looks wrong: the CLI serves this list itself, and an
 * out-of-date CLI quietly falls back to an older built-in set when it can't
 * decode the live response from OpenAI. The models are on the account either
 * way — they just don't appear here until the CLI is updated. So a missing
 * model is a CLI version problem, not an account problem.
 */
export async function fetchCodexModels(cliPath: string): Promise<ModelOption[]> {
  if (!cliPath) return CODEX_MODEL_OPTIONS;

  return new Promise((resolve) => {
    let settled = false;
    const done = (models: ModelOption[]) => {
      if (settled) return;
      settled = true;
      try {
        proc.kill("SIGTERM");
      } catch {
        // already gone
      }
      resolve(models);
    };

    const env = { ...process.env };
    env.PATH = [
      "/usr/local/bin",
      "/opt/homebrew/bin",
      process.env.HOME + "/.npm-global/bin",
      "/usr/bin",
      "/bin",
      process.env.PATH || "",
    ].join(":");

    let proc: import("child_process").ChildProcess;
    try {
      proc = spawn(cliPath, ["app-server"], { env, stdio: ["pipe", "pipe", "pipe"] });
    } catch {
      resolve(CODEX_MODEL_OPTIONS);
      return;
    }

    let buffer = "";
    let initId = 1;
    let listId = 0;
    let nextId = 1;

    const send = (method: string, params: unknown): number => {
      const id = nextId++;
      proc.stdin?.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      return id;
    };

    proc.stdout?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let msg: any;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id === initId && msg.result) {
          proc.stdin?.write(
            JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} }) + "\n",
          );
          listId = send("model/list", {});
        } else if (msg.id === listId) {
          const data: any[] = msg.result?.data ?? msg.result?.models ?? [];
          const models = data
            .filter((m) => !m.hidden)
            .map((m) => ({
              id: m.id ?? m.model,
              name: m.displayName || m.id || m.model,
              // No context figure: the app server reports the real window per
              // conversation, and the gauge uses that.
              context: "",
            }))
            .filter((m) => !!m.id);
          debug("[hyo] Codex models:", models.map((m) => m.id).join(", "));
          done(models.length ? models : CODEX_MODEL_OPTIONS);
        }
      }
    });

    proc.on("error", () => done(CODEX_MODEL_OPTIONS));
    proc.on("close", () => done(CODEX_MODEL_OPTIONS));

    initId = send("initialize", {
      clientInfo: { name: "hyo", title: "Hyo", version: "1" },
      capabilities: null,
    });

    // The app server does a fair amount of startup work (MCP servers, hooks)
    // before it answers, so this is generous. The bundled list covers the gap.
    setTimeout(() => done(CODEX_MODEL_OPTIONS), 15000);
  });
}
