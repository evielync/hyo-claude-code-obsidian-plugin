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

const supportsEffort = new Map<string, boolean>();
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

  const probe = new Promise<boolean>((resolve) => {
    execFile(cliPath, ["--help"], { timeout: 10_000 }, (err, stdout) => {
      // On any failure assume no flag support and use the environment
      // variable — the conservative direction.
      const ok = !err && /--effort\b/.test(stdout || "");
      supportsEffort.set(cliPath, ok);
      inFlight.delete(cliPath);
      debug(
        "[hyo] CLI capability probe:",
        cliPath,
        ok ? "supports --effort" : "no --effort flag, using env var"
      );
      resolve(ok);
    });
  });

  inFlight.set(cliPath, probe);
  return probe;
}
