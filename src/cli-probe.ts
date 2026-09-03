import { Platform } from "obsidian";

/**
 * Finding Claude and getting it working, done honestly and invisibly. Two rules
 * shape this file:
 *
 *   1. "Found" means we actually RAN Claude and it answered — never just that a
 *      file exists at a path. A stale or broken install used to show a green
 *      tick and then crash the moment Hyo tried to use it.
 *   2. The person never sees a terminal. Installing and signing in run in the
 *      background; the only thing that surfaces is a browser tab for approving
 *      sign-in, which is expected and fine.
 *
 * Desktop only. A phone has no shell and no child_process, so these modules are
 * left undefined and every function returns a safe empty answer — the phone
 * relies on a connected desktop for all of this.
 */
const cp: typeof import("child_process") | null = Platform.isMobile ? null : require("child_process");
const fs: typeof import("fs") | null = Platform.isMobile ? null : require("fs");
const os: typeof import("os") | null = Platform.isMobile ? null : require("os");

export interface ClaudeCandidate {
  /** Absolute path to a claude binary the machine can see. */
  path: string;
  /** True only if running `path --version` succeeded. */
  works: boolean;
  /** The version string it reported, when it ran. */
  version?: string;
  /** First line of the failure, when it didn't. */
  error?: string;
}

export interface AuthStatus {
  /** true / false when we could read it; undefined when we couldn't tell. */
  loggedIn?: boolean;
  email?: string;
  subscriptionType?: string;
}

/**
 * - ready: a Claude runs and is either signed in, or we couldn't tell (so we
 *   don't nag). Use it.
 * - signed-out: a Claude runs but auth status says not signed in. Sign in.
 * - missing: no Claude runs anywhere. Install it.
 */
export type ClaudeState = "ready" | "signed-out" | "missing";

export interface ClaudeDetection {
  state: ClaudeState;
  path?: string;
  version?: string;
  auth?: AuthStatus;
  candidates: ClaudeCandidate[];
}

const knownPaths = (home: string): string[] => [
  "/usr/local/bin/claude",
  "/opt/homebrew/bin/claude",
  `${home}/.npm-global/bin/claude`,
  `${home}/.local/bin/claude`,
  `${home}/.bun/bin/claude`,
  `${home}/bin/claude`,
  `${home}/.claude/bin/claude`,
];

/**
 * Every claude the machine can see. We ask the person's own shell the same way
 * their terminal does — login + interactive (`-lic`), so PATH set in .zshrc or
 * .bashrc (where nvm, fnm and most manual installs put it) is picked up — and we
 * ask for ALL matches (`which -a`), because people often have more than one.
 * Known install locations are added on top as a safety net.
 */
function gatherCandidatePaths(): string[] {
  if (!cp || !fs || !os) return [];
  const home = os.homedir();
  const isWindows = process.platform === "win32";
  const found = new Set<string>();

  const shellProbes = isWindows
    ? ["where claude"]
    : [
        ...(process.env.SHELL ? [`${process.env.SHELL} -lic 'which -a claude'`] : []),
        "zsh -lic 'which -a claude'",
        "bash -lic 'which -a claude'",
      ];

  for (const cmd of shellProbes) {
    try {
      const out = cp.execSync(cmd, { encoding: "utf8", timeout: 5000 });
      for (const raw of out.split(/\r?\n/)) {
        const line = raw.trim();
        const looksLikePath = line.startsWith("/") || /^[A-Za-z]:\\/.test(line);
        if (looksLikePath) {
          try {
            if (fs.existsSync(line)) found.add(line);
          } catch {}
        }
      }
    } catch {}
  }

  for (const p of knownPaths(home)) {
    try {
      if (fs.existsSync(p)) found.add(p);
    } catch {}
  }

  return [...found];
}

/** Run one Claude and see if it reports a version. A file existing is not this. */
export function probeClaude(path: string): ClaudeCandidate {
  if (!cp) return { path, works: false, error: "not available on mobile" };
  try {
    const out = cp.execSync(`"${path}" --version`, { encoding: "utf8", timeout: 8000 }).trim();
    return { path, works: true, version: out || "unknown version" };
  } catch (e: any) {
    const msg = (e?.stderr || e?.message || "").toString().split(/\r?\n/)[0] || "could not run";
    return { path, works: false, error: msg };
  }
}

/** Ask Claude whether it's signed in. Returns loggedIn: undefined if we can't tell. */
export function checkAuth(cliPath: string): AuthStatus {
  if (!cp || !cliPath) return {};
  try {
    const out = cp.execSync(`"${cliPath}" auth status`, { encoding: "utf8", timeout: 8000 });
    const json = JSON.parse(out);
    return {
      loggedIn: typeof json.loggedIn === "boolean" ? json.loggedIn : undefined,
      email: json.email,
      subscriptionType: json.subscriptionType,
    };
  } catch {
    return {};
  }
}

/** The whole answer: is there a Claude that runs, is it signed in, and which one. */
export function detectClaude(): ClaudeDetection {
  const candidates = gatherCandidatePaths().map(probeClaude);
  const working = candidates.find((c) => c.works);
  if (!working) return { state: "missing", candidates };
  const auth = checkAuth(working.path);
  // Only nag about sign-in when we positively know they're signed out.
  const state: ClaudeState = auth.loggedIn === false ? "signed-out" : "ready";
  return { state, path: working.path, version: working.version, auth, candidates };
}

/** Open a URL in the person's real browser (for sign-in approval). */
function openExternal(url: string): void {
  try {
    require("electron").shell.openExternal(url);
  } catch {
    try {
      window.open(url, "_blank");
    } catch {}
  }
}

type Phase = (message: string) => void;

/**
 * Install Claude Code in the background — no terminal window. Runs the official
 * installer (installs to ~/.local, no sudo, no prompts) and resolves when it
 * finishes. We surface friendly phase text, not raw installer output.
 */
export function installClaude(onPhase: Phase): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    if (!cp) return resolve({ ok: false, error: "This only works on the desktop app." });
    const isWindows = process.platform === "win32";
    onPhase("Installing Claude…");
    let child;
    try {
      child = isWindows
        ? cp.spawn("powershell.exe", ["-NoProfile", "-Command", "irm https://claude.ai/install.ps1 | iex"], {
            windowsHide: true,
          })
        : cp.spawn("/bin/bash", ["-lc", "curl -fsSL https://claude.ai/install.sh | bash"], {});
    } catch (e: any) {
      return resolve({ ok: false, error: (e?.message || "Couldn't start the installer.").toString() });
    }
    child.on("error", (e: any) => resolve({ ok: false, error: (e?.message || "Install failed.").toString() }));
    child.on("close", (code: number) =>
      resolve(code === 0 ? { ok: true } : { ok: false, error: `Installer stopped (code ${code}).` })
    );
  });
}

/**
 * Sign in in the background — no terminal window. Starts the login, opens the
 * browser for approval, then watches auth status (the real signal) until it
 * flips to signed in. The person only ever sees a browser tab.
 */
export async function signIn(cliPath: string, onPhase: Phase): Promise<{ ok: boolean; error?: string }> {
  if (!cp) return { ok: false, error: "This only works on the desktop app." };
  onPhase("Starting sign-in…");
  let child: any;
  try {
    child = cp.spawn(cliPath, ["auth", "login", "--claudeai"], {});
  } catch (e: any) {
    return { ok: false, error: (e?.message || "Couldn't start sign-in.").toString() };
  }

  let opened = false;
  const handle = (buf: Buffer) => {
    const match = buf.toString().match(/https?:\/\/[^\s"']+/);
    if (match && !opened) {
      opened = true;
      openExternal(match[0]);
      onPhase("Approve the sign-in in your browser…");
    }
  };
  child.stdout?.on("data", handle);
  child.stderr?.on("data", handle);
  child.on("error", () => {});

  // auth status is the source of truth — poll it until signed in or we give up.
  const started = Date.now();
  while (Date.now() - started < 120000) {
    await new Promise((r) => setTimeout(r, 2000));
    if (checkAuth(cliPath).loggedIn) {
      try {
        child.kill();
      } catch {}
      onPhase("Signed in.");
      return { ok: true };
    }
  }
  try {
    child.kill();
  } catch {}
  return checkAuth(cliPath).loggedIn
    ? { ok: true }
    : { ok: false, error: "Sign-in didn't finish. Check your browser and try again." };
}
