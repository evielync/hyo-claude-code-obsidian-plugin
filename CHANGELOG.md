# Changelog

## 0.3.4

### Features
- **Attached vault files now include the full path** — when you use "Attach current file", Claude receives the vault-relative path (e.g. `02 Projects/My Note.md`) not just the filename. Makes it possible for Claude to locate, update, or reference the file without you having to say where it lives.
- **AskUserQuestion UI** — when Claude uses the AskUserQuestion tool, questions now appear as interactive UI with option buttons and free-text input. Claude waits for your answer before continuing (previously it steamrolled through without pausing).
- **Plan mode review** — ExitPlanMode now shows the full plan as formatted markdown with Approve and Reject buttons. EnterPlanMode auto-approves silently.
- **Auto-naming conversations** — new conversations are automatically named based on the first exchange.

### Fixes
- **Usage monitor reliability** — improved credential caching and faster recovery when the usage API is slow or temporarily unavailable. Added fallback when `.credentials.json` is absent (e.g. fresh installs or Claude CLI not yet authenticated).
- **Browse buttons in settings use native file picker** — Browse buttons now open the system file dialog (Electron native) instead of a web input, matching OS conventions.

## 0.2.0

### New: Voice Mode
- **Talk to Claude, hear responses read aloud** — full conversational voice powered by ElevenLabs. Speech-to-text (you speak) + text-to-speech (Hyo speaks).
- **Voice toggle in status bar** — click to switch between text and voice mode. Per-tab, so different conversations can use different modes.
- **Settings: ElevenLabs API key, voice picker, playback speed, auto-speak toggle** — configure once in Hyo settings, voices load from your ElevenLabs account.
- **Streaming TTS with markdown stripping** — responses are cleaned of formatting before speech, and audio streams via ElevenLabs Flash v2.5 for lower latency.
- **Playback controls** — pause, resume, stop, replay last response, and adjustable speed (1×–2×).

### Fixes
- **Auto-generate conversation titles** — setting now properly wired to the session manager.

## 0.1.11

### Fixes
- **"Attach current file" now actually sends the file** — files attached via the paperclip → "Attach current file" were showing as chips in the UI but silently dropped before sending. Root cause: missing `fileType` field on the attachment object, which caused it to be filtered out during message assembly. Fixed.

## 0.1.10

### Fixes
- **Past sessions now found on Windows** — session lookup tries multiple path normalisations to find sessions regardless of how Windows APIs return the vault path.
- **Diagnostic logging** — console now shows which directories are checked when looking for past sessions.

## 0.1.9

### Fixes
- **Past conversations now work on Windows and non-ASCII paths** — the project directory hash has been rewritten to match Claude Code's exact algorithm (`replace(/[^a-zA-Z0-9]/g, "-")` + truncation with hash suffix for long paths). The old code only replaced forward slashes, which meant Windows backslash paths produced a completely wrong directory lookup — every Windows user saw zero past sessions. Also fixes paths containing dots, underscores, or spaces (e.g. `john.doe`, `My Vault`).
- **Symlink and Unicode path resolution** — the plugin now resolves symlinks (`realpathSync`) and normalises Unicode to NFC before hashing, matching Claude Code's internal behaviour. Fixes session lookup failures for vaults on iCloud, Dropbox aliases, or paths with accented characters on macOS.
- **"Always allow" button now works** — the permission response was sending `behavior: "allow_always"` which isn't in Claude Code's schema (only `"allow"` and `"deny"` are valid). Claude silently rejected it. Fixed to send `behavior: "allow"` with an `updatedPermissions` array that adds a session-level allow rule for the tool, plus `decisionClassification: "user_permanent"` — matching how Claude Code's own terminal UI handles it.

### Features
- **One-click session recovery** — when a session is poisoned by an orphaned thinking block (output cap mid-stream truncation), a recovery banner appears on the error message. Click "Recover session and continue" to surgically remove the corrupt entries from the JSONL file and resume. Your last attempted message is prefilled in the input.

## 0.1.8

### Fixes
- **Configurable output token cap** — added a "Max output tokens" setting (Settings → Hyo Plugin → Advanced) that's passed to Claude Code via `CLAUDE_CODE_MAX_OUTPUT_TOKENS`. Default is now 64000 (up from CC's 32000). The previous low cap could truncate large single-shot generations (big HTML files, complex code) and leave an orphaned signed `thinking` block in the session, poisoning every subsequent message with a `messages.N.content.M: thinking blocks cannot be modified` API error. Bumping the default prevents the cap from firing in normal use. Lower to 32000 in settings if using Opus models, which max out at 32k output.

## 0.1.7

### Fixes
- **Accurate context window ring** — usage now read from individual assistant events (not aggregated results), with subagent events filtered out; ratios no longer double-count
- **Auto-detect model context window** — picks up from `modelUsage` so 1M-context models show the correct ceiling
- **Strip inline `<thinking>` tags** — Claude 4.7's adaptive thinking occasionally emits `<thinking>…</thinking>` as text inside a normal response; these are now stripped at render so internal reasoning doesn't leak into the chat
- **Default agent no longer leaks between users** — `data.json` is no longer tracked in git and a migration clears stale `defaultAgent` if no matching agent file exists on disk
- **Past sessions open with your default agent** — previously opened with the generic "Default" regardless of settings

### Features
- **PDF attachments** — PDFs sent as native document blocks, no text extraction
- **Excel/XLSX attachments** — workbooks parsed to CSV using `exceljs` (avoids the SheetJS vulnerability path)
- **Large file attachment routing** — text attachments over ~5k tokens are saved to disk and Claude reads them on demand via the Read tool; messages stay lean and the content benefits from prompt caching on subsequent turns
- **Attachment size on chips** — chips show estimated token size; large (reference-mode) files have a dashed border so routing is visible before sending
- **Auto-cleanup of old attachments** — files older than 1 day are swept on plugin load
- **Auto-compact continuation** — after an auto-compact, Hyo nudges the CLI with "Please continue." so the conversation resumes instead of stalling

## 0.1.6
- **Settings refresh without restart** — changing settings now updates the chat panel immediately (no restart required)
- **Auto-detect CLI path** — new button in settings finds your Claude installation automatically
- **Default agent setting** — choose which agent to use for new conversations in settings
- **Per-field saved indicator** — "✓ Saved" now appears next to the field that changed, not just at the top of settings
- **Fixed agent picker** — removed hardcoded personal defaults; "Default" option is now a clean generic entry
- **Fixed BRAT version mismatch** — manifest version now correctly matches release tag

## 0.1.5
- Agent dot colours now fully hash-generated from agent name (no hardcoded colour map)

## 0.1.4
- Removed hardcoded default agent name from session manager and agent hook

## 0.1.3
- Agent picker hidden when no agent files are configured

## 0.1.2
- Install guide link added to splash screen

## 0.1.1
- Onboarding screen scroll fix (content no longer clips upward)
- "Saved" indicator in settings
- User guide link in settings and splash screen
- Model list updated (Opus 4.7, Sonnet 4.6, Haiku 4.5)

## 0.1.0
- Initial release
- Claude Code CLI integration via stream-json protocol
- Multi-tab conversations
- Tool call display with expandable input/output
- Permission prompts inline in chat
- File attachments (text and images)
- Past sessions browser
- Model and permission mode selector per tab
- Context window ring
- `/compact` command
- Slash command skill picker
