# Simple Home Page

Simple Home Page adds a focused home screen to Obsidian with fast file-name search, recent-note access, deleted-note restore, and quick vault navigation.
Obsidian Plugin View: https://community.obsidian.md/plugins/simple-home

## Features

- File-name search for notes and folders
- Recent notes, pinned notes, and deleted notes tabs
- Local trash with restore and permanent delete actions
- Recent folders and a simplified vault tree for navigation
- Open last closed note and reopen recently closed notes
- Create temporary notes directly from Home
- Theme-aware styling that follows your Obsidian appearance settings

## Installation

### Community Plugins

Install `Simple Home Page` from Obsidian's Community Plugins browser once it is available there.

### Manual Installation

1. Close Obsidian.
2. Copy `manifest.json`, `main.js`, and `styles.css` into `.obsidian/plugins/simple-home/`.
3. Reopen Obsidian.
4. Enable `Simple Home Page` in `Settings -> Community plugins`.

## Usage

- Use the Home button or the `Simple Home Page: Open home` command to open the view.
- Search matches note and folder names, not file contents.
- The `Deleted` tab lets you restore notes moved to the plugin's local bin or remove them permanently.
- The `Open last closed note` button reopens the most recent closed note.
- `Cmd` on macOS or `Ctrl` on Windows/Linux while clicking `Open last closed note` opens recently closed notes in new tabs.
- The `Create temporary note` button creates a new note in the temporary folder.
- `Cmd` on macOS or `Ctrl` on Windows/Linux while clicking `Create temporary note` opens the new temporary note in a new tab.

## Commands

You can assign hotkeys to these commands in `Settings -> Hotkeys`:

- `Simple Home Page: Open home`
- `Simple Home Page: Open home in left sidebar`
- `Simple Home Page: Open last closed note`
- `Simple Home Page: Open recently closed notes`
- `Simple Home Page: Create temporary note`
- `Simple Home Page: Focus home search`

## Local Bin

When you delete a note from Home, the plugin moves it into a local bin at `bin/local-home-page/` instead of deleting it immediately. You can restore it later from the `Deleted` tab or remove it permanently.
