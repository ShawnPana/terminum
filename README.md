# ophanim

A terminal that can summon a browser. Tile terminals and web pages in the same
window; flip a pane to a browser with `browse <url>`, flip it back with
`Alt+Esc`. macOS-first.

**Self-evolving.** ophanim is meant to be modified by the agents you run
inside it. "Make the border red", "rebind scroll-mode to Option+Space",
"expose an option for X" — say it to an agent, it edits the source and
rebuilds. See [`skills/ophanim/SKILL.md`](./skills/ophanim/SKILL.md) for
the codebase tour and the config-reflex rule agents follow.

## Install

```bash
git clone https://github.com/ShawnPana/ophanim.git
cd ophanim
npm install
npm start
```

`npm install` runs `electron-rebuild` against `node-pty`. If that fails you'll
need build tools:

- **macOS:** `xcode-select --install`
- **Linux:** `sudo apt install build-essential python3` (or distro equivalent)
- **Windows:** experimental at best — keybindings and stealth tuning are macOS-shaped

## Use

In a terminal pane, type `browse <url>` to convert the pane into a browser.
The browser starts *disengaged* — your keybindings still work. Press
`Cmd+Enter` to *engage* (page receives keystrokes), `Alt+Esc` to disengage.
Press `Alt+Esc` again on a disengaged browser pane to flip it back to a
terminal.

`config` opens a settings pane (`~/.config/ophanim/config.json`).
`ophanim --help` shows the full command list.

## Default keybindings

| chord | action |
|---|---|
| `Alt+N` | new terminal pane (smart split) |
| `Alt+W` | close focused pane |
| `Cmd+Alt+N` / `Cmd+Alt+Shift+N` | explicit split right / down |
| `Cmd+H/J/K/L` | move focus left / down / up / right |
| `Cmd+Alt+=` | equalize splits |
| `Cmd+T` / `Cmd+W` | new / close workspace |
| `Cmd+Shift+]` / `Cmd+Shift+[` | next / previous workspace |
| `Cmd+Shift+N` / `Cmd+Shift+W` | new / close window |
| `Cmd+=` / `Cmd+-` / `Cmd+0` | zoom in / out / reset |
| `Cmd+Enter` | engage focused browser pane |
| `Alt+Esc` | disengage / convert browser back to terminal |
| `Cmd+Alt+I` | devtools |

All chords are configurable in `config.json`. Cmd is the macOS Command key —
on Linux/Windows Electron maps it to Super; remap to `Ctrl+...` if you'd
prefer.

## Config

Two files in `~/.config/ophanim/`:

- `defaults.json` — regenerated on every launch. Read-only reference. Lists
  every key, its default, and an inline schema in `_reference`.
- `config.json` — your overrides. Only fields that differ from defaults need
  to be present; everything else falls back to the default. Edits are
  hot-reloaded.

The `config` command opens a schema-driven UI for the same file.

## Architecture

- One Electron `BrowserWindow` per "world", each with a binary split tree of
  panes.
- Terminal panes are xterm.js running in the renderer; PTY in main via
  `node-pty`. Browser panes are `WebContentsView`s stacked above the
  terminal layer.
- Pane focus is tracked in main; keystrokes are intercepted at the
  webContents level via `before-input-event`.
- `bin/browse`, `bin/config`, `bin/ophanim` emit OSC `1983;…` escape
  sequences that the renderer parses and forwards to main.
- Shell integration injects `bin/` onto `$PATH` and re-prepends it via
  per-shell wrappers in `shell/{zsh,bash,fish}/` so macOS path_helper
  doesn't strip it from login shells.

## License

See [LICENSE](LICENSE).
