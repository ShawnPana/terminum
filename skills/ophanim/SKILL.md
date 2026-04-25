---
name: ophanim
description: Primer for agents working inside the ophanim repo — what ophanim is, how its code is laid out, where config lives, and how to add new configurable options without breaking the schema-driven UI.
---

# ophanim

A terminal that can summon a browser. Tile terminals and web pages in the
same window; flip a pane to a browser with `browse <url>`, flip it back
with `Alt+Esc`. macOS-first. tmux-backed so shells survive quit +
relaunch. Session restore brings back the full layout, shells, URLs and
back/forward history.

## Architecture (90-second tour)

- `main.js` — Electron main. World → Workspace → Split-tree → Pane
  model, layout math, IPC, keybinding dispatch, config loading, session
  restore glue.
- `renderer.js` — The termView. One xterm.js Terminal instance per
  terminal pane, custom OSC handler for the `browse` / `config` shell
  helpers, custom wheel handler for alt-buffer apps.
- `browser-chrome.html` — URL bar / nav chrome that stacks on top of
  each browser pane.
- `config-ui.html` — In-app settings pane. Schema-driven — walks the
  `DEFAULT_*` objects and renders form rows with live preview + per-field
  reset.
- `tmux-backend.js` — tmux as PTY supervisor. Generates
  `ophanim-tmux.conf` from config, manages session lifecycle.
- `session-store.js` — JSON snapshot of window bounds, split tree,
  pane kinds, browser history, focus, zoom. Round-trips on quit.

**Shell spawn path:** ophanim → `spawnPty` → tmux attach client → tmux
session → user's shell. Shells live in the tmux daemon (label
`-L ophanim`) so they outlast the Electron process. An external terminal
can `tmux -L ophanim attach -t <session>` and see the same shell.

**Browser panes:** each is a `WebContentsView` (page) plus a second
`WebContentsView` (chrome bar) stacked on top of the termView.
pane-host divs in the termView have a 1px CSS border that peeks through
the 1px inset around the WebContentsViews — that's the focus ring.

## Where config lives

**At runtime** the user has two files in `~/.config/ophanim/`:

- `defaults.json` — auto-rewritten on every launch from the source
  schema. Contains every setting with its default value and an inline
  `_reference` block describing what each one does. **Read this file
  first** when the user asks "how do I change X?" or "what keys does
  ophanim use?" — it's the source of truth for what's configurable
  right now.
- `config.json` — user overrides. Only fields that differ from default
  need to be present; everything else falls back. Edits hot-reload (no
  relaunch needed).

The in-app `config` command opens a schema-driven UI for the same file.

**In source**, all defaults are defined in `main.js`:

- `DEFAULT_BINDINGS` — keyboard shortcuts (action → chord strings).
- `DEFAULT_TERMINAL` — font, theme, shell, tmux path, scroll mode.
- `DEFAULT_WINDOW` — window size.
- `DEFAULT_PANES` — pane border colors / width.
- `DEFAULT_WORKSPACES` — workspace strip colors / wrap.
- `DEFAULT_BROWSER` — browser chrome + border colors.

Live values in module-level globals: `bindings`, `termConfig`,
`windowConfig`, `paneConfig`, `workspaceConfig`, `browserConfig`. Read
those at the point of use; never cache copies.

`applyParsedConfig` (in `main.js`) is the one place that reassigns the
globals + pushes changes to running state (keybindings, themes, tmux
conf, window sizes). Hot-reload works automatically if your feature
reads the live global.

## Config reflex (run this every feature)

Every feature has hardcoded knobs — colors, keys, sizes, timing,
thresholds. After finishing a change, audit them and tell the user
what you could expose. Don't wait to be asked.

**Good candidates:** keys, colors, fonts, sizes, timing constants,
behavioral toggles, paths to external tools, multipliers and factors,
any default where reasonable people disagree.

**Not candidates:** protocol constants (OSC numbers, IPC channel names),
values required for correctness (e.g. 1-pixel pane inset — breaks focus
border if changed), values with one obviously-right answer.

**How to add a configurable:**

1. Add a key to the right `DEFAULT_*` (nest under a sub-object when
   grouping — e.g. `terminal.scroll.linesPerPress`).
2. Read from the live global at point of use.
3. If it's hot-reloadable, ensure `applyParsedConfig` pushes the change.
   (The tmux conf, keybinding table, browser themes, and window sizes
   already do this.)
4. If it needs validation, add a check in `validateConfig`.
5. That's it — the config UI renders the field automatically from the
   schema, with live preview and a per-field reset button.

**Report format:**

> Feature X has these hardcoded now. Candidates for config:
> - `section.fieldA` (default `...`) — what it controls
> - `section.fieldB` (default `...`) — what it controls
>
> Want me to wire any?

Tight, scannable, one line per field. Let the user pick.

## Ground rules when extending

- Prefer existing `DEFAULT_*` buckets over new top-level sections.
- Keep `main.js` additions narrow — no abstraction without a second user.
- Session restore must round-trip any new pane state.
- tmux is a PTY supervisor here, not a UI. Features needing tmux's own
  UI (status bar, prefix chords) belong higher up.
- Rebuild with `npm run dist` after changes; copy
  `dist/mac-arm64/Ophanim.app` → `/Applications/Ophanim.app` to test.
