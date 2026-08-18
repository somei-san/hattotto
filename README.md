<div align="center">
  <img src="assets/app-icon.png" alt="Hattotto" width="128" />
  <h1>🐻 Hattotto (貼っとっと)</h1>
  <p>Sticky notes you slap onto the desktop, with a bear paw on top<br>Lightweight, native, and it feels like macOS Stickies</p>
</div>

<p align="center">
  <a href="README.ja.md">日本語</a>
</p>

<p align="center">
  <img src="assets/hero.svg" alt="Hattotto screenshot" width="600" />
</p>

## Highlights
Where it differs from macOS Stickies

- Markdown support
- Clicking one note brings every note to the front
  - Handy when you open it from a launcher (Alfred and friends) or Mission Control
- Deleted notes can be restored from the trash
- The things you reach for are one click away
  - New note
  - Pin
  - Color picker
- It looks a bit nicer

## Features

- 📝 Each note is its own frameless window
- 🎨 Six color themes (yellow, blue, green, pink, purple, gray)
- 💾 Autosave for text, position, size and zoom
- 🔄 Notes come back where you left them on the next launch
- ➕ New notes from the button, the tray menu, or ⌘N
- 🗑️ Trash that keeps up to 200 deleted notes for restoring
- 🔍 Per-note zoom (⌘+ / ⌘- / ⌘0)
- 📋 Markdown is always rendered (headings, bullet and numbered lists, checkboxes, bold, italic, strikethrough, code, quotes, rules and links). While you edit, only the line under the caret turns back into raw Markdown — the rest stays rendered
- ✏️ Markdown input help, such as continuing a list on Enter
- 🔗 Rich text pasted from a browser becomes Markdown
- 🖱️ Custom right-click menu
- 🌐 Japanese and English UI, following the OS locale or pinned in settings
- ⚙️ Settings for the default color, opacity, which buttons to show, delete confirmation, language and start at login

## Install

### Homebrew (recommended)

```bash
brew trust somei-san/tap
brew install --cask somei-san/tap/hattotto
```

`brew trust` is needed once. Since Homebrew 6, casks from an untrusted tap are not loaded, and skipping this makes `brew upgrade` pass over hattotto without an error — you would not notice it stopped updating.

> **Note:** The app is not code-signed, so the quarantine attribute is removed for you at install time.

## Where data is stored

```
~/Library/Application Support/com.hattotto.app/
├── notes.json      # notes
├── settings.json   # settings
└── trash.json      # trash (up to 200 notes)
```

## Links

- [Development guide](DEVELOPMENT.md)
- [Homebrew tap repository](https://github.com/somei-san/homebrew-tap)

## About the name

“貼っとっと” is Kumamoto dialect for “it’s stuck up there”.
