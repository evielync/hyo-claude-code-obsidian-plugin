# Hyo Claude Code Plugin

**The power of Claude Code — without the terminal.**

![Hyo Claude Code Plugin](docs/screenshot.png)

If you want to use Claude Code inside Obsidian but the terminal isn't your thing, Hyo gives you everything Claude Code can do — full agent capability, MCP tools, multi-step reasoning — wrapped in a clean chat interface right inside your notes.

No separate app. No API keys. No extra billing. Just Claude, living in your vault.

---

## Features

- **Multiple conversation tabs** — run parallel conversations or keep different projects separate
- **Past sessions browser** — pick up any previous conversation right where you left off
- **Usage tracking** — see how much of your Claude plan you've used (5-hour window + 7-day)
- **Context window display** — visual indicator of how much conversation context is in use
- **Model switcher** — choose between Opus, Sonnet, and Haiku; 200K or 1M context
- **Permission modes** — control what Claude can do: ask every time, auto-edit, or hands-off
- **Slash commands** — load skills, compact your conversation, and more
- **File attachments** — attach the file you're currently editing with one click, or any text/image file
- **Inline permission prompts** — approve or deny Claude's tool requests without leaving the chat
- **Markdown rendering** — Claude's responses render as rich markdown, not raw text

---

→ **[Full setup guide with Claude Desktop install prompt](SETUP.md)**

---

## Requirements

- [Obsidian](https://obsidian.md) (desktop only)
- A Claude account — Pro, Max, Team, or Enterprise ([claude.ai](https://claude.ai))
- Claude Code CLI (the plugin will walk you through installing it if needed)

---

## Installation

Hyo is a beta plugin, so it installs via **BRAT** (Beta Reviewers Auto-update Tool).

**Step 1: Install BRAT**
In Obsidian, go to Settings → Community Plugins → Browse, search for "BRAT", install and enable it.

**Step 2: Add Hyo**
Go to Settings → BRAT → Add Beta Plugin, paste in:
```
https://github.com/evielync/hyo-claude-code-plugin
```
Click **Add Plugin**.

**Step 3: Enable it**
Go to Settings → Community Plugins, find **Hyo Claude Code Plugin**, and enable it.

**Step 4: Open Hyo**
Press `Cmd+Shift+H` (Mac) or `Ctrl+Shift+H` (Windows). If Claude Code isn't installed yet, the plugin will show you exactly how to set it up.

---

## How it works

Hyo runs Claude Code CLI as a background process and streams the conversation into Obsidian. Your vault root is Claude's working directory by default — so Claude can read and edit your notes, run tools, and use any MCP servers you've configured.

If your Claude project lives in a different folder, you can point Hyo there: Settings → Hyo Plugin → Advanced → Working directory.

---

## Built by

[Ev Chapman](https://evchapman.com) — teaching knowledge workers to build in partnership with AI.

Part of the [College of Knowledge](https://evchapman.com/cok) community.
