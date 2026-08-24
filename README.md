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

The main differences from macOS Stickies

- You can write Markdown
- Clicking one note brings every note to the front
  - Handy when you open it from a launcher (Alfred and friends) or Mission Control!
- Deleted notes can be restored from the trash
- The buttons you reach for can be shown right on the note

## Features

- 📋 Markdown support
  - 👀 While you edit, only the line under the cursor turns back into raw Markdown — the rest stays rendered
  - ✏️ Input help, such as continuing a list on Enter
  - 🔗 Pasted rich text becomes Markdown
- 🪟 Clicking one note brings every note to the front
- 🎨 Six color themes
- 🗑️ Trash that keeps up to 200 deleted notes for restoring
- 🔍 Per-note zoom (⌘+ / ⌘- / ⌘0)
- 🌐 Japanese and English UI, following the OS locale or pinned in settings
- ⚙️ Settings for the default color, opacity, which buttons to show, delete confirmation and start at login

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

- [Development guide](DEVELOPMENT.md) (Japanese only)
- [Homebrew tap repository](https://github.com/somei-san/homebrew-tap)

## Support

[![Buy Me a Coffee](https://img.shields.io/badge/Buy%20Me%20a%20Coffee-support-FFDD00?logo=buymeacoffee&logoColor=black)](https://buymeacoffee.com/somei)

## About the name

“貼っとっと” is Kumamoto dialect for “it’s stuck up there”.
