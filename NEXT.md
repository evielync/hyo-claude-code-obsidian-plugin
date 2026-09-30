# Next release

Finished, tested work that has merged to `main` and is waiting to go out.

A bullet lands here the moment its branch merges, written the way it will read
to a member — because at release time these bullets move into `CHANGELOG.md`
under the new version heading, unchanged. Writing them here, while the work is
fresh, is what stops a release turning into archaeology over a git log.

This file never ships. `esbuild` inlines `CHANGELOG.md` into the plugin, and
`parseChangelog` reads every `##` heading as a version number, so anything
pending has to live outside that file or it appears inside Hyo as a release
called "Unreleased".

Empty means everything finished is already released.

---

## Waiting

- **The history tab only flags conversations that need you.** "Waiting on response" is gone. It marked nearly every conversation, because almost every chat ends with the agent talking. Now a conversation only gets a label when an agent is working or is stuck waiting on your answer. Pin the ones you want to come back to, and mark them done when you've finished.
