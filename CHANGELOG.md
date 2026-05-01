# Changelog

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
