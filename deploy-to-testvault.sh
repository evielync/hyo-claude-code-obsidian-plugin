#!/bin/bash
V="$HOME/Library/Mobile Documents/iCloud~md~obsidian/Documents/Hyo Test/.obsidian/plugins/hyo"
cp "$HOME/projects/obsidian-hyo/manifest.json" "$HOME/projects/obsidian-hyo/main.js" "$HOME/projects/obsidian-hyo/styles.css" "$V/" && echo "deployed to Hyo Test vault"
