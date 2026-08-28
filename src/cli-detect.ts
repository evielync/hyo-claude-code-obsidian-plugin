import { Platform } from "obsidian";
import type { EngineId } from "./agent-transport";

// Desktop-only; deferred so this module stays importable on mobile.
const fs: typeof import("fs") = Platform.isMobile ? (undefined as any) : require("fs");
const os: typeof import("os") = Platform.isMobile ? (undefined as any) : require("os");

/**
 * Everything that differs between engines at setup time: what to install, how,
 * and where the binary usually lands. Kept in one place so the settings
 * auto-detect button, the automatic detection on engine switch, and the
 * onboarding screen can never drift from each other.
 */
export interface EngineSetup {
  id: EngineId;
  /** Product name as a person would say it. */
  label: string;
  /** The command the binary is invoked as. */
  binary: string;
  /** Shell one-liner that installs it. */
  installCommand: string;
  windowsInstallCommand: string;
  /** What to run after install to sign in. */
  loginCommand: string;
  /** Which account the sign-in uses. */
  accountName: string;
  accountUrl: string;
  /** Plans that can actually run it. */
  planNote: string;
}

export const ENGINE_SETUP: Record<EngineId, EngineSetup> = {
  claude: {
    id: "claude",
    label: "Claude Code",
    binary: "claude",
    installCommand: "curl -fsSL https://claude.ai/install.sh | bash",
    windowsInstallCommand: "irm https://claude.ai/install.ps1 | iex",
    loginCommand: "claude",
    accountName: "Anthropic",
    accountUrl: "https://claude.ai",
    planNote: "Claude Code requires a Pro, Max, Team, or Enterprise account.",
  },
  codex: {
    id: "codex",
    label: "Codex",
    binary: "codex",
    installCommand: "npm install -g @openai/codex",
    windowsInstallCommand: "npm install -g @openai/codex",
    loginCommand: "codex login",
    accountName: "OpenAI",
    accountUrl: "https://chatgpt.com",
    planNote: "Codex requires a ChatGPT Plus, Pro, Business, or Enterprise plan.",
  },
};

/**
 * Where each engine's binary tends to live. npm's global bin is included
 * because that is how Codex installs, and it is not on the PATH an Obsidian
 * window inherits when the app is launched from the Dock.
 */
function candidatePaths(engine: EngineId): string[] {
  const home = os.homedir();
  const bin = ENGINE_SETUP[engine].binary;
  return [
    `/usr/local/bin/${bin}`,
    `/opt/homebrew/bin/${bin}`,
    `${home}/.npm-global/bin/${bin}`,
    `${home}/.local/bin/${bin}`,
    `${home}/.bun/bin/${bin}`,
    `${home}/bin/${bin}`,
    `${home}/.${bin}/bin/${bin}`,
  ];
}

/** First existing path for this engine's binary, or null. */
export function detectCli(engine: EngineId): string | null {
  try {
    return candidatePaths(engine).find((p) => fs.existsSync(p)) ?? null;
  } catch {
    return null;
  }
}

export function cliExists(cliPath: string): boolean {
  if (!cliPath) return false;
  try {
    return fs.existsSync(cliPath);
  } catch {
    return false;
  }
}
