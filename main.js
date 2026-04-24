const { app, BrowserWindow, WebContentsView, ipcMain, session, dialog } = require('electron');

const path = require('path');
const os = require('os');
const fs = require('fs');
const pty = require('node-pty');

// Stealth: mirror ophanim-browser's switches. Cloudflare and Kasada-style
// bot walls scan for these signals.
//   - `AutomationControlled` Blink feature sets navigator.webdriver = true
//     and adds related automation signals; disable it.
//   - Strip "ophanim/x.y.z" and "Electron/x.y.z" from the default user agent
//     so pages see a plain Chrome UA, not an Electron-branded one.
//   - Enable Chromium's remote-debugging so CDP is available at runtime
//     (0 = auto-select port); allow any origin since we gate externally.
app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled');
app.commandLine.appendSwitch('remote-debugging-port', '0');
app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1');
app.commandLine.appendSwitch('remote-allow-origins', '*');
app.userAgentFallback = (app.userAgentFallback || '')
  .replace(/\s?ophanim\/\S+/, '')
  .replace(/\s?Electron\/\S+/, '');

// Boot-time config read: certain settings (like userData path) must be
// applied before app.whenReady(). Everything else is still loaded lazily
// via loadConfigFromDisk in whenReady().
(function applyBootConfig() {
  try {
    const bootCfgPath = path.join(os.homedir(), '.config', 'ophanim', 'config.json');
    const raw = fs.readFileSync(bootCfgPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.profileDir === 'string' && parsed.profileDir.trim()) {
      const dir = parsed.profileDir.trim().replace(/^~(?=\/|$)/, os.homedir());
      try { app.setPath('userData', dir); } catch (e) { console.warn('[ophanim] profileDir:', e.message); }
    }
  } catch {}
})();

const APP_DIR = __dirname;
// HTMLs and the preload can stay inside app.asar — Electron reads them.
// Scripts the spawned pty has to `exec` or `source` (bin/* and shell/*)
// cannot live inside an archive, so in a packaged build they're read from
// the asar.unpacked resources directory alongside it. In dev, both
// collapse to __dirname.
const UNPACKED_DIR = app.isPackaged
  ? path.join(process.resourcesPath, 'app.asar.unpacked')
  : APP_DIR;
const BIN_DIR = path.join(UNPACKED_DIR, 'bin');
const CHROME_HTML = path.join(APP_DIR, 'browser-chrome.html');
const CONFIG_UI_HTML = path.join(APP_DIR, 'config-ui.html');
const BROWSER_PRELOAD = path.join(APP_DIR, 'browser-preload.js');
const CHROME_BAR_HEIGHT = 28;
const WORKSPACE_BAR_BASE_HEIGHT = 22;

// tmux backend: when available, every terminal pane's shell is spawned
// inside a tmux server so shells outlive ophanim. Lazy-initialized after
// app.whenReady so we can read `app.getPath('userData')`.
const tmuxBackendLib = require('./tmux-backend');
let tmuxBackend = null;
function initTmuxBackend() {
  if (tmuxBackend) return tmuxBackend;
  tmuxBackend = tmuxBackendLib.createBackend({
    unpackedDir: UNPACKED_DIR,
    userDataDir: app.getPath('userData'),
    getOverridePath: () => (termConfig && termConfig.tmuxPath) || '',
  });
  return tmuxBackend;
}

// Session store: snapshot the layout (window bounds, workspaces, split
// tree, browser URLs/history) so that quit+relaunch comes back in the
// same shape. Lazy-initialized same as tmux backend.
const sessionStoreLib = require('./session-store');
let sessionStore = null;
function initSessionStore() {
  if (sessionStore) return sessionStore;
  sessionStore = sessionStoreLib.createStore({
    userDataDir: app.getPath('userData'),
    getWorlds: () => worlds,
  });
  return sessionStore;
}
// Trivial indirect so callers anywhere don't need to remember to
// init — they just fire-and-forget.
function markSessionDirty() {
  if (sessionStore) sessionStore.scheduleDirtyWrite();
}

function currentBarHeight(world) {
  const fs = Math.max(6, Math.min(72, (termConfig && termConfig.fontSize || 13) + (world.zoomDelta || 0)));
  // Scale bar height proportionally to terminal font size (min 22px).
  return Math.max(WORKSPACE_BAR_BASE_HEIGHT, Math.round(fs * 1.7));
}

const CONFIG_DIR = path.join(os.homedir(), '.config', 'ophanim');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');
const DEFAULTS_PATH = path.join(CONFIG_DIR, 'defaults.json');

const DEFAULT_BINDINGS = {
  // Pane ops
  newTerminal:      ['Alt+N'],
  closePane:        ['Alt+W'],
  splitRight:       ['Cmd+Alt+N'],
  splitDown:        ['Cmd+Alt+Shift+N'],
  navLeft:          ['Cmd+H'],
  navDown:          ['Cmd+J'],
  navUp:            ['Cmd+K'],
  navRight:         ['Cmd+L'],
  swapLeft:         ['Alt+Shift+J'],
  swapDown:         ['Alt+Shift+K'],
  swapUp:           ['Alt+Shift+I'],
  swapRight:        ['Alt+Shift+L'],
  equalize:         ['Cmd+Alt+='],
  // Workspace ops (named "windows" in tmux/smux terms — a tab of panes)
  newWorkspace:     ['Cmd+T'],
  closeWorkspace:   ['Cmd+W'],
  nextWorkspace:    ['Cmd+Shift+]'],
  prevWorkspace:    ['Cmd+Shift+['],
  // Electron window ops
  newWindow:        ['Cmd+Shift+N'],
  closeWindow:      ['Cmd+Shift+W'],
  // Zoom
  zoomIn:           ['Cmd+='],
  zoomOut:          ['Cmd+-'],
  zoomReset:        ['Cmd+0'],
  // Browser engage
  engage:           ['Cmd+Enter'],
  disengage:        ['Alt+Escape'],
  devtools:         ['Cmd+Alt+I'],
};

const DEFAULT_TERMINAL = {
  fontFamily: 'ui-monospace, Menlo, monospace',
  fontSize: 13,
  cursorBlink: true,
  theme: { background: '#000000', foreground: '#e0e0e0' },
  shell: null,
  // Override for the bundled tmux binary. Empty / null = use the bundled
  // copy at build/vendor/tmux-<arch>/tmux. Set to a path (e.g.
  // "/opt/homebrew/bin/tmux") to use your own.
  tmuxPath: null,
};

const DEFAULT_WINDOW = { width: 1000, height: 650 };

// Default colors mirror smux's tmux.conf:
//   pane-border-style fg=colour236              → #303030
//   pane-active-border-style fg=red             → #cd0000
//   status-style bg=default,fg=colour245        → bg=#000000, fg=#8a8a8a
//   window-status-current-style fg=red,bold     → #cd0000, bold
const DEFAULT_PANES = {
  border: { inactive: '#303030', focused: '#cd0000', width: 1 },
};

const DEFAULT_WORKSPACES = {
  wrap: true,
  background:       '#000000',
  foreground:       '#8a8a8a',
  activeForeground: '#cd0000',
  borderTop:        '#303030',
  hoverBackground:  '#1a1a1a',
  hoverForeground:  '#dddddd',
};

const DEFAULT_BROWSER = {
  engagedBorderColor:    '#4a9eff',
  disengagedBorderColor: '#1b1b1b',
  loadingBarColor:       '#4a9eff',
  chromeBackground:      '#1b1b1b',
  chromeForeground:      '#bbbbbb',
  urlBarBackground:      '#0d0d0d',
  urlBarForeground:      '#dddddd',
};

let bindings = DEFAULT_BINDINGS;
let termConfig = DEFAULT_TERMINAL;
let windowConfig = DEFAULT_WINDOW;
let paneConfig = DEFAULT_PANES;
let workspaceConfig = DEFAULT_WORKSPACES;
let browserConfig = DEFAULT_BROWSER;

function parseChord(str) {
  const parts = String(str).split('+').map((s) => s.trim()).filter(Boolean);
  const out = { meta: false, alt: false, shift: false, ctrl: false, key: '' };
  for (const p of parts) {
    const lp = p.toLowerCase();
    if (lp === 'cmd' || lp === 'meta' || lp === 'command') out.meta = true;
    else if (lp === 'alt' || lp === 'option' || lp === 'opt') out.alt = true;
    else if (lp === 'shift') out.shift = true;
    else if (lp === 'ctrl' || lp === 'control') out.ctrl = true;
    else out.key = lp;
  }
  return out;
}

function chordKey(input) {
  const c = String(input.code || '');
  if (/^Key[A-Z]$/.test(c)) return c.slice(3).toLowerCase();
  if (/^Digit\d$/.test(c)) return c.slice(5);
  return String(input.key || '').toLowerCase();
}

function matchesChord(input, chord) {
  if (input.type !== 'keyDown') return false;
  if (!!input.meta !== chord.meta) return false;
  if (!!input.alt !== chord.alt) return false;
  if (!!input.shift !== chord.shift) return false;
  if (!!input.control !== chord.ctrl) return false;
  const k = chordKey(input);
  if (chord.key === '=' && (k === '=' || k === '+')) return true;
  return k === chord.key;
}

function actionFor(input) {
  for (const [action, chords] of Object.entries(bindings)) {
    for (const str of chords) {
      if (matchesChord(input, parseChord(str))) return action;
    }
  }
  return null;
}

function mergeDeep(defaults, patch) {
  if (!patch || typeof patch !== 'object') return defaults;
  const out = Array.isArray(defaults) ? [...defaults] : { ...defaults };
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && typeof defaults[k] === 'object' && !Array.isArray(defaults[k])) {
      out[k] = mergeDeep(defaults[k], v);
    } else if (v !== undefined && v !== null) {
      out[k] = v;
    }
  }
  return out;
}

let lastConfigError = null;

function pushConfigError(msg) {
  lastConfigError = msg;
  for (const world of worlds.values()) {
    if (world.rendererReady && !world.win.isDestroyed()) {
      world.termView.webContents.send('config-error', { message: msg });
    }
  }
}

function validateConfig(parsed) {
  const errors = [];
  const validActions = new Set(Object.keys(DEFAULT_BINDINGS));

  if (parsed.keybindings !== undefined) {
    if (!parsed.keybindings || typeof parsed.keybindings !== 'object' || Array.isArray(parsed.keybindings)) {
      errors.push('keybindings must be an object');
    } else {
      for (const [action, chords] of Object.entries(parsed.keybindings)) {
        if (!validActions.has(action)) {
          errors.push(`unknown action "${action}" (valid: ${[...validActions].sort().join(', ')})`);
          continue;
        }
        const list = Array.isArray(chords) ? chords : (typeof chords === 'string' ? [chords] : null);
        if (!list) { errors.push(`keybindings.${action}: must be a string or array of strings`); continue; }
        for (const chord of list) {
          if (typeof chord !== 'string') { errors.push(`keybindings.${action}: chord must be a string`); continue; }
          const c = parseChord(chord);
          if (!c.key) errors.push(`keybindings.${action}: chord "${chord}" has no key`);
        }
      }
    }
  }

  // Type sanity on other sections.
  if (parsed.terminal !== undefined && (typeof parsed.terminal !== 'object' || Array.isArray(parsed.terminal))) {
    errors.push('terminal must be an object');
  }
  if (parsed.window !== undefined && (typeof parsed.window !== 'object' || Array.isArray(parsed.window))) {
    errors.push('window must be an object');
  }
  if (parsed.panes !== undefined && (typeof parsed.panes !== 'object' || Array.isArray(parsed.panes))) {
    errors.push('panes must be an object');
  }
  if (parsed.workspaces !== undefined && (typeof parsed.workspaces !== 'object' || Array.isArray(parsed.workspaces))) {
    errors.push('workspaces must be an object');
  }
  if (parsed.browser !== undefined && (typeof parsed.browser !== 'object' || Array.isArray(parsed.browser))) {
    errors.push('browser must be an object');
  }

  return errors;
}

function loadConfigFromDisk() {
  let parsed = null;
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    parsed = JSON.parse(raw);
  } catch (e) {
    if (e.code === 'ENOENT') {
      parsed = {};
    } else {
      const msg = `config syntax: ${e.message}`;
      console.warn('[ophanim]', msg);
      pushConfigError(msg);
      return;
    }
  }

  const errors = validateConfig(parsed);
  if (errors.length > 0) {
    const msg = `config: ${errors.join('; ')}`;
    console.warn('[ophanim]', msg);
    pushConfigError(msg);
    return; // don't apply a semantically-broken config
  }

  if (lastConfigError) pushConfigError(null);

  if (parsed && parsed.keybindings && typeof parsed.keybindings === 'object') {
    const next = { ...DEFAULT_BINDINGS };
    for (const [k, v] of Object.entries(parsed.keybindings)) {
      if (Array.isArray(v)) next[k] = v.filter((x) => typeof x === 'string');
      else if (typeof v === 'string') next[k] = [v];
    }
    bindings = next;
  } else {
    bindings = DEFAULT_BINDINGS;
  }

  termConfig = mergeDeep(DEFAULT_TERMINAL, parsed && parsed.terminal);
  // Let a `terminal.tmuxPath` edit take effect without restart.
  if (tmuxBackend) tmuxBackend.invalidatePathCache();
  windowConfig = mergeDeep(DEFAULT_WINDOW, parsed && parsed.window);
  paneConfig = mergeDeep(DEFAULT_PANES, parsed && parsed.panes);
  workspaceConfig = mergeDeep(DEFAULT_WORKSPACES, parsed && parsed.workspaces);
  browserConfig = mergeDeep(DEFAULT_BROWSER, parsed && parsed.browser);

  for (const world of worlds.values()) pushRuntimeConfig(world);
  // Live-update any open browser panes with the new theme.
  for (const world of worlds.values()) {
    for (const ws of world.workspaces) {
      for (const pane of ws.panes.values()) {
        if (pane.kind === 'browser') {
          updateBrowserBorder(pane);
          pushBrowserTheme(pane);
        }
      }
    }
  }
  // Live-resize open windows so window.width / window.height edits are
  // visible without relaunching. setSize ignores x/y so the window stays
  // where the user dragged it.
  const w = Math.max(300, windowConfig.width  || 1000);
  const h = Math.max(200, windowConfig.height || 650);
  for (const world of worlds.values()) {
    if (world.win.isDestroyed()) continue;
    try { world.win.setSize(w, h); } catch {}
  }
}

function pushBrowserTheme(pane) {
  if (!pane || !pane.chromeView || pane.chromeView.webContents.isDestroyed()) return;
  try { pane.chromeView.webContents.send('chrome-theme', browserConfig); } catch {}
}

function pushRuntimeConfig(world) {
  if (!world || !world.rendererReady || world.win.isDestroyed()) return;
  const effectiveFontSize = Math.max(6, Math.min(72, termConfig.fontSize + (world.zoomDelta || 0)));
  world.termView.webContents.send('config-update', {
    terminal: { ...termConfig, fontSize: effectiveFontSize },
    panes: paneConfig,
    workspaces: workspaceConfig,
    bindings,
    barHeight: currentBarHeight(world),
  });
}

const CONFIG_REFERENCE = {
  chord_syntax: 'Modifier+Modifier+Key. Modifiers: Cmd, Alt (aka Option), Shift, Ctrl. Key: single char (a-z, 0-9, =, -) or named (Enter, Escape, Tab, Space, Backspace, Delete, Home, End, PageUp, PageDown, ArrowLeft, ArrowRight, ArrowUp, ArrowDown, F1..F12). Case-insensitive. Each action is a list of chords; any chord matches.',
  actions: {
    newTerminal:    'Split the focused pane with a new shell.',
    closePane:      'Close the focused pane (no-op on the last pane in a workspace).',
    splitRight:     'Explicit horizontal split (new pane to the right).',
    splitDown:      'Explicit vertical split (new pane below).',
    navLeft:        'Move focus to the adjacent pane on the left.',
    navDown:        'Move focus to the adjacent pane below.',
    navUp:          'Move focus to the adjacent pane above.',
    navRight:       'Move focus to the adjacent pane on the right.',
    swapLeft:       'Swap the focused pane with the spatial neighbor to the left.',
    swapDown:       'Swap the focused pane with the spatial neighbor below.',
    swapUp:         'Swap the focused pane with the spatial neighbor above.',
    swapRight:      'Swap the focused pane with the spatial neighbor to the right.',
    equalize:       'Reset all splits in the active workspace to 50/50.',
    newWorkspace:   'Create a new workspace with a fresh terminal.',
    closeWorkspace: 'Close the active workspace; closes the window if it was the last.',
    nextWorkspace:  'Switch to the next workspace.',
    prevWorkspace:  'Switch to the previous workspace.',
    newWindow:      'Open another Electron window.',
    closeWindow:    'Close the current Electron window.',
    zoomIn:         'Increase font size in a terminal pane, or page zoom in a browser pane.',
    zoomOut:        'Decrease font size / browser zoom.',
    zoomReset:      'Reset font size / browser zoom to 1.',
    engage:         'Give keyboard focus to a browser pane (type into the page).',
    disengage:      'Return focus from a browser pane; a second press converts it back to a terminal.',
  },
};

// Regenerate the read-only defaults file on every launch. Users can diff
// this against their config.json or copy lines from it to override.
function writeDefaultsFile() {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    const content = {
      _comment: 'ophanim defaults — regenerated every launch, do not edit. Copy lines from here into config.json to override.',
      _reference: CONFIG_REFERENCE,
      keybindings: DEFAULT_BINDINGS,
      terminal: DEFAULT_TERMINAL,
      window: DEFAULT_WINDOW,
      panes: DEFAULT_PANES,
      workspaces: DEFAULT_WORKSPACES,
      browser: DEFAULT_BROWSER,
    };
    fs.writeFileSync(DEFAULTS_PATH, JSON.stringify(content, null, 2));
  } catch (e) { console.warn('[ophanim] writeDefaultsFile:', e.message); }
}

// User's config.json — seeded as a minimal stub. Anything not overridden
// falls back to the values in defaults.json / DEFAULT_* constants.
function ensureConfigFile() {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    if (!fs.existsSync(CONFIG_PATH)) {
      const seed = {
        _comment: 'Your overrides. Anything missing falls back to defaults.json (same dir). Reload on save.',
        keybindings: {},
      };
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(seed, null, 2));
    }
  } catch (e) { console.warn('[ophanim] ensureConfigFile:', e.message); }
}

function watchConfig() {
  try {
    fs.watchFile(CONFIG_PATH, { interval: 400, persistent: false }, (curr, prev) => {
      if (curr.mtimeMs !== prev.mtimeMs || curr.size !== prev.size) loadConfigFromDisk();
    });
  } catch (e) { console.warn('[ophanim] watchConfig:', e.message); }
}

// ---------- state ----------
//
// World = one Electron BrowserWindow.
//   { win, termView, workspaces, activeIdx, rendererReady, zoomDelta, pollId }
// Workspace = a tmux-style "window" — named split tree of panes.
//   { id, name, root, focusedPaneId, panes: Map<paneId, Pane> }
// Pane = { id, kind: 'term'|'browser', ... }
const worlds = new Map();

let nextPaneSeq = 1;
let nextWsSeq = 1;
const newPaneId = () => `p${nextPaneSeq++}`;
const newWsId   = () => `w${nextWsSeq++}`;

// tmux session names are opaque IDs, NOT derived from paneId. paneIds reset
// to p1 every launch, but the tmux server is long-lived — deriving session
// names from paneIds would make fresh panes collide with orphan sessions
// from a crashed/discarded prior run, leaking stale scrollback into what
// the user thinks is a clean shell. `BOOT_ID` namespaces this process's
// session names; restored panes carry forward the saved name verbatim.
const BOOT_ID = Date.now().toString(36);
let nextTmuxSeq = 1;
const mintTmuxSessionName = () => `term-${BOOT_ID}-${nextTmuxSeq++}`;

const activeWs = (world) => world.workspaces[world.activeIdx];

function findPaneGlobal(paneId) {
  for (const world of worlds.values()) {
    for (const ws of world.workspaces) {
      const p = ws.panes.get(paneId);
      if (p) return { world, ws, pane: p };
    }
  }
  return null;
}

// Shell integration — inject bin/ into the spawned shell's PATH, then
// re-source it through a wrapper so macOS path_helper doesn't clobber it
// on login shells. Pattern matches VS Code / Ghostty / WezTerm / kitty:
// per-shell wrapper file, user's real rc is sourced first, env vars
// point the shell at our wrapper. Shells we don't recognize still get
// the PATH prepend — just no reinstatement if something later wipes it.
function shellIntegration(shellPath) {
  const base = path.basename(shellPath || '').toLowerCase();
  const BASH_RC  = path.join(UNPACKED_DIR, 'shell', 'bash', 'rc');
  const FISH_RC  = path.join(UNPACKED_DIR, 'shell', 'fish', 'init.fish');
  const ZSH_DIR  = path.join(UNPACKED_DIR, 'shell', 'zsh');
  if (base === 'zsh')  return { args: [],                                            env: { ZDOTDIR: ZSH_DIR } };
  if (base === 'bash') return { args: ['--rcfile', BASH_RC],                         env: { BASH_ENV: BASH_RC } };
  if (base === 'fish') return { args: ['--init-command', `source '${FISH_RC}'`],     env: {} };
  return { args: [], env: {} };
}

function ptyEnv(shellSpecific = {}) {
  return {
    ...process.env,
    TERM: 'xterm-256color',
    PATH: `${BIN_DIR}:${process.env.PATH || ''}`,
    OPHANIM_BIN: BIN_DIR,
    OPHANIM_SHELL_INTEGRATION: '1',
    ...shellSpecific,
  };
}

function resolveShell() {
  if (termConfig.shell) return termConfig.shell;
  if (process.env.SHELL) return process.env.SHELL;
  // Finder-launched apps on macOS don't inherit $SHELL. Probe common paths.
  for (const s of ['/bin/zsh', '/bin/bash', '/bin/sh']) {
    try { if (fs.existsSync(s)) return s; } catch {}
  }
  return '/bin/sh';
}

function spawnPty(world, paneId, tmuxSession, cols = 100, rows = 30) {
  const backend = initTmuxBackend();
  if (backend.available()) return spawnPtyViaTmux(world, paneId, tmuxSession, cols, rows);
  return spawnPtyDirect(world, paneId, cols, rows);
}

function wirePtyEvents(world, paneId, p) {
  p.onData((data) => {
    if (!world.win.isDestroyed() && !world.termView.webContents.isDestroyed()) {
      world.termView.webContents.send('pty-data', { paneId, data });
    }
  });
  p.onExit(() => {
    if (!worlds.has(world.win.id)) return;
    const found = findPaneGlobal(paneId);
    if (!found || found.pane.kind !== 'term' || found.pane.pty !== p) return;
    closePane(world, paneId);
  });
}

function spawnPtyDirect(world, paneId, cols, rows) {
  const shell = resolveShell();
  const integ = shellIntegration(shell);
  const p = pty.spawn(shell, integ.args, {
    name: 'xterm-256color',
    cols, rows,
    cwd: os.homedir(),
    env: ptyEnv(integ.env),
  });
  wirePtyEvents(world, paneId, p);
  return p;
}

// Build a single shell-command string for `tmux new-session` (args are
// joined into one command by tmux and run via /bin/sh -c).
function shQuote(s) { return `'${String(s).replace(/'/g, "'\\''")}'`; }
function buildTmuxShellCommand() {
  const shell = resolveShell();
  const integ = shellIntegration(shell);
  if (!integ.args.length) return shQuote(shell);
  return [shell, ...integ.args].map(shQuote).join(' ');
}

function spawnPtyViaTmux(world, paneId, tmuxSession, cols, rows) {
  const backend = tmuxBackend;
  const shell = resolveShell();
  const integ = shellIntegration(shell);
  const env = ptyEnv(integ.env);
  // `tmuxSession` is the opaque durable identifier. For new panes the
  // caller mints a fresh name via `mintTmuxSessionName()` so it can't
  // collide with a surviving session from a prior process. For restored
  // panes the caller passes the saved name verbatim so we reattach to
  // the same shell. `hasSession` distinguishes the two cases here.
  if (!backend.hasSession(tmuxSession)) {
    const cmd = buildTmuxShellCommand();
    try {
      backend.createSession(tmuxSession, {
        cwd: env.HOME || os.homedir(),
        env,
        // createSession appends this after session flags; tmux joins
        // everything after `-s <name>` as the command line.
        shellCommand: cmd,
      });
    } catch (e) {
      console.warn('[ophanim] tmux createSession failed, falling back:', e.message);
      return spawnPtyDirect(world, paneId, cols, rows);
    }
  }
  let p;
  try {
    p = backend.attach(tmuxSession, { cols, rows, env });
  } catch (e) {
    console.warn('[ophanim] tmux attach failed, falling back:', e.message);
    return spawnPtyDirect(world, paneId, cols, rows);
  }
  wirePtyEvents(world, paneId, p);
  return p;
}

function normalizeUrl(raw) {
  const s = String(raw || '').trim();
  if (!s) return 'about:blank';
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return s;
  if (s.includes(' ') || !s.includes('.')) {
    return 'https://www.google.com/search?q=' + encodeURIComponent(s);
  }
  return 'https://' + s;
}

// ---------- history + google suggest ----------

let HISTORY_PATH = null;
let historyData = { entries: {} };
let historyDirty = false;
let historyWriteTimer = null;

function loadHistory() {
  HISTORY_PATH = path.join(app.getPath('userData'), 'history.json');
  try {
    const raw = fs.readFileSync(HISTORY_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && parsed.entries) historyData = parsed;
  } catch {}
}

function persistHistory() {
  if (!HISTORY_PATH || historyWriteTimer) return;
  historyWriteTimer = setTimeout(() => {
    historyWriteTimer = null;
    if (!historyDirty) return;
    historyDirty = false;
    try { fs.writeFileSync(HISTORY_PATH, JSON.stringify(historyData)); } catch {}
  }, 500);
}

function recordVisit(url, title) {
  if (!url || !/^https?:/i.test(url)) return;
  const entry = historyData.entries[url] || { title: '', count: 0, lastVisited: 0 };
  if (title) entry.title = title;
  entry.count += 1;
  entry.lastVisited = Date.now();
  historyData.entries[url] = entry;
  historyDirty = true;
  persistHistory();
}

function suggestHistory(query, limit = 5) {
  const now = Date.now();
  const all = Object.entries(historyData.entries);
  if (!query) {
    all.sort((a, b) => b[1].lastVisited - a[1].lastVisited);
    return all.slice(0, limit).map(([url, e]) => ({ url, title: e.title, count: e.count }));
  }
  const q = query.toLowerCase();
  const candidates = [];
  for (const [url, e] of all) {
    const u = url.toLowerCase();
    const uNoScheme = u.replace(/^https?:\/\/(www\.)?/, '');
    const t = (e.title || '').toLowerCase();
    let score = 0;
    if (uNoScheme.startsWith(q)) score += 100;
    else if (u.includes(q)) score += 30;
    if (t.startsWith(q)) score += 50;
    else if (t.includes(q)) score += 15;
    if (score === 0) continue;
    const daysAgo = Math.max(0.1, (now - e.lastVisited) / (1000 * 60 * 60 * 24));
    score += e.count / (1 + daysAgo / 7);
    candidates.push({ url, title: e.title, count: e.count, score });
  }
  candidates.sort((a, b) => b.score - a.score);
  return candidates.slice(0, limit).map(({ url, title, count }) => ({ url, title, count }));
}

const suggestCache = new Map();
const SUGGEST_TTL = 45 * 1000;

async function suggestGoogle(query) {
  const q = String(query || '').trim();
  if (!q) return [];
  const cached = suggestCache.get(q);
  if (cached && Date.now() - cached.ts < SUGGEST_TTL) return cached.results;
  const url = `https://suggestqueries.google.com/complete/search?client=firefox&q=${encodeURIComponent(q)}`;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    const res = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json' } });
    clearTimeout(timer);
    if (!res.ok) return [];
    const data = await res.json();
    const list = (Array.isArray(data) && Array.isArray(data[1]) ? data[1] : []).slice(0, 6);
    suggestCache.set(q, { ts: Date.now(), results: list });
    if (suggestCache.size > 200) {
      const oldest = [...suggestCache.entries()].sort((a, b) => a[1].ts - b[1].ts)[0];
      if (oldest) suggestCache.delete(oldest[0]);
    }
    return list;
  } catch { return []; }
}

async function combinedSuggest(query) {
  const urlLike = /\./.test(query) && !/\s/.test(query);
  const [history, searches] = await Promise.all([
    Promise.resolve(suggestHistory(query, urlLike ? 5 : 3)),
    query && !urlLike ? suggestGoogle(query) : Promise.resolve([]),
  ]);
  const out = [];
  for (const h of history) out.push({ type: 'url', url: h.url, title: h.title });
  const seen = new Set(out.map((o) => (o.title || '').toLowerCase()));
  for (const q of searches) {
    if (q && !seen.has(q.toLowerCase())) out.push({ type: 'query', query: q });
    if (out.length >= 8) break;
  }
  return out;
}

// ---------- tree + layout ----------

function contentRect(world) {
  const wb = world.win.getContentBounds();
  return { x: 0, y: 0, w: wb.width, h: Math.max(0, wb.height - currentBarHeight(world)) };
}

function layoutNode(node, rect, out) {
  if (node.kind === 'leaf') { out[node.paneId] = rect; return; }
  if (node.dir === 'h') {
    const wA = Math.max(1, Math.floor(rect.w * node.ratio));
    layoutNode(node.a, { x: rect.x, y: rect.y, w: wA, h: rect.h }, out);
    layoutNode(node.b, { x: rect.x + wA, y: rect.y, w: rect.w - wA, h: rect.h }, out);
  } else {
    const hA = Math.max(1, Math.floor(rect.h * node.ratio));
    layoutNode(node.a, { x: rect.x, y: rect.y, w: rect.w, h: hA }, out);
    layoutNode(node.b, { x: rect.x, y: rect.y + hA, w: rect.w, h: rect.h - hA }, out);
  }
}

function layoutWorld(world) {
  if (world.win.isDestroyed()) return;
  const ws = activeWs(world);
  if (!ws) return;
  const rect = contentRect(world);
  const rects = {};
  layoutNode(ws.root, rect, rects);
  for (const [paneId, r] of Object.entries(rects)) {
    const pane = ws.panes.get(paneId);
    if (!pane) continue;
    pane.rect = r;
    if (pane.kind === 'browser') {
      const ix = r.x + 1, iy = r.y + 1;
      const iw = Math.max(0, r.w - 2), ih = Math.max(0, r.h - 2);
      const zf = pane.zoomFactor || 1;
      const barH = Math.min(Math.round(CHROME_BAR_HEIGHT * zf), ih);
      try { pane.chromeView.setBounds({ x: ix, y: iy, width: iw, height: barH }); } catch {}
      try { pane.view.setBounds({ x: ix, y: iy + barH, width: iw, height: Math.max(0, ih - barH) }); } catch {}
      try { pane.view.setVisible(true); } catch {}
      try { pane.chromeView.setVisible(true); } catch {}
    } else if (pane.kind === 'config') {
      const ix = r.x + 1, iy = r.y + 1;
      const iw = Math.max(0, r.w - 2), ih = Math.max(0, r.h - 2);
      try { pane.view.setBounds({ x: ix, y: iy, width: iw, height: ih }); } catch {}
      try { pane.view.setVisible(true); } catch {}
    }
  }
  // Hide WebContentsView panes of inactive workspaces.
  for (const otherWs of world.workspaces) {
    if (otherWs === ws) continue;
    for (const p of otherWs.panes.values()) {
      if (p.kind === 'browser') {
        try { p.view.setVisible(false); } catch {}
        try { p.chromeView.setVisible(false); } catch {}
      } else if (p.kind === 'config') {
        try { p.view.setVisible(false); } catch {}
      }
    }
  }
  if (world.rendererReady) {
    world.termView.webContents.send('layout', { rectsByPaneId: rects });
    // Tell renderer which terminal panes to show/hide.
    const visiblePaneIds = Object.keys(rects);
    const hiddenPaneIds = [];
    for (const otherWs of world.workspaces) {
      if (otherWs === ws) continue;
      for (const p of otherWs.panes.values()) hiddenPaneIds.push(p.id);
    }
    world.termView.webContents.send('pane-visibility', { visible: visiblePaneIds, hidden: hiddenPaneIds });
  }
}

function findLeafParent(node, paneId, parent = null) {
  if (node.kind === 'leaf') return node.paneId === paneId ? { leaf: node, parent } : null;
  return findLeafParent(node.a, paneId, node) || findLeafParent(node.b, paneId, node);
}

function addTermPane(world, ws, paneId, tmuxSession) {
  // tmuxSession is the durable name. Fresh new panes get a minted unique
  // name; restore passes the snapshot's saved name so we reattach to the
  // exact surviving shell.
  const sess = tmuxSession || mintTmuxSessionName();
  const pane = {
    id: paneId, kind: 'term', pty: null, tmuxSession: sess,
    rect: { x: 0, y: 0, w: 1, h: 1 },
  };
  ws.panes.set(paneId, pane);
  if (world.rendererReady) {
    world.termView.webContents.send('pane-add', { paneId, kind: 'term' });
  }
  pane.pty = spawnPty(world, paneId, sess);
  return pane;
}

function destroyPaneResources(world, pane) {
  if (pane.kind === 'term') {
    // Kill the attach client (our local pty.spawn of `tmux attach`),
    // THEN kill the tmux session itself so the shell and its children
    // actually go away. Without the killSession call the shell would
    // keep running orphaned in the tmux server forever.
    try { pane.pty && pane.pty.kill(); } catch {}
    if (tmuxBackend && tmuxBackend.available() && pane.tmuxSession) {
      try { tmuxBackend.killSession(pane.tmuxSession); } catch {}
    }
  } else if (pane.kind === 'browser') {
    try { world.win.contentView.removeChildView(pane.chromeView); } catch {}
    try { pane.chromeView.webContents.close(); } catch {}
    try { world.win.contentView.removeChildView(pane.view); } catch {}
    try { pane.view.webContents.close(); } catch {}
    const n = pane.pid ? Number(pane.pid) : NaN;
    if (Number.isFinite(n) && n > 0) { try { process.kill(n, 'SIGTERM'); } catch {} }
  } else if (pane.kind === 'config') {
    try { world.win.contentView.removeChildView(pane.view); } catch {}
    try { pane.view.webContents.close(); } catch {}
  }
  if (world.rendererReady) {
    world.termView.webContents.send('pane-remove', { paneId: pane.id });
  }
}

function smartDirection(rect) {
  return rect.w / Math.max(1, rect.h) >= 1 ? 'h' : 'v';
}

function split(world, paneId, dir) {
  const ws = activeWs(world);
  if (!ws) return;
  const found = findLeafParent(ws.root, paneId);
  if (!found) return;
  const { leaf, parent } = found;
  const newId = newPaneId();
  addTermPane(world, ws, newId);
  const splitNode = { kind: 'split', dir, ratio: 0.5, a: leaf, b: { kind: 'leaf', paneId: newId } };
  if (!parent) ws.root = splitNode;
  else if (parent.a === leaf) parent.a = splitNode;
  else parent.b = splitNode;
  ws.focusedPaneId = newId;
  layoutWorld(world);
  pushFocus(world);
  markSessionDirty();
}

function closePane(world, paneId) {
  const ws = activeWs(world);
  if (!ws || !ws.panes.has(paneId)) return;
  if (ws.root.kind === 'leaf' && ws.root.paneId === paneId) return;
  const pane = ws.panes.get(paneId);
  ws.panes.delete(paneId);
  destroyPaneResources(world, pane);
  const unlink = (node, pp = null) => {
    if (node.kind === 'leaf') return false;
    if (node.a.kind === 'leaf' && node.a.paneId === paneId) {
      replaceNode(pp, node, node.b, ws); return true;
    }
    if (node.b.kind === 'leaf' && node.b.paneId === paneId) {
      replaceNode(pp, node, node.a, ws); return true;
    }
    return unlink(node.a, node) || unlink(node.b, node);
  };
  unlink(ws.root);
  const anyLeaf = firstLeaf(ws.root);
  if (anyLeaf) ws.focusedPaneId = anyLeaf.paneId;
  layoutWorld(world);
  pushFocus(world);
  markSessionDirty();
}

function replaceNode(parent, oldNode, newNode, ws) {
  if (!parent) ws.root = newNode;
  else if (parent.a === oldNode) parent.a = newNode;
  else if (parent.b === oldNode) parent.b = newNode;
}

function firstLeaf(node) {
  if (!node) return null;
  if (node.kind === 'leaf') return node;
  return firstLeaf(node.a) || firstLeaf(node.b);
}

function allLeaves(node, out = []) {
  if (!node) return out;
  if (node.kind === 'leaf') { out.push(node); return out; }
  allLeaves(node.a, out); allLeaves(node.b, out);
  return out;
}

function findNeighbor(ws, paneId, dir) {
  const cur = ws.panes.get(paneId);
  if (!cur) return null;
  const leaves = allLeaves(ws.root).map((l) => ws.panes.get(l.paneId)).filter(Boolean);
  const cr = cur.rect;
  const cmid = { x: cr.x + cr.w / 2, y: cr.y + cr.h / 2 };
  let best = null, bestScore = Infinity;
  for (const p of leaves) {
    if (p.id === cur.id) continue;
    const r = p.rect;
    const pmid = { x: r.x + r.w / 2, y: r.y + r.h / 2 };
    let ok = false, dist = 0;
    if (dir === 'left')  { ok = r.x + r.w <= cr.x + 1;  dist = cr.x - (r.x + r.w); }
    if (dir === 'right') { ok = r.x >= cr.x + cr.w - 1; dist = r.x - (cr.x + cr.w); }
    if (dir === 'up')    { ok = r.y + r.h <= cr.y + 1;  dist = cr.y - (r.y + r.h); }
    if (dir === 'down')  { ok = r.y >= cr.y + cr.h - 1; dist = r.y - (cr.y + cr.h); }
    if (!ok) continue;
    const perp = (dir === 'left' || dir === 'right')
      ? Math.abs(pmid.y - cmid.y) : Math.abs(pmid.x - cmid.x);
    const score = dist + perp;
    if (score < bestScore) { bestScore = score; best = p; }
  }
  return best ? best.id : null;
}

function gotoDir(world, dir) {
  const ws = activeWs(world);
  if (!ws) return;
  const neighborId = findNeighbor(ws, ws.focusedPaneId, dir);
  if (neighborId) { ws.focusedPaneId = neighborId; pushFocus(world); markSessionDirty(); }
}

function swapDir(world, dir) {
  const ws = activeWs(world);
  if (!ws) return;
  const focused = ws.focusedPaneId;
  const neighborId = findNeighbor(ws, focused, dir);
  if (!neighborId) return;
  swapLeaves(ws, focused, neighborId);
  // Focus stays with the pane that moved (now in the neighbor's old slot).
  layoutWorld(world);
  pushFocus(world);
  markSessionDirty();
}

function swapLeaves(ws, a, b) {
  if (!a || !b || a === b) return;
  const la = findLeafParent(ws.root, a);
  const lb = findLeafParent(ws.root, b);
  if (!la || !lb) return;
  la.leaf.paneId = b;
  lb.leaf.paneId = a;
}

function pushFocus(world) {
  if (!world.rendererReady || world.win.isDestroyed()) return;
  const ws = activeWs(world);
  if (!ws) return;
  world.termView.webContents.send('focus', { paneId: ws.focusedPaneId });
  const pane = ws.panes.get(ws.focusedPaneId);
  if (pane && pane.kind === 'config') {
    try { pane.view.webContents.focus(); } catch {}
  } else if (pane && pane.kind === 'browser' && pane.engaged) {
    try { pane.view.webContents.focus(); } catch {}
  } else {
    try { world.termView.webContents.focus(); } catch {}
  }
}

function equalize(node) {
  if (!node || node.kind === 'leaf') return;
  node.ratio = 0.5;
  equalize(node.a); equalize(node.b);
}

function updateBrowserBorder(pane) {
  try {
    pane.chromeView.setBackgroundColor(
      pane.engaged ? browserConfig.engagedBorderColor : browserConfig.disengagedBorderColor
    );
  } catch {}
}

function applyZoom(world, step) {
  const ws = activeWs(world);
  if (!ws) return;
  const pane = ws.panes.get(ws.focusedPaneId);
  if (pane && pane.kind === 'browser') {
    try {
      let next;
      if (step === 0) next = 1;
      else {
        const cur = pane.view.webContents.getZoomFactor();
        next = Math.max(0.25, Math.min(5, cur + step * 0.1));
      }
      pane.view.webContents.setZoomFactor(next);
      // Scale the navbar too — its content (URL input, buttons) would
      // otherwise look tiny next to a zoomed page. Use CSS `zoom` via IPC
      // rather than setZoomFactor: Chromium's HostZoomMap persists zoom
      // per-origin at the session level, and every chromeView loads from
      // file://, so setZoomFactor would leak across all browser panes.
      try { pane.chromeView.webContents.send('chrome-zoom', next); } catch {}
      pane.zoomFactor = next;
      layoutWorld(world);
    } catch {}
    return;
  }
  if (step === 0) world.zoomDelta = 0;
  else world.zoomDelta = (world.zoomDelta || 0) + step;
  pushRuntimeConfig(world);
  // Bar height is derived from zoom; re-layout so panes shrink/grow to
  // leave the right room above the bar.
  layoutWorld(world);
  markSessionDirty();
}

// ---------- workspaces ----------

function pushWorkspaces(world) {
  if (!world.rendererReady || world.win.isDestroyed()) return;
  world.termView.webContents.send('workspaces', {
    list: world.workspaces.map((w) => ({ id: w.id, name: w.name })),
    activeIdx: world.activeIdx,
  });
}

function newWorkspace(world, name) {
  const ws = {
    id: newWsId(),
    name: name || `ws${world.workspaces.length + 1}`,
    root: null,
    focusedPaneId: null,
    panes: new Map(),
  };
  const paneId = newPaneId();
  ws.root = { kind: 'leaf', paneId };
  ws.focusedPaneId = paneId;
  world.workspaces.push(ws);
  addTermPane(world, ws, paneId);
  activateWorkspace(world, world.workspaces.length - 1);
  markSessionDirty();
}

function closeWorkspace(world, idx) {
  const ws = world.workspaces[idx];
  if (!ws) return;
  for (const p of ws.panes.values()) destroyPaneResources(world, p);
  world.workspaces.splice(idx, 1);
  if (world.workspaces.length === 0) {
    if (!world.win.isDestroyed()) world.win.close();
    return;
  }
  const newActive = Math.min(idx, world.workspaces.length - 1);
  activateWorkspace(world, newActive);
  markSessionDirty();
}

function activateWorkspace(world, idx) {
  if (idx < 0 || idx >= world.workspaces.length) return;
  world.activeIdx = idx;
  layoutWorld(world);
  pushFocus(world);
  pushWorkspaces(world);
  markSessionDirty();
}

function cycleWorkspace(world, dir) {
  if (world.workspaces.length <= 1) return;
  const n = world.workspaces.length;
  let idx = world.activeIdx + dir;
  if (workspaceConfig.wrap) {
    idx = (idx + n) % n;
  } else {
    if (idx < 0 || idx >= n) return;
  }
  activateWorkspace(world, idx);
}

// ---------- browser pane conversion ----------

function convertToBrowser(world, paneId, url, pid, opts) {
  // Locate the pane by its paneId across ALL workspaces in this world, not
  // just the active one. During session restore we walk workspaces in order
  // while activeIdx is still 0, so the pane we're converting is often in a
  // non-active workspace — using activeWs here silently no-op'd the restore
  // for ws2+ browser panes.
  let ws = null, pane = null;
  for (const candidateWs of world.workspaces) {
    const cp = candidateWs.panes.get(paneId);
    if (cp) { ws = candidateWs; pane = cp; break; }
  }
  if (!ws || !pane || pane.kind !== 'term') return;
  const target = normalizeUrl(url);
  const restoreEntries = opts && Array.isArray(opts.restoreEntries) ? opts.restoreEntries : null;
  const restoreIndex   = opts && typeof opts.restoreIndex === 'number' ? opts.restoreIndex : -1;
  const restoreZoom    = opts && typeof opts.zoomFactor  === 'number' ? opts.zoomFactor : null;
  const restoreEngaged = opts && opts.engaged;
  // Kill the attach-client PTY AND the underlying tmux session. There's
  // no convert-back UI, so keeping the session around just accumulates
  // orphans with stale scrollback ("[1] terminated browse <url>") that
  // collide with future ophanim launches.
  try { pane.pty && pane.pty.kill(); } catch {}
  if (tmuxBackend && tmuxBackend.available() && pane.tmuxSession) {
    try { tmuxBackend.killSession(pane.tmuxSession); } catch {}
  }
  if (world.rendererReady) {
    world.termView.webContents.send('pane-change-kind', { paneId, kind: 'browser' });
  }
  ws.panes.delete(paneId);

  const view = new WebContentsView({
    webPreferences: {
      // Host-gated preload: the script runs on every pane but only patches
      // navigator on an allowlist of sites that actively refuse non-Chrome
      // browsers (Google sign-in). On all other hosts it returns immediately
      // — Kasada (KPSDK) detects navigator patches themselves as a
      // stealth-tool signature and blocks harder, so we have to look like
      // a plain Chromium to them.
      sandbox: false, contextIsolation: false, nodeIntegration: false,
      preload: BROWSER_PRELOAD,
    },
  });
  const chromeView = new WebContentsView({
    webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false },
  });
  chromeView.setBackgroundColor(browserConfig.disengagedBorderColor);
  chromeView.webContents.loadFile(CHROME_HTML);

  const bp = {
    id: paneId, kind: 'browser',
    view, chromeView,
    rect: pane.rect, engaged: false,
    pid: String(pid || ''),
  };
  ws.panes.set(paneId, bp);

  const pushNavState = () => {
    if (chromeView.webContents.isDestroyed()) return;
    chromeView.webContents.send('nav-state', {
      url: view.webContents.getURL() || '',
      canGoBack: view.webContents.canGoBack(),
      canGoForward: view.webContents.canGoForward(),
    });
  };
  bp.pushNavState = pushNavState;

  const onStateChange = () => {
    pushNavState();
    try { recordVisit(view.webContents.getURL(), view.webContents.getTitle()); } catch {}
    markSessionDirty();
  };
  view.webContents.on('did-navigate', onStateChange);
  view.webContents.on('did-navigate-in-page', onStateChange);
  view.webContents.on('did-finish-load', onStateChange);
  view.webContents.on('page-title-updated', onStateChange);

  const pushLoading = (loading) => {
    if (chromeView.webContents.isDestroyed()) return;
    try { chromeView.webContents.send('loading-state', { loading }); } catch {}
  };
  bp.pushLoading = pushLoading;
  view.webContents.on('did-start-loading', () => pushLoading(true));
  view.webContents.on('did-stop-loading', () => pushLoading(false));

  const onInput = (event, input) => {
    if (handleBrowserPaneInput(world, bp, event, input)) event.preventDefault();
  };
  view.webContents.on('before-input-event', onInput);
  chromeView.webContents.on('before-input-event', onInput);

  // Allow window.open popups (Google OAuth uses them). Open as a real
  // BrowserWindow with the same stealth preload so the sign-in flow
  // sees matching navigator.userAgentData, sec-ch-ua, etc.
  view.webContents.setWindowOpenHandler((details) => {
    console.log('[popup]', JSON.stringify({ url: details.url, disposition: details.disposition, features: details.features }));
    return {
      action: 'allow',
      overrideBrowserWindowOptions: {
        width: 520, height: 680,
        backgroundColor: '#ffffff',
        webPreferences: {
          sandbox: false, contextIsolation: false, nodeIntegration: false,
          preload: BROWSER_PRELOAD,
        },
      },
    };
  });
  view.webContents.on('did-create-window', (win, { url }) => {
    console.log('[popup] did-create-window', url);
  });
  // Auto-accept common permission requests (microphone, clipboard, etc.).
  // Google sign-in can gate on these silently.
  view.webContents.session.setPermissionRequestHandler((wc, perm, cb) => {
    console.log('[permission]', perm);
    cb(true);
  });
  // Log failed loads so we notice blocked subresources.
  view.webContents.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    if (code === -3) return; // aborted (common, benign)
    console.log('[load-fail]', code, desc, url, 'main=' + isMainFrame);
  });

  world.win.contentView.addChildView(view);
  world.win.contentView.addChildView(chromeView);
  layoutWorld(world);

  // Restore path: rebuild the back/forward stack (including pageState —
  // scroll position and form fields) from snapshot. Skip the plain
  // loadURL in that case; navigationHistory.restore() handles it.
  if (restoreEntries && restoreEntries.length > 0) {
    try {
      const nh = view.webContents.navigationHistory;
      if (nh && typeof nh.restore === 'function') {
        Promise.resolve(nh.restore({
          entries: restoreEntries,
          index: restoreIndex >= 0 ? restoreIndex : restoreEntries.length - 1,
        })).catch((e) => {
          console.warn('[ophanim] navigationHistory.restore failed:', e.message);
          // Fall back to a plain loadURL on the last saved URL.
          const last = restoreEntries[restoreEntries.length - 1];
          if (last && last.url) view.webContents.loadURL(last.url);
        });
      } else {
        const last = restoreEntries[restoreEntries.length - 1];
        view.webContents.loadURL(last.url || target);
      }
    } catch (e) {
      console.warn('[ophanim] restore entries exception:', e.message);
      view.webContents.loadURL(target);
    }
  } else {
    view.webContents.loadURL(target);
  }

  if (restoreZoom && restoreZoom !== 1) {
    bp.zoomFactor = restoreZoom;
    try { view.webContents.setZoomFactor(restoreZoom); } catch {}
    try { chromeView.webContents.send('chrome-zoom', restoreZoom); } catch {}
  }
  if (restoreEngaged) {
    bp.engaged = true;
    updateBrowserBorder(bp);
    // Don't transfer keyboard focus on restore — focus belongs to whoever
    // the snapshot said was focused in the workspace, set by pushFocus.
  }
  markSessionDirty();
}

function convertToTerminal(world, paneId) {
  let ws = null, pane = null;
  for (const candidateWs of world.workspaces) {
    const cp = candidateWs.panes.get(paneId);
    if (cp) { ws = candidateWs; pane = cp; break; }
  }
  if (!ws || !pane || (pane.kind !== 'browser' && pane.kind !== 'config')) return;
  try { world.termView.webContents.focus(); } catch {}
  if (pane.chromeView) {
    try { world.win.contentView.removeChildView(pane.chromeView); } catch {}
  }
  try { world.win.contentView.removeChildView(pane.view); } catch {}
  // process.kill(0) targets the whole process group (kills tdub itself).
  // Require a positive integer pid.
  const n = pane.pid ? Number(pane.pid) : NaN;
  if (Number.isFinite(n) && n > 0) { try { process.kill(n, 'SIGTERM'); } catch {} }

  const sess = mintTmuxSessionName();
  const termPane = { id: paneId, kind: 'term', pty: null, tmuxSession: sess, rect: pane.rect };
  ws.panes.set(paneId, termPane);
  if (world.rendererReady) {
    world.termView.webContents.send('pane-change-kind', { paneId, kind: 'term' });
  }
  termPane.pty = spawnPty(world, paneId, sess);
  layoutWorld(world);
  pushFocus(world);
  markSessionDirty();
}

function handleBrowserPaneInput(world, pane, event, input) {
  const action = actionFor(input);
  if (!action) return false;
  if (action === 'navRight' && pane.engaged && input.meta && !input.alt) {
    try { pane.chromeView.webContents.focus(); } catch {}
    try { pane.chromeView.webContents.send('focus-url'); } catch {}
    return true;
  }
  return dispatchAction(world, action);
}

// ---------- keybinding dispatch ----------

function dispatchAction(world, action) {
  const ws = activeWs(world);
  switch (action) {
    case 'newTerminal': {
      if (!ws) return true;
      const p = ws.panes.get(ws.focusedPaneId);
      if (p) split(world, p.id, smartDirection(p.rect));
      return true;
    }
    case 'closePane':   if (ws) closePane(world, ws.focusedPaneId); return true;
    case 'newWorkspace':   newWorkspace(world); return true;
    case 'closeWorkspace': closeWorkspace(world, world.activeIdx); return true;
    case 'nextWorkspace':  cycleWorkspace(world, +1); return true;
    case 'prevWorkspace':  cycleWorkspace(world, -1); return true;
    case 'closeWindow':    if (!world.win.isDestroyed()) world.win.close(); return true;
    case 'newWindow':      newWindow(); return true;
    case 'splitRight':     if (ws) split(world, ws.focusedPaneId, 'h'); return true;
    case 'splitDown':      if (ws) split(world, ws.focusedPaneId, 'v'); return true;
    case 'navLeft':        gotoDir(world, 'left'); return true;
    case 'navDown':        gotoDir(world, 'down'); return true;
    case 'navUp':          gotoDir(world, 'up'); return true;
    case 'navRight':       gotoDir(world, 'right'); return true;
    case 'swapLeft':       swapDir(world, 'left'); return true;
    case 'swapDown':       swapDir(world, 'down'); return true;
    case 'swapUp':         swapDir(world, 'up'); return true;
    case 'swapRight':      swapDir(world, 'right'); return true;
    case 'equalize':       if (ws) { equalize(ws.root); layoutWorld(world); } return true;
    case 'zoomIn':         applyZoom(world, +1); return true;
    case 'zoomOut':        applyZoom(world, -1); return true;
    case 'zoomReset':      applyZoom(world, 0); return true;
    case 'devtools': {
      if (!ws) return true;
      const p = ws.panes.get(ws.focusedPaneId);
      if (p && (p.kind === 'browser' || p.kind === 'config')) {
        try { p.view.webContents.toggleDevTools({ mode: 'detach' }); } catch {}
      } else if (p && p.kind === 'term') {
        try { world.termView.webContents.toggleDevTools({ mode: 'detach' }); } catch {}
      }
      return true;
    }
    case 'engage': {
      if (!ws) return true;
      const p = ws.panes.get(ws.focusedPaneId);
      if (p && p.kind === 'browser') {
        p.engaged = true;
        try { p.view.webContents.focus(); } catch {}
        updateBrowserBorder(p);
      }
      return true;
    }
    case 'disengage': {
      if (!ws) return true;
      const p = ws.panes.get(ws.focusedPaneId);
      if (p && p.kind === 'browser') {
        if (p.engaged) {
          p.engaged = false;
          try { world.termView.webContents.focus(); } catch {}
          updateBrowserBorder(p);
        } else {
          convertToTerminal(world, p.id);
        }
      }
      return true;
    }
  }
  return false;
}

function handleNavChord(world, input) {
  const action = actionFor(input);
  if (!action) return false;
  return dispatchAction(world, action);
}

// ---------- window lifecycle ----------

// Clamp saved bounds to the current screen layout so a display change
// (external monitor disconnected) doesn't bring the window up offscreen.
function clampToDisplay(saved) {
  if (!saved || typeof saved !== 'object') return null;
  try {
    const { screen } = require('electron');
    const work = screen.getPrimaryDisplay().workArea;
    const width  = Math.max(300, Math.min(saved.width  || work.width,  work.width));
    const height = Math.max(200, Math.min(saved.height || work.height, work.height));
    const x = Math.max(work.x, Math.min(saved.x != null ? saved.x : work.x,
                                        work.x + work.width  - width));
    const y = Math.max(work.y, Math.min(saved.y != null ? saved.y : work.y,
                                        work.y + work.height - height));
    return { x, y, width, height };
  } catch { return null; }
}

// Build a runtime workspace from a snapshot — fresh paneIds, reattached
// tmux sessions for term leaves, navigationHistory.restore() for browser
// leaves.
function restoreWorkspace(world, wsSnap) {
  const ws = {
    id: newWsId(),
    name: wsSnap.name || 'ws1',
    root: null,
    focusedPaneId: null,
    panes: new Map(),
  };
  world.workspaces.push(ws);

  const paneIdByLeafIdx = [];
  function buildNode(node) {
    if (!node) return null;
    if (node.kind === 'leaf') {
      const paneId = newPaneId();
      paneIdByLeafIdx[node.leafIdx] = paneId;
      return { kind: 'leaf', paneId };
    }
    return {
      kind: 'split',
      dir: node.dir,
      ratio: node.ratio,
      a: buildNode(node.a),
      b: buildNode(node.b),
    };
  }
  ws.root = buildNode(wsSnap.root);
  if (!ws.root) {
    // Empty tree; seed with a default term pane so the workspace is valid.
    const pid = newPaneId();
    ws.root = { kind: 'leaf', paneId: pid };
    ws.focusedPaneId = pid;
    addTermPane(world, ws, pid);
    return;
  }

  const focusLeafIdx = typeof wsSnap.focusedLeafIdx === 'number' ? wsSnap.focusedLeafIdx : 0;
  ws.focusedPaneId = paneIdByLeafIdx[focusLeafIdx] || paneIdByLeafIdx[0];

  // Now rehydrate each leaf. The order here doesn't matter for correctness
  // (panes register by id in ws.panes), but mirror the leaves array order
  // so focusedPaneId resolves to something real by the time we push focus.
  const leaves = Array.isArray(wsSnap.leaves) ? wsSnap.leaves : [];
  for (let i = 0; i < leaves.length; i++) {
    const leaf = leaves[i] || { kind: 'term' };
    const paneId = paneIdByLeafIdx[i];
    if (!paneId) continue;
    if (leaf.kind === 'browser') {
      // Restore through the standard convertToBrowser path. The transient
      // term pane's tmux session is created then torn down by convertToBrowser.
      // Mint a fresh session name for the transient — the saved snapshot
      // has no tmuxSession for browser leaves anyway.
      addTermPane(world, ws, paneId);
      const startUrl = (leaf.history && leaf.history[leaf.historyIndex]
                        && leaf.history[leaf.historyIndex].url) || 'about:blank';
      convertToBrowser(world, paneId, startUrl, null, {
        restoreEntries: leaf.history,
        restoreIndex: leaf.historyIndex,
        zoomFactor: leaf.zoomFactor,
        engaged: leaf.engaged,
      });
    } else if (leaf.kind === 'config') {
      addTermPane(world, ws, paneId);
      try { convertToConfig(world, paneId); } catch (e) {
        console.warn('[ophanim] restore convertToConfig failed:', e.message);
      }
    } else {
      // Term — pass the saved tmuxSession verbatim so spawnPtyViaTmux
      // reattaches to the exact surviving shell. If that session is
      // gone (crash, user ran kill-session externally), spawnPty will
      // transparently create a fresh one under the same name.
      addTermPane(world, ws, paneId, leaf.tmuxSession);
    }
  }
}

function newWindow(snapshot) {
  // snapshot is an optional element from sessions.json's `windows` array.
  // When present, build bounds/workspaces/panes from it; otherwise fall
  // back to the default seed (one ws, one term pane).
  // Size always comes from windowConfig so edits to window.width/height
  // take effect on the next launch even if the user had dragged the
  // window to a different size before Save & quit. The saved snapshot
  // still contributes x/y so the window reopens where it was.
  const snapBounds = clampToDisplay(snapshot && snapshot.bounds);
  const bounds = {
    width:  windowConfig.width  || 1000,
    height: windowConfig.height || 650,
    ...(snapBounds ? { x: snapBounds.x, y: snapBounds.y } : {}),
  };
  const win = new BrowserWindow({
    ...bounds,
    title: 'Ophanim',
    backgroundColor: '#000000',
  });

  const termView = new WebContentsView({
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  win.contentView.addChildView(termView);
  const wb0 = win.getContentBounds();
  termView.setBounds({ x: 0, y: 0, width: wb0.width, height: wb0.height });
  termView.webContents.on('did-finish-load', () => {
    try { termView.webContents.setZoomFactor(1); } catch {}
  });
  termView.webContents.loadFile(path.join(APP_DIR, 'index.html'));

  const world = {
    win, termView,
    workspaces: [], activeIdx: 0,
    rendererReady: false,
    zoomDelta: (snapshot && typeof snapshot.zoomDelta === 'number') ? snapshot.zoomDelta : 0,
  };
  worlds.set(win.id, world);

  if (snapshot && Array.isArray(snapshot.workspaces) && snapshot.workspaces.length) {
    for (const wsSnap of snapshot.workspaces) restoreWorkspace(world, wsSnap);
    world.activeIdx = Math.max(0, Math.min(
      snapshot.activeWsIdx || 0, world.workspaces.length - 1));
  } else {
    // Default seed: one workspace, one terminal pane.
    const ws0 = {
      id: newWsId(), name: 'ws1',
      root: null, focusedPaneId: null, panes: new Map(),
    };
    const paneId = newPaneId();
    ws0.root = { kind: 'leaf', paneId };
    ws0.focusedPaneId = paneId;
    world.workspaces.push(ws0);
    addTermPane(world, ws0, paneId);
  }

  termView.webContents.on('before-input-event', (event, input) => {
    if (handleNavChord(world, input)) event.preventDefault();
  });

  const syncTermBounds = () => {
    if (win.isDestroyed() || termView.webContents.isDestroyed()) return;
    const wb = win.getContentBounds();
    const cur = termView.getBounds();
    if (cur.x === 0 && cur.y === 0 && cur.width === wb.width && cur.height === wb.height) return;
    termView.setBounds({ x: 0, y: 0, width: wb.width, height: wb.height });
    layoutWorld(world);
  };
  win.on('resize', syncTermBounds);
  win.on('resized', () => { syncTermBounds(); markSessionDirty(); });
  win.on('move',    () => { markSessionDirty(); });
  win.on('show', syncTermBounds);
  win.on('ready-to-show', syncTermBounds);
  const pollId = setInterval(syncTermBounds, 250);

  // Per-window close gate. If the window has non-trivial state (>1 workspace,
  // >1 pane anywhere, or any browser pane), ask before closing. Triggered by
  // the red traffic-light, Cmd+Shift+W, and programmatic win.close().
  // quitConfirmed is set when the user OK'd an app-level quit — skip the
  // per-window prompt in that case so they don't see N dialogs in a row.
  win.on('close', (e) => {
    if (quitConfirmed || win._closeConfirmed) return;
    let wsCount = 0, paneCount = 0, hasBrowser = false;
    for (const ws of world.workspaces) {
      wsCount++;
      for (const p of ws.panes.values()) {
        paneCount++;
        if (p.kind === 'browser') hasBrowser = true;
      }
    }
    const trivial = wsCount <= 1 && paneCount <= 1 && !hasBrowser;
    if (trivial) {
      // Nothing to confirm, but still snapshot before the window dies
      // so the next launch can reattach to whatever's in the tmux server.
      if (sessionStore) { try { sessionStore.flushSync(); } catch {} }
      return;
    }
    e.preventDefault();
    const pl = (n, s) => `${n} ${n === 1 ? s : s + 's'}`;
    const choice = dialog.showMessageBoxSync(win, {
      type: 'question',
      buttons: ['Save & close', 'Discard & close', 'Cancel'],
      defaultId: 0,
      cancelId: 2,
      title: 'Close window?',
      message: 'Close this window?',
      detail:
        `${pl(wsCount, 'workspace')}, ${pl(paneCount, 'pane')}.\n\n` +
        `Save & close: your layout and running shells come back the next ` +
        `time you open Ophanim.\nDiscard & close: shells are killed and the ` +
        `saved layout is cleared.`,
    });
    if (choice === 0) {
      // Save path: snapshot the layout so the next launch can reattach,
      // then let the window close. tmux sessions stay alive.
      win._closeConfirmed = true;
      if (sessionStore) { try { sessionStore.flushSync(); } catch {} }
      win.close();
    } else if (choice === 1) {
      // Discard path: kill every tmux session in this window and delete
      // the saved snapshot so next launch is fresh.
      win._closeConfirmed = true;
      if (tmuxBackend && tmuxBackend.available()) {
        for (const ws of world.workspaces) {
          for (const p of ws.panes.values()) {
            if (p.kind === 'term' && p.tmuxSession) { try { tmuxBackend.killSession(p.tmuxSession); } catch {} }
          }
        }
      }
      if (sessionStore) {
        try { fs.unlinkSync(sessionStore.sessionPath); } catch {}
      }
      win.close();
    }
    // choice === 2 (Cancel): the preventDefault above keeps the window.
  });

  win.on('closed', () => {
    clearInterval(pollId);
    for (const ws of world.workspaces) {
      for (const p of ws.panes.values()) {
        if (p.kind === 'term') {
          // Just kill the attach client — NOT the tmux session. Closing
          // a window (red X, Cmd+Shift+W, or the app quit path) should
          // preserve shells so a relaunch brings them back. The snapshot
          // was written in win.on('close') before the window died, so
          // the tree state needed to reattach is on disk.
          try { p.pty && p.pty.kill(); } catch {}
        }
        if (p.kind === 'browser') {
          const n = p.pid ? Number(p.pid) : NaN;
          if (Number.isFinite(n) && n > 0) { try { process.kill(n, 'SIGTERM'); } catch {} }
        }
      }
    }
    worlds.delete(win.id);
  });

  return world;
}

// ---------- IPC ----------

ipcMain.on('renderer-ready', (e) => {
  for (const world of worlds.values()) {
    if (world.termView.webContents === e.sender) {
      world.rendererReady = true;
      pushRuntimeConfig(world);
      if (lastConfigError) {
        world.termView.webContents.send('config-error', { message: lastConfigError });
      }
      // Replay pane-add for every pane, not just term — the renderer needs
      // a host div per pane (browser and config included) so focus/border
      // CSS can be applied. Without this, panes materialized during restore
      // (before rendererReady was set) have no host, so `.focused` has
      // nowhere to attach and the highlight never appears.
      for (const ws of world.workspaces) {
        for (const pane of ws.panes.values()) {
          world.termView.webContents.send('pane-add', { paneId: pane.id, kind: pane.kind });
        }
      }
      layoutWorld(world);
      pushFocus(world);
      pushWorkspaces(world);
      return;
    }
  }
});

ipcMain.on('pty-write', (_e, { paneId, data }) => {
  const found = findPaneGlobal(paneId);
  if (found && found.pane.kind === 'term' && found.pane.pty) {
    try { found.pane.pty.write(data); } catch {}
  }
});

ipcMain.on('pty-resize', (_e, { paneId, cols, rows }) => {
  const found = findPaneGlobal(paneId);
  if (found && found.pane.kind === 'term' && found.pane.pty) {
    try { found.pane.pty.resize(cols, rows); } catch {}
  }
});

ipcMain.on('dispatch-action', (e, action) => {
  for (const world of worlds.values()) {
    if (world.termView.webContents === e.sender) {
      dispatchAction(world, action);
      return;
    }
  }
});

ipcMain.on('activate-workspace', (e, { idx }) => {
  for (const world of worlds.values()) {
    if (world.termView.webContents === e.sender) {
      activateWorkspace(world, idx);
      return;
    }
  }
});

ipcMain.on('rename-workspace', (e, { idx, name }) => {
  for (const world of worlds.values()) {
    if (world.termView.webContents === e.sender) {
      const ws = world.workspaces[idx];
      if (ws) {
        ws.name = String(name || '').slice(0, 32) || ws.name;
        pushWorkspaces(world);
        markSessionDirty();
      }
      return;
    }
  }
});


ipcMain.on('ophanim-config', (e) => {
  for (const world of worlds.values()) {
    if (world.termView.webContents !== e.sender) continue;
    const ws = activeWs(world);
    if (!ws) return;
    convertToConfig(world, ws.focusedPaneId);
    return;
  }
});

ipcMain.on('ophanim-browse', (e, { paneId, pid, url }) => {
  for (const world of worlds.values()) {
    if (world.termView.webContents !== e.sender) continue;
    const ws = activeWs(world);
    if (!ws || !ws.panes.has(paneId)) return;
    convertToBrowser(world, paneId, url, pid);
    return;
  }
});

function findPaneByChromeWc(wc) {
  for (const world of worlds.values()) {
    for (const ws of world.workspaces) {
      for (const pane of ws.panes.values()) {
        if (pane.kind === 'browser' && pane.chromeView.webContents === wc) {
          return { world, ws, pane };
        }
      }
    }
  }
  return null;
}


ipcMain.on('chrome-ready', (e) => {
  const found = findPaneByChromeWc(e.sender);
  if (!found) return;
  pushBrowserTheme(found.pane);
  found.pane.pushNavState();
  try { found.pane.pushLoading(found.pane.view.webContents.isLoading()); } catch {}
  if (found.pane.zoomFactor && found.pane.zoomFactor !== 1) {
    try { found.pane.chromeView.webContents.send('chrome-zoom', found.pane.zoomFactor); } catch {}
  }
  const u = found.pane.view.webContents.getURL() || '';
  if (/^about:blank\b/.test(u)) {
    try { found.pane.chromeView.webContents.focus(); } catch {}
    try { found.pane.chromeView.webContents.send('focus-url'); } catch {}
  }
});
ipcMain.on('chrome-defocus', (e) => {
  const found = findPaneByChromeWc(e.sender);
  if (found) convertToTerminal(found.world, found.pane.id);
});
ipcMain.on('chrome-expand', () => {});
ipcMain.on('nav-back', (e) => {
  const found = findPaneByChromeWc(e.sender);
  if (found && found.pane.view.webContents.canGoBack()) found.pane.view.webContents.goBack();
});
ipcMain.on('nav-forward', (e) => {
  const found = findPaneByChromeWc(e.sender);
  if (found && found.pane.view.webContents.canGoForward()) found.pane.view.webContents.goForward();
});
ipcMain.on('nav-reload', (e) => {
  const found = findPaneByChromeWc(e.sender);
  if (found) found.pane.view.webContents.reload();
});
ipcMain.on('nav-stop', (e) => {
  const found = findPaneByChromeWc(e.sender);
  if (found) found.pane.view.webContents.stop();
});
ipcMain.on('nav-url', (e, raw) => {
  const found = findPaneByChromeWc(e.sender);
  if (!found) return;
  const target = normalizeUrl(raw);
  try { found.pane.view.webContents.loadURL(target); } catch {}
  try { found.pane.view.webContents.focus(); } catch {}
});
ipcMain.handle('omnibox-suggest', (_e, query) => combinedSuggest(query || ''));

app.whenReady().then(() => {
  // Spoof client hints and ua-branding so Google sign-in doesn't treat us
  // as an embedded webview. Electron only reports "Chromium" by default;
  // real Chrome also reports a "Google Chrome" brand.
  const chromeFull = process.versions.chrome || '146.0.0.0';
  const chromeMajor = chromeFull.split('.')[0];
  const brandShort = `"Chromium";v="${chromeMajor}", "Google Chrome";v="${chromeMajor}", "Not?A_Brand";v="99"`;
  const brandFull  = `"Chromium";v="${chromeFull}", "Google Chrome";v="${chromeFull}", "Not?A_Brand";v="99.0.0.0"`;
  try {
    session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
      const h = details.requestHeaders;
      // Only rewrite if Chromium sent any ua hint in the first place (avoids
      // sending unsolicited headers on requests that didn't ask for them).
      if (h['sec-ch-ua'] !== undefined) h['sec-ch-ua'] = brandShort;
      if (h['sec-ch-ua-full-version-list'] !== undefined) h['sec-ch-ua-full-version-list'] = brandFull;
      callback({ requestHeaders: h });
    });
  } catch (e) { console.warn('[ophanim] sec-ch-ua hook:', e.message); }

  writeDefaultsFile();
  ensureConfigFile();
  loadConfigFromDisk();
  watchConfig();
  loadHistory();

  // Init backends before the first newWindow so spawn/attach during
  // restore hits a ready tmuxBackend (required for hasSession checks).
  initTmuxBackend();
  const store = initSessionStore();

  const restored = store.tryRestoreSession();
  sweepOrphanTmuxSessions(restored);
  if (restored && Array.isArray(restored.windows) && restored.windows.length) {
    for (const w of restored.windows) {
      try { newWindow(w); }
      catch (e) { console.warn('[ophanim] restore window failed:', e.message); }
    }
    if (!worlds.size) newWindow();  // belt-and-braces if every restore threw
  } else {
    newWindow();
  }
});

// Kill any tmux session left over from a prior ophanim process that the
// current snapshot doesn't reference. Sources of orphans:
//   - Crashes / force-quit (snapshot write missed, or layout diverged).
//   - Older ophanim versions that leaked sessions on browser/config convert.
//   - External `tmux new-session` on the same socket.
// Without this sweep, a fresh pane's minted name could collide with an
// orphan and the user would see stale scrollback from a dead shell.
function sweepOrphanTmuxSessions(snapshot) {
  if (!tmuxBackend || !tmuxBackend.available()) return;
  const keep = new Set();
  if (snapshot && Array.isArray(snapshot.windows)) {
    for (const w of snapshot.windows) {
      for (const ws of (w.workspaces || [])) {
        for (const leaf of (ws.leaves || [])) {
          if (leaf && leaf.kind === 'term' && leaf.tmuxSession) keep.add(leaf.tmuxSession);
        }
      }
    }
  }
  let sessions;
  try { sessions = tmuxBackend.listSessions(); } catch { return; }
  for (const name of sessions) {
    if (keep.has(name)) continue;
    try { tmuxBackend.killSession(name); } catch {}
  }
}

// ---------- config pane ----------

// Reduce a full config to just the fields that differ from defaults.
function stripDefaults(value, defaults) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return JSON.stringify(value) === JSON.stringify(defaults) ? undefined : value;
  }
  if (!defaults || typeof defaults !== 'object' || Array.isArray(defaults)) return value;
  const out = {};
  let any = false;
  for (const k of Object.keys(value)) {
    const diff = stripDefaults(value[k], defaults[k]);
    if (diff !== undefined) { out[k] = diff; any = true; }
  }
  return any ? out : undefined;
}

function allDefaults() {
  return {
    keybindings: DEFAULT_BINDINGS,
    terminal: DEFAULT_TERMINAL,
    window: DEFAULT_WINDOW,
    panes: DEFAULT_PANES,
    workspaces: DEFAULT_WORKSPACES,
    browser: DEFAULT_BROWSER,
  };
}

function convertToConfig(world, paneId) {
  let ws = null, pane = null;
  for (const candidateWs of world.workspaces) {
    const cp = candidateWs.panes.get(paneId);
    if (cp) { ws = candidateWs; pane = cp; break; }
  }
  if (!ws || !pane || pane.kind !== 'term') return;
  try { pane.pty && pane.pty.kill(); } catch {}
  if (tmuxBackend && tmuxBackend.available() && pane.tmuxSession) {
    try { tmuxBackend.killSession(pane.tmuxSession); } catch {}
  }
  if (world.rendererReady) {
    world.termView.webContents.send('pane-change-kind', { paneId, kind: 'config' });
  }
  ws.panes.delete(paneId);

  const view = new WebContentsView({
    webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false },
  });
  view.setBackgroundColor('#1a1a1a');
  view.webContents.loadFile(CONFIG_UI_HTML);

  const cp = { id: paneId, kind: 'config', view, rect: pane.rect };
  ws.panes.set(paneId, cp);

  view.webContents.on('before-input-event', (event, input) => {
    const action = actionFor(input);
    if (!action) return;
    if (action === 'disengage' || action === 'closePane') {
      event.preventDefault();
      convertToTerminal(world, cp.id);
    } else if (action === 'closeWindow') {
      event.preventDefault();
      if (!world.win.isDestroyed()) world.win.close();
    } else if (action === 'newWindow') {
      event.preventDefault();
      newWindow();
    }
  });

  world.win.contentView.addChildView(view);
  layoutWorld(world);
  try { view.webContents.focus(); } catch {}
}

function findConfigPaneByWc(wc) {
  for (const world of worlds.values()) {
    for (const ws of world.workspaces) {
      for (const pane of ws.panes.values()) {
        if (pane.kind === 'config' && pane.view.webContents === wc) {
          return { world, ws, pane };
        }
      }
    }
  }
  return null;
}

ipcMain.on('config-ui-ready', (e) => {
  const found = findConfigPaneByWc(e.sender);
  if (!found) return;
  let current = {};
  try { current = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch {}
  found.pane.view.webContents.send('config-ui-init', {
    current,
    defaults: allDefaults(),
  });
});

ipcMain.on('config-ui-save', (e, config) => {
  const found = findConfigPaneByWc(e.sender);
  if (!found) return;
  const sectionDefaults = allDefaults();
  const trimmed = {};
  for (const [k, v] of Object.entries(config)) {
    const diff = stripDefaults(v, sectionDefaults[k]);
    if (diff !== undefined) trimmed[k] = diff;
  }
  const out = { _comment: 'Your overrides. Anything missing falls back to defaults.json (same dir).', ...trimmed };
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(out, null, 2));
    found.pane.view.webContents.send('config-ui-saved');
    loadConfigFromDisk();
  } catch (err) {
    found.pane.view.webContents.send('config-ui-error', err.message);
  }
});

ipcMain.on('config-ui-close', (e) => {
  const found = findConfigPaneByWc(e.sender);
  if (found) convertToTerminal(found.world, found.pane.id);
});

ipcMain.on('config-ui-reset', (e) => {
  const found = findConfigPaneByWc(e.sender);
  if (!found) return;
  const stub = { _comment: 'Your overrides. Anything missing falls back to defaults.json (same dir).', keybindings: {} };
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(stub, null, 2));
    loadConfigFromDisk();
    found.pane.view.webContents.send('config-ui-init', {
      current: stub,
      defaults: allDefaults(),
    });
  } catch (err) {
    found.pane.view.webContents.send('config-ui-error', err.message);
  }
});

app.on('window-all-closed', () => { app.quit(); });

// Confirm full-app quits only. Red traffic-light, Cmd+Shift+W, closePane,
// and closeWorkspace all close immediately — they're explicit local
// gestures. Cmd+Q / File→Quit / "window-all-closed → app.quit" go
// through before-quit and get a native modal so a whole session isn't
// lost to a slipped chord.
let quitConfirmed = false;
app.on('before-quit', (e) => {
  if (quitConfirmed) return;
  let windowCount = 0, workspaceCount = 0, paneCount = 0;
  for (const world of worlds.values()) {
    if (world.win.isDestroyed()) continue;
    windowCount++;
    for (const ws of world.workspaces) {
      workspaceCount++;
      paneCount += ws.panes.size;
    }
  }
  // If the user already closed every window (red X / Cmd+Shift+W / last
  // closeWorkspace), window-all-closed → app.quit reaches us with nothing
  // left to return to. Skip the dialog; they meant it.
  if (windowCount === 0) {
    quitConfirmed = true;
    // Don't flush here — worlds is empty so the snapshot would be
    // `{windows: []}`, wiping out the per-window snapshots that the
    // win.on('close') handlers already wrote. Whatever the last alive
    // window captured is what next launch should restore to.
    return;
  }
  e.preventDefault();
  const pl = (n, s) => `${n} ${n === 1 ? s : s + 's'}`;
  const counts = `${pl(windowCount, 'window')}, ${pl(workspaceCount, 'workspace')}, ${pl(paneCount, 'pane')}.`;
  const choice = dialog.showMessageBoxSync({
    type: 'question',
    buttons: ['Save & quit', 'Discard & quit', 'Cancel'],
    defaultId: 0,
    cancelId: 2,
    title: 'Quit Ophanim?',
    message: 'Quit Ophanim?',
    detail:
      `${counts}\n\n` +
      `Save & quit: your layout and running shells come back the next time ` +
      `you open Ophanim.\nDiscard & quit: shells are killed and the saved ` +
      `layout is cleared.`,
  });
  if (choice === 0) {
    // Save path: snapshot the live state so the next launch restores to it.
    // tmux sessions survive — win.on('closed') only kills the attach clients.
    quitConfirmed = true;
    if (sessionStore) { try { sessionStore.flushSync(); } catch {} }
    app.quit();
  } else if (choice === 1) {
    // Discard path: kill every tmux session across every window, delete
    // the snapshot file, then quit. Fresh slate next launch.
    quitConfirmed = true;
    if (tmuxBackend && tmuxBackend.available()) {
      for (const world of worlds.values()) {
        if (world.win.isDestroyed()) continue;
        for (const ws of world.workspaces) {
          for (const p of ws.panes.values()) {
            if (p.kind === 'term' && p.tmuxSession) { try { tmuxBackend.killSession(p.tmuxSession); } catch {} }
          }
        }
      }
    }
    if (sessionStore) {
      try { fs.unlinkSync(sessionStore.sessionPath); } catch {}
    }
    app.quit();
  }
  // choice === 2 (Cancel): preventDefault above keeps everything running.
});
