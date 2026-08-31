# Hyo — working rules

Hyo is a public Obsidian plugin. Other people run it, on their machines, and they cannot read the code to work out why something is broken.

## Every platform, every time

Hyo runs on **macOS, Windows, Linux, iOS and Android**. Every change is thought through on all of them before it ships, not just the one it was written on.

The places this breaks are always the same, so check them first:

| Thing | What to hold |
|---|---|
| Locating a binary | Never a hardcoded list of Unix paths. Include the Windows install locations and read them from `ProgramFiles` / `LOCALAPPDATA` so a non-default drive still resolves. |
| Building `PATH` | Join with `path.delimiter`, never `":"`. The extra Unix directories are Mac and Linux only. |
| Joining paths | `path.join`, never string concatenation with `/`. |
| Running a shell command | The `osascript` wrapper is macOS-only and exists because the App Store Tailscale binary lies about its exit code. Every other platform spawns directly. |
| Anything under `Platform.isMobile` | Node built-ins do not exist on mobile. They are deferred at the top of each module for this reason. |

Mobile access shipped in 0.5.0 having never been considered on Windows, and was broken there for everyone until 31 August. The binary lookup listed four paths and all four were Mac or Linux. That is the shape of this mistake: it is invisible on the machine you are building on.

## Failures must say what happened

A status a person cannot act on is worse than a crash. Anything that can fail while someone waits has to end in a stated reason.

- **No unbounded waits.** Every spawned process gets a timeout, and a hung one is reported as a failure like any other.
- **No swallowed errors.** A `catch` that keeps a queue alive must still surface what it caught. A chain that stops halfway leaves the UI saying nothing forever.
- **Async work needs its own catch.** A try/catch around a call that returns a promise only covers the synchronous part. Everything after the first `await` needs catching where it runs.
- **Log where a member can reach it.** The developer console is not somewhere anyone will look. Mobile startup writes to `~/.hyo/mobile.log` regardless of the debug setting.
- **Error text names the cause and the next step.** "Tailscale isn't installed" when it plainly is installed sends people off to fix the wrong thing, and the report never comes back.

## No terminal, ever

A member must never be asked to open a terminal to diagnose or repair Hyo. If the plugin needs to know something about the machine, the plugin finds out and says so. Settings → Hyo → Mobile → **Check mobile access** is where that lives: it runs the whole chain and reports each step in plain words with the fix attached.

Anything new that can fail on someone else's computer gets a check in there too.

## Sandbox

Build and test in the `chad` vault, which is symlinked to this repo. Unreleased builds never reach EV-HQ, which runs the released plugin through BRAT.
