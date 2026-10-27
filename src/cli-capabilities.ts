// Feature detection for the Claude Code CLI.
//
// The CLI's interface moves between versions, and Hyo can't assume which build
// a user has on their machine. Effort level is the current example: newer CLIs
// expose a proper `--effort <level>` flag, older ones only honour the
// CLAUDE_CODE_EFFORT_LEVEL environment variable.
//
// Passing the flag to a CLI that doesn't recognise it is fatal — commander
// rejects unknown options and the process never starts, so every message would
// fail. Setting an environment variable a CLI doesn't read is harmless: it's
// simply ignored. So the environment variable is the safe fallback, and the
// flag is only used once we've positively confirmed it exists.
//
// Detection reads `--help` rather than comparing version numbers, so it stays
// correct without anyone maintaining a table of which version added what.

import { Platform } from "obsidian";
import { debug } from "./debug";

// Desktop-only. Deferred so importing this module never runs `require` on a
// phone; the probe below is guarded and never called on mobile anyway.
const execFile: typeof import("child_process").execFile = Platform.isMobile
  ? (undefined as any)
  : require("child_process").execFile;
const spawnChild: typeof import("child_process").spawn = Platform.isMobile ? (undefined as any) : require("child_process").spawn;
const fs: typeof import("fs") = Platform.isMobile ? (undefined as any) : require("fs");
const os: typeof import("os") = Platform.isMobile ? (undefined as any) : require("os");
const nodePath: typeof import("path") = Platform.isMobile ? (undefined as any) : require("path");

// The help always ends with its list of commands. Claude Code 2.1.280 exits
// before a pipe has taken all of its `--help` (seen cut off at 8190 of 16380
// bytes, about half the time), and the later options are lost with it.
const HELP_END = /\nCommands:/;

/**
 * The CLI's `--help`, whole. Read through a pipe first; if that came back cut
 * short, read again through a file, which the CLI writes in full before it
 * exits. Resolves with whatever it got ("" on failure), never hangs.
 */
function readHelp(cliPath: string): Promise<{ text: string; failed: boolean }> {
  return new Promise((resolve) => {
    execFile(cliPath, ["--help"], { timeout: 10_000 }, (err, stdout) => {
      const text = stdout || "";
      if (err || HELP_END.test(text)) return resolve({ text, failed: !!err });
      let file = "";
      let fd: number | null = null;
      const done = (full: string) => {
        try {
          if (fd !== null) fs.closeSync(fd);
          if (file) fs.unlinkSync(file);
        } catch {
          /* already gone */
        }
        fd = null;
        file = "";
        resolve({ text: full.length > text.length ? full : text, failed: false });
      };
      try {
        file = nodePath.join(os.tmpdir(), `hyo-cli-help-${process.pid}-${Date.now()}.txt`);
        fd = fs.openSync(file, "w");
        const child = spawnChild(cliPath, ["--help"], { stdio: ["ignore", fd, "ignore"] });
        const timer = setTimeout(() => {
          try {
            child.kill();
          } catch {
            /* already gone */
          }
          done("");
        }, 10_000);
        child.on("error", () => {
          clearTimeout(timer);
          done("");
        });
        child.on("close", () => {
          clearTimeout(timer);
          let full = "";
          try {
            full = fs.readFileSync(file, "utf8");
          } catch {
            /* nothing written */
          }
          done(full);
        });
      } catch {
        done("");
      }
    });
  });
}

const supportsEffort = new Map<string, boolean>();
// `--replay-user-messages`: Claude echoes each message written to it at the
// moment it takes it in, which is how Hyo knows a message sent mid-reply
// ("Send now" on a queued message) has reached Claude. Same rule as effort:
// passed only once the probe has seen it in `--help`.
const supportsReplay = new Map<string, boolean>();
const inFlight = new Map<string, Promise<boolean>>();

/**
 * Whether this CLI accepts `--effort`. Synchronous, for use at spawn time.
 *
 * Returns false until a probe has completed — deliberately conservative, since
 * a false negative just means the environment-variable path is used for the
 * first message, whereas a false positive would break the spawn entirely.
 */
export function supportsEffortFlag(cliPath: string): boolean {
  return supportsEffort.get(cliPath) === true;
}

/** Whether this CLI accepts `--replay-user-messages` (false until probed). */
export function supportsReplayFlag(cliPath: string): boolean {
  return supportsReplay.get(cliPath) === true;
}

/** True once this CLI has been probed, whatever the outcome. */
export function hasProbed(cliPath: string): boolean {
  return supportsEffort.has(cliPath);
}

/**
 * Probe the CLI's capabilities and cache the result for this path.
 *
 * Safe to call repeatedly — cached results return immediately and concurrent
 * calls share one in-flight probe. Fire-and-forget is fine; callers read the
 * result later via supportsEffortFlag().
 */
export function probeCliCapabilities(cliPath: string): Promise<boolean> {
  if (!cliPath) return Promise.resolve(false);

  const cached = supportsEffort.get(cliPath);
  if (cached !== undefined) return Promise.resolve(cached);

  const existing = inFlight.get(cliPath);
  if (existing) return existing;

  const probe = readHelp(cliPath).then(({ text, failed }) => {
    // On any failure assume no flag support and use the environment
    // variable — the conservative direction.
    const ok = !failed && /--effort\b/.test(text);
    supportsEffort.set(cliPath, ok);
    supportsReplay.set(cliPath, !failed && /--replay-user-messages\b/.test(text));
    inFlight.delete(cliPath);
    debug(
      "[hyo] CLI capability probe:",
      cliPath,
      ok ? "supports --effort" : "no --effort flag, using env var",
      supportsReplay.get(cliPath) ? "and --replay-user-messages" : "without --replay-user-messages (no Send now)"
    );
    return ok;
  });

  inFlight.set(cliPath, probe);
  return probe;
}
