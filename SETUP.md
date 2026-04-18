# Hyo Plugin — Install Guide

## What You Need

- **Obsidian** — free download from [obsidian.md](https://obsidian.md)
- **BRAT plugin** — installed in Obsidian (Settings → Community Plugins → search "BRAT")
- **A Claude account** (Pro, Max, Team, or Enterprise) — [claude.ai](https://claude.ai)

---

## Installation

### Step 1: Add Hyo via BRAT

1. In Obsidian, go to **Settings → BRAT → Add Beta Plugin**
2. Paste in the Hyo repo URL: `https://github.com/evielync/hyo-claude-code-plugin`
3. Click **Add Plugin** — BRAT will download and install it
4. Go to **Settings → Community Plugins**, find **Hyo - Claude Code Obsidian Plugin**, and enable it

### Step 2: Install Claude Code (if needed)

Press `Cmd+Shift+H` (Mac) or `Ctrl+Shift+H` (Windows) to open Hyo. If Claude Code isn't installed yet, you'll see a setup screen with instructions.

You can follow the steps on screen yourself — or open Claude Desktop and paste the prompt below to have Claude walk you through it.

---

**Copy everything below this line:**

```
I need you to help me finish setting up an Obsidian plugin called Hyo. I've already installed the plugin. Now I need to make sure Claude Code CLI is installed on my machine. Walk me through this step by step — ask me questions as we go rather than assuming anything.

1. CHECK IF CLAUDE CODE IS INSTALLED
   Run `which claude` (Mac/Linux) or `where claude` (Windows) to see if Claude Code CLI is already on my machine.
   - If it's found, great — move on to step 2.
   - If not, install it by running: curl -fsSL https://claude.ai/install.sh | bash
     Then check it worked by running `which claude` again.
     If we're on Windows, use: irm https://claude.ai/install.ps1 | iex

2. ASK HOW I WANT TO USE THE PLUGIN
   There are two ways to use Hyo. Ask me which one fits:

   **Option A: I already use Obsidian with a vault.**
   I have a vault with notes in it. I want Hyo to work from that vault so Claude can see my files. That's the default — nothing extra needed.

   **Option B: I have a project folder I work from (like a folder with a CLAUDE.md).**
   I want to point Hyo at that folder instead of my Obsidian vault. Tell me to go to Settings → Hyo Plugin → Advanced → Working directory and enter the path to that folder. Claude will work from there, but I'll still use Obsidian as the interface.

3. CONFIRM EVERYTHING IS WORKING
   Tell me to:
   - Restart Obsidian (or just close and reopen the Hyo panel)
   - Press Cmd+Shift+H (Mac) or Ctrl+Shift+H (Windows) to open the Hyo chat panel
   - Type a message and check that Claude responds

Be friendly and clear. I might not be technical, so explain things simply if I get stuck.
```

---

## After Installation

### If you already use Obsidian

You're good to go. Hyo will use your vault as Claude's working directory by default. If you have a `CLAUDE.md` in your vault root, Claude will pick it up automatically.

**Optional:** If your Claude project files live in a separate folder (not inside your vault), go to **Settings → Hyo Plugin → Advanced → Working directory** and set it to that folder's path.

### If you're new to Obsidian

When you first opened Obsidian, you chose a folder as your vault. That folder is now Claude's working directory — it can see everything in there. You can create a `CLAUDE.md` file in the vault root to give Claude persistent instructions about how you work.

---

## Troubleshooting

**The plugin shows a setup screen about installing Claude Code**
Follow the steps on screen, or use the Claude Desktop prompt above.

**"Claude not found" or nothing happens when you send a message**
Go to **Settings → Hyo Plugin → Advanced → Claude Code CLI path** and make sure it points to the right location. The default works for most installations. If you're not sure where Claude is installed, open your terminal and run `which claude`.

**Chat panel doesn't appear**
Try `Cmd+Shift+H` (Mac) or `Ctrl+Shift+H` (Windows), or use the command palette (`Cmd+P` / `Ctrl+P`) and search for "Hyo".

**Plugin doesn't update via BRAT**
Go to Settings → BRAT → check for updates, or remove and re-add the plugin.
