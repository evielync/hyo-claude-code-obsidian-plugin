import { Platform } from "obsidian";
import { compareVersions } from "./models";

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
 * Bring Claude up to at least `required`, in the background — no terminal.
 * First asks the installed Claude to update itself (`claude update`), which is
 * quick and keeps it where it already lives. The version it reports afterwards
 * is the only proof that worked; if it's still too old (an install the updater
 * can't touch, like an old npm or Homebrew copy), we fall back to the official
 * installer, which puts a fresh one in ~/.local.
 *
 * Resolves ok only once a Claude is confirmed at or above `required`. The
 * caller re-runs detection afterwards, since the installer path can leave the
 * working Claude somewhere new.
 */
export async function updateClaude(
  cliPath: string,
  required: string,
  onPhase: Phase
): Promise<{ ok: boolean; error?: string }> {
  if (!cp) return { ok: false, error: "This only works on the desktop app." };
  const newEnough = (v?: string) => !!v && compareVersions(v, required) >= 0;

  if (cliPath) {
    onPhase("Updating Claude…");
    await new Promise<void>((resolve) => {
      let child: any;
      try {
        child = cp!.spawn(cliPath, ["update"], { windowsHide: true });
      } catch {
        return resolve();
      }
      // The updater can hang on a prompt it expects a person to answer. Give
      // it a fair run, then move on to the installer rather than wait forever.
      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {}
        resolve();
      }, 180000);
      child.on("error", () => {
        clearTimeout(timer);
        resolve();
      });
      child.on("close", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    onPhase("Checking the new version…");
    if (newEnough(probeClaude(cliPath).version)) return { ok: true };
  }

  const installed = await installClaude(onPhase);
  if (!installed.ok) return installed;
  onPhase("Checking the new version…");
  // The installer may have put Claude somewhere other than cliPath, so look
  // everywhere and accept any copy that's new enough.
  const fresh = detectClaude();
  if (fresh.candidates.some((c) => c.works && newEnough(c.version))) return { ok: true };
  return { ok: false, error: `Claude still reports an older version than ${required}.` };
}

/**
 * Called once the login is waiting. `submit` sends a pasted code to the login.
 * `pageUrl` is the sign-in page that ends on a code to paste back, passed when
 * Claude opened its own browser tab, so the card can offer it if that tab
 * never appeared.
 */
export type CodeNeeded = (submit: (code: string) => void, pageUrl?: string) => void;

/**
 * Sign in in the background — no terminal window. Starts the login, opens the
 * browser for approval, and waits for the login itself to report that it
 * finished.
 *
 * `claude auth status` can't be the signal on its own: when a login has expired
 * the old credentials are still on disk, so status reads "signed in" before the
 * person has approved anything. It only counts here when status was signed out
 * at the start and has since flipped.
 *
 * Sometimes Claude finishes the browser step on a page that shows a code to
 * paste back instead of handing straight back to the app. `onCodeNeeded` lets
 * the caller offer a box for it; whatever is submitted goes to the login's
 * input, which is where Claude reads it.
 */
export async function signIn(
  cliPath: string,
  onPhase: Phase,
  onCodeNeeded?: CodeNeeded
): Promise<{ ok: boolean; error?: string }> {
  if (!cp) return { ok: false, error: "This only works on the desktop app." };
  onPhase("Starting sign-in…");
  const wasSignedOut = checkAuth(cliPath).loggedIn === false;
  let child: any;
  try {
    child = cp.spawn(cliPath, ["auth", "login", "--claudeai"], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch (e: any) {
    return { ok: false, error: (e?.message || "Couldn't start sign-in.").toString() };
  }

  return new Promise((resolve) => {
    let settled = false;
    let opened = false;
    let codeOffered = false;
    let output = "";
    const finish = (r: { ok: boolean; error?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(poll);
      try {
        child.kill();
      } catch {}
      if (r.ok) onPhase("Signed in.");
      resolve(r);
    };
    const submit = (code: string) => {
      const clean = code.trim();
      if (!clean || settled) return;
      onPhase("Checking the code…");
      try {
        child.stdin?.write(clean + "\n");
      } catch (e: any) {
        console.error("[hyo] couldn't pass the sign-in code to Claude:", e);
        finish({ ok: false, error: "Couldn't pass the code to Claude. Click Sign in to try again." });
      }
    };
    const offerCode = (pageUrl?: string) => {
      if (codeOffered || !onCodeNeeded) return;
      codeOffered = true;
      onCodeNeeded(submit, pageUrl);
    };
    const handle = (buf: Buffer) => {
      const text = buf.toString();
      output += text;
      const match = text.match(/https?:\/\/[^\s"']+/);
      if (match && !opened) {
        opened = true;
        onPhase("Approve the sign-in in your browser…");
        if (/opening browser/i.test(output)) {
          // Claude opens its own tab, which hands straight back to Hyo once
          // approved. The link it prints is the other route, a page that ends
          // on a code to paste. Opening that too gives two tabs, and approving
          // in the wrong one leaves the person copying a code. Keep it on the
          // card for when Claude's tab never shows up.
          offerCode(match[0]);
        } else {
          // Older Claude: it only prints the link, so Hyo opens it.
          openExternal(match[0]);
          offerCode();
        }
      }
      if (/paste|authori[sz]ation code|enter (the )?code/i.test(text)) offerCode();
      if (/login successful|logged in as|successfully (logged|signed) in/i.test(text)) finish({ ok: true });
    };
    child.stdout?.on("data", handle);
    child.stderr?.on("data", handle);
    child.on("error", (e: any) => {
      console.error("[hyo] sign-in process error:", e);
      finish({ ok: false, error: (e?.message || "Sign-in couldn't start.").toString() });
    });
    child.on("close", (code: number | null) => {
      if (settled) return;
      if (code === 0) {
        finish(checkAuth(cliPath).loggedIn === false
          ? { ok: false, error: "Claude closed the sign-in but still reports you as signed out. Try again." }
          : { ok: true });
        return;
      }
      const last = output.trim().split(/\r?\n/).filter(Boolean).pop();
      console.error("[hyo] sign-in exited", code, output.slice(-500));
      finish({ ok: false, error: last ? `Claude said: ${last}` : `Sign-in stopped (code ${code}).` });
    });

    // Signed out at the start and signed in now: done, even if the login
    // process lingers. Never used when old credentials were already present.
    const poll = setInterval(() => {
      if (wasSignedOut && checkAuth(cliPath).loggedIn) finish({ ok: true });
    }, 2000);
    const timer = setTimeout(
      () => finish({ ok: false, error: "Sign-in timed out after five minutes. Click Sign in to try again." }),
      300000
    );
  });
}
