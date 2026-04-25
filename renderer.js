const { ipcRenderer } = require('electron');
const { Terminal } = require('@xterm/xterm');
const { FitAddon } = require('@xterm/addon-fit');

const stage = document.getElementById('stage');

// paneId → { kind: 'term'|'browser', host, term?, fit? }
const panes = new Map();
let focusedPaneId = null;

// Runtime config pushed from main. Defaults match main's DEFAULT_*.
let termConfig = {
  fontFamily: 'ui-monospace, Menlo, monospace',
  fontSize: 13,
  cursorBlink: true,
  theme: { background: '#000000', foreground: '#e0e0e0' },
};

function applyTermConfigTo(term) {
  try {
    term.options.fontFamily = termConfig.fontFamily;
    term.options.fontSize = termConfig.fontSize;
    term.options.cursorBlink = !!termConfig.cursorBlink;
    term.options.theme = {
      background: termConfig.theme.background,
      foreground: termConfig.theme.foreground,
    };
  } catch {}
}

function applyPaneConfigToDOM(paneConfig) {
  const root = document.documentElement;
  if (!paneConfig || !paneConfig.border) return;
  const b = paneConfig.border;
  if (b.inactive) root.style.setProperty('--pane-border-inactive', b.inactive);
  if (b.focused)  root.style.setProperty('--pane-border-focused',  b.focused);
  if (b.width)    root.style.setProperty('--pane-border-width',    b.width + 'px');
}

function createHost(paneId, kind) {
  const host = document.createElement('div');
  host.className = 'pane-host' + (kind === 'browser' ? ' browser' : '');
  host.id = `pane-${paneId}`;
  stage.appendChild(host);
  return host;
}

function createTermPane(paneId) {
  if (panes.has(paneId)) return panes.get(paneId);
  const host = createHost(paneId, 'term');

  const term = new Terminal({
    fontFamily: termConfig.fontFamily,
    fontSize: termConfig.fontSize,
    cursorBlink: termConfig.cursorBlink,
    allowProposedApi: true,
    // Option on macOS should send ESC+key (Meta) so tmux can bind chords
    // like Option+Tab for scroll mode. Without this, macOS intercepts and
    // Option+letter produces unicode characters (Option+F = ƒ, etc.) that
    // neither tmux nor readline can act on.
    macOptionIsMeta: true,
    theme: {
      background: termConfig.theme.background,
      foreground: termConfig.theme.foreground,
    },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(host);
  term.onData((data) => ipcRenderer.send('pty-write', { paneId, data }));

  // xterm.js's default: in the alternate screen buffer with no mouse
  // tracking, a wheel event becomes an up/down arrow keystroke — the
  // "scroll in `less`" convention. In TUIs with their own input loop
  // (Claude Code, ink-based apps, REPLs) this surfaces as accidental
  // history cycling when the user just meant to scroll.
  // Only suppress the translation when mouse tracking is off, so apps
  // that DO consume real wheel events (Claude Code's Ctrl+O transcript
  // viewer binds wheelup/wheeldown to scroll) still work after they
  // enable mouse reporting.
  term.attachCustomWheelEventHandler((ev) => {
    if (term.buffer.active.type !== 'alternate') return true;
    if (term.modes && term.modes.mouseTrackingMode !== 'none') return true;
    return false;
  });

  // Per-term OSC 1983: browse / config / etc. fired from the pane's shell.
  term.parser.registerOscHandler(1983, (data) => {
    const semi = data.indexOf(';');
    const kind = semi === -1 ? data : data.slice(0, semi);
    if (kind === 'ophanim-config') {
      ipcRenderer.send('ophanim-config');
      return true;
    }
    if (kind !== 'ophanim-browse') return false;
    const rest = data.slice(semi + 1);
    const params = {};
    let urlPart = '';
    let remaining = rest;
    while (remaining.length) {
      const i = remaining.indexOf(';');
      const chunk = i === -1 ? remaining : remaining.slice(0, i);
      remaining = i === -1 ? '' : remaining.slice(i + 1);
      const eq = chunk.indexOf('=');
      if (eq === -1) continue;
      const key = chunk.slice(0, eq);
      const val = chunk.slice(eq + 1);
      if (key === 'url') { urlPart = i === -1 ? val : val + ';' + remaining; break; }
      params[key] = val;
    }
    ipcRenderer.send('ophanim-browse', {
      paneId,
      pid: String(params.pid || ''),
      url: urlPart || 'about:blank',
    });
    return true;
  });

  const entry = { kind: 'term', host, term, fit };
  panes.set(paneId, entry);
  return entry;
}

function createBrowserPaneHost(paneId) {
  if (panes.has(paneId)) return panes.get(paneId);
  const host = createHost(paneId, 'browser');
  const entry = { kind: 'browser', host };
  panes.set(paneId, entry);
  return entry;
}

function destroyPane(paneId) {
  const entry = panes.get(paneId);
  if (!entry) return;
  if (entry.term) { try { entry.term.dispose(); } catch {} }
  try { entry.host.remove(); } catch {}
  panes.delete(paneId);
}

function applyLayout(rectsByPaneId) {
  for (const [paneId, rect] of Object.entries(rectsByPaneId)) {
    const entry = panes.get(paneId);
    if (!entry) continue;
    entry.host.style.left = rect.x + 'px';
    entry.host.style.top = rect.y + 'px';
    entry.host.style.width = rect.w + 'px';
    entry.host.style.height = rect.h + 'px';
    if (entry.kind === 'term') {
      try {
        entry.fit.fit();
        ipcRenderer.send('pty-resize', { paneId, cols: entry.term.cols, rows: entry.term.rows });
      } catch {}
    }
  }
}

function setFocus(paneId) {
  focusedPaneId = paneId;
  for (const [id, entry] of panes) {
    if (id === paneId) {
      entry.host.classList.add('focused');
      if (entry.term) { try { entry.term.focus(); } catch {} }
    } else {
      entry.host.classList.remove('focused');
      if (entry.term) { try { entry.term.blur(); } catch {} }
    }
  }
}

ipcRenderer.on('pane-add', (_e, { paneId, kind }) => {
  if (kind === 'browser' || kind === 'config') createBrowserPaneHost(paneId);
  else createTermPane(paneId);
});
ipcRenderer.on('pane-remove', (_e, { paneId }) => destroyPane(paneId));
ipcRenderer.on('pane-change-kind', (_e, { paneId, kind }) => {
  destroyPane(paneId);
  if (kind === 'browser' || kind === 'config') createBrowserPaneHost(paneId);
  else createTermPane(paneId);
});
ipcRenderer.on('layout', (_e, { rectsByPaneId }) => applyLayout(rectsByPaneId));
ipcRenderer.on('focus', (_e, { paneId }) => setFocus(paneId));
ipcRenderer.on('pty-data', (_e, { paneId, data }) => {
  const entry = panes.get(paneId);
  if (entry && entry.term) entry.term.write(data);
});
ipcRenderer.on('pane-visibility', (_e, { visible, hidden }) => {
  for (const paneId of hidden || []) {
    const entry = panes.get(paneId);
    if (entry) entry.host.style.display = 'none';
  }
  for (const paneId of visible || []) {
    const entry = panes.get(paneId);
    if (entry) {
      entry.host.style.display = '';
      if (entry.fit) { try { entry.fit.fit(); } catch {} }
    }
  }
});

// ---------- workspace bar ----------
const statusbar = document.getElementById('statusbar');
function renderWorkspaces({ list, activeIdx }) {
  statusbar.innerHTML = '';
  list.forEach((ws, i) => {
    const el = document.createElement('div');
    el.className = 'ws-tab' + (i === activeIdx ? ' active' : '');
    el.textContent = `${i + 1}:${ws.name}`;
    el.title = ws.name;
    el.addEventListener('click', () => ipcRenderer.send('activate-workspace', { idx: i }));
    el.addEventListener('dblclick', (ev) => {
      ev.preventDefault();
      const next = prompt('Rename workspace', ws.name);
      if (next && next.trim()) {
        ipcRenderer.send('rename-workspace', { idx: i, name: next.trim() });
      }
    });
    statusbar.appendChild(el);
  });
}
ipcRenderer.on('workspaces', (_e, payload) => renderWorkspaces(payload));

ipcRenderer.on('config-error', (_e, { message }) => {
  let el = document.getElementById('config-error');
  if (!message) {
    if (el) el.remove();
    return;
  }
  if (!el) {
    el = document.createElement('div');
    el.id = 'config-error';
    el.style.marginLeft = 'auto';
    el.style.color = '#cd0000';
    el.style.fontWeight = 'bold';
    el.title = message;
    statusbar.appendChild(el);
  }
  el.textContent = `⚠ config error`;
  el.title = message;
});

ipcRenderer.on('config-update', (_e, cfg) => {
  if (cfg.terminal) {
    termConfig = {
      fontFamily: cfg.terminal.fontFamily || termConfig.fontFamily,
      fontSize: cfg.terminal.fontSize || termConfig.fontSize,
      cursorBlink: cfg.terminal.cursorBlink,
      theme: {
        background: (cfg.terminal.theme && cfg.terminal.theme.background) || termConfig.theme.background,
        foreground: (cfg.terminal.theme && cfg.terminal.theme.foreground) || termConfig.theme.foreground,
      },
    };
    for (const entry of panes.values()) {
      if (entry.term) {
        applyTermConfigTo(entry.term);
        try { entry.fit.fit(); } catch {}
      }
    }
  }
  if (cfg.panes) applyPaneConfigToDOM(cfg.panes);
  if (cfg.workspaces) {
    const w = cfg.workspaces;
    const root = document.documentElement;
    if (w.background)       root.style.setProperty('--ws-bg', w.background);
    if (w.foreground)       root.style.setProperty('--ws-fg', w.foreground);
    if (w.activeForeground) root.style.setProperty('--ws-active-fg', w.activeForeground);
    if (w.borderTop)        root.style.setProperty('--ws-border-top', w.borderTop);
    if (w.hoverBackground)  root.style.setProperty('--ws-hover-bg', w.hoverBackground);
    if (w.hoverForeground)  root.style.setProperty('--ws-hover-fg', w.hoverForeground);
  }
  if (cfg.bindings) bindings = cfg.bindings;
  // Bar height scales with zoom so the status bar grows/shrinks with the
  // terminal font size. Bar font tracks the terminal font, minus a couple
  // px so the tabs don't overwhelm the content.
  if (cfg.barHeight) {
    document.documentElement.style.setProperty('--bar-height', cfg.barHeight + 'px');
  }
  if (cfg.terminal && cfg.terminal.fontSize) {
    const fs = Math.max(9, cfg.terminal.fontSize - 2);
    document.documentElement.style.setProperty('--bar-font-size', fs + 'px');
  }
});

// Chord dispatch (renderer). Needed because main's before-input-event doesn't
// fire for macOS Option-dead-key combos (Option+I, Option+E, Option+N, Option+U)
// — the IME eats the key before Electron can dispatch Input. The DOM keydown
// listener still fires, so we match here and send the action back to main.
let bindings = {};

function chordKeyForEvent(e) {
  const c = String(e.code || '');
  if (/^Key[A-Z]$/.test(c)) return c.slice(3).toLowerCase();
  if (/^Digit\d$/.test(c)) return c.slice(5);
  return String(e.key || '').toLowerCase();
}

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

function actionForEvent(e) {
  const k = chordKeyForEvent(e);
  for (const [action, chords] of Object.entries(bindings)) {
    for (const str of chords) {
      const c = parseChord(str);
      if (!!e.metaKey !== c.meta) continue;
      if (!!e.altKey !== c.alt) continue;
      if (!!e.shiftKey !== c.shift) continue;
      if (!!e.ctrlKey !== c.ctrl) continue;
      if (c.key === '=' && (k === '=' || k === '+')) return action;
      if (k === c.key) return action;
    }
  }
  return null;
}

// Catch nav chords at capture phase, BEFORE the Option-as-Meta fallback
// would send ESC+letter to the pty. This also bypasses macOS dead-key
// interception of Option+I since the DOM keydown still fires.
window.addEventListener('keydown', (e) => {
  const action = actionForEvent(e);
  if (action) {
    swallow(e);
    ipcRenderer.send('dispatch-action', action);
  }
}, true);

// ---------- Option-as-Meta ----------
// macOS maps Option+<letter> to dead-key composition by default. For
// tmux/readline bindings we need Option to act like Alt/Meta: send ESC
// followed by the base character of the physical key.

let layoutMap = null;
async function loadLayout() {
  if (!navigator.keyboard || !navigator.keyboard.getLayoutMap) return;
  try { layoutMap = await navigator.keyboard.getLayoutMap(); } catch {}
}
loadLayout();
window.addEventListener('focus', loadLayout);

const CONTROL_KEYS = {
  Backspace: '\x7f', Enter: '\r', Tab: '\t', Space: ' ', Escape: '\x1b',
  ArrowLeft: '\x1b[D', ArrowRight: '\x1b[C', ArrowUp: '\x1b[A', ArrowDown: '\x1b[B',
  Delete: '\x1b[3~', Home: '\x1b[H', End: '\x1b[F', PageUp: '\x1b[5~', PageDown: '\x1b[6~',
};

function altBaseSequence(e) {
  if (CONTROL_KEYS[e.code]) return CONTROL_KEYS[e.code];
  const base = layoutMap && layoutMap.get(e.code);
  if (!base) return null;
  return e.shiftKey ? base.toUpperCase() : base;
}

function swallow(e) {
  e.preventDefault();
  e.stopPropagation();
  if (e.stopImmediatePropagation) e.stopImmediatePropagation();
}

window.addEventListener('keydown', (e) => {
  if (!e.altKey || e.ctrlKey || e.metaKey) return;
  const seq = altBaseSequence(e);
  swallow(e);
  if (seq !== null && focusedPaneId) {
    ipcRenderer.send('pty-write', { paneId: focusedPaneId, data: '\x1b' + seq });
  }
}, true);

['compositionstart', 'compositionupdate', 'compositionend', 'textInput'].forEach((type) => {
  window.addEventListener(type, swallow, true);
});
window.addEventListener('beforeinput', (e) => {
  if (e.isComposing || (e.inputType && e.inputType.startsWith('insertComposi'))) swallow(e);
}, true);

ipcRenderer.send('renderer-ready');

// CDP-accessible API for external agents. They attach to ophanim's
// renderer target via the remote-debugging port (see cdp.json in
// userData/) and call these via Runtime.evaluate. Single namespace so
// the global scope stays tidy.
const __opLabels = new Map(); // paneId → user-set label

function __opResolve(handle) {
  if (panes.has(handle)) return handle;
  for (const [pid, label] of __opLabels) if (label === handle) return pid;
  return null;
}

function __opKeyToSeq(k) {
  if (typeof k !== 'string' || !k) return null;
  switch (k) {
    case 'Enter': case 'Return': return '\r';
    case 'Escape': case 'Esc': return '\x1b';
    case 'Tab': return '\t';
    case 'Backspace': case 'BSpace': return '\x7f';
    case 'Up': return '\x1b[A';
    case 'Down': return '\x1b[B';
    case 'Right': return '\x1b[C';
    case 'Left': return '\x1b[D';
    case 'Space': return ' ';
  }
  // C-x → control-x; M-x → ESC + x; combine: M-C-x.
  let prefix = '';
  let rest = k;
  if (rest.startsWith('M-')) { prefix += '\x1b'; rest = rest.slice(2); }
  if (rest.startsWith('C-') && rest.length === 3) {
    const c = rest[2].toLowerCase().charCodeAt(0);
    if (c >= 97 && c <= 122) return prefix + String.fromCharCode(c - 96);
  }
  if (rest.length === 1) return prefix + rest;
  return null;
}

window.__ophanim = {
  list() {
    const out = [];
    for (const [pid, entry] of panes) {
      out.push({
        paneId: pid,
        kind: entry.kind,
        label: __opLabels.get(pid) || null,
        focused: pid === focusedPaneId,
      });
    }
    return out;
  },
  read(handle, lines = 50) {
    const pid = __opResolve(handle);
    if (!pid) return null;
    const entry = panes.get(pid);
    if (!entry || !entry.term) return null;
    const buf = entry.term.buffer.active;
    const start = Math.max(0, buf.length - Math.max(1, Math.min(10000, lines | 0)));
    const out = [];
    for (let y = start; y < buf.length; y++) {
      const line = buf.getLine(y);
      out.push(line ? line.translateToString(true) : '');
    }
    return out.join('\n');
  },
  type(handle, text) {
    const pid = __opResolve(handle);
    if (!pid) return false;
    ipcRenderer.send('pty-write', { paneId: pid, data: String(text) });
    return true;
  },
  keys(handle, keys) {
    const pid = __opResolve(handle);
    if (!pid) return false;
    const list = Array.isArray(keys) ? keys : [keys];
    let data = '';
    for (const k of list) {
      const seq = __opKeyToSeq(k);
      if (seq === null) return false;
      data += seq;
    }
    if (data) ipcRenderer.send('pty-write', { paneId: pid, data });
    return true;
  },
  activate(handle) {
    const pid = __opResolve(handle);
    if (!pid) return false;
    ipcRenderer.send('activate-pane', { paneId: pid });
    return true;
  },
  label(handle, name) {
    const pid = __opResolve(handle);
    if (!pid) return false;
    if (name == null || name === '') __opLabels.delete(pid);
    else __opLabels.set(pid, String(name));
    return true;
  },
};
