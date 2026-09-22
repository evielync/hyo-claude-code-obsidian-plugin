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

- **Hyo updates Claude for you when a model needs a newer one.** Opus 5.5 only runs on a recent version of Claude, and on an older one your message came back as a technical error. Now you get a short note saying Claude needs an update, with an **Update Claude** button. Hyo updates it quietly in the background and sends your message again once it's done. If you pick a model your Claude is too old for, Hyo tells you as soon as you open the chat, so you can update before you hit the problem. On your phone, the note tells you to open Hyo on your computer, which does the update.
