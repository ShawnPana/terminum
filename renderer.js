const { ipcRenderer } = require('electron');
const { Terminal } = require('@xterm/xterm');
const { FitAddon } = require('@xterm/addon-fit');

const term = new Terminal({
  fontFamily: 'ui-monospace, Menlo, monospace',
  fontSize: 13,
  cursorBlink: true,
  allowProposedApi: true,
  theme: { background: '#000000', foreground: '#e0e0e0' },
});
const fit = new FitAddon();
term.loadAddon(fit);
term.open(document.getElementById('term'));
fit.fit();
term.focus();

term.onData((data) => ipcRenderer.send('pty-write', data));
ipcRenderer.on('pty-data', (_e, data) => term.write(data));

// ---------- Option-as-Meta ----------
// macOS maps Option+<letter> to dead-key composition by default (Option+N → ˜).
// For tmux/readline bindings we need Option to act like Alt/Meta: send ESC
// followed by the base character of the physical key. We also swallow the
// composition events so no dead-key popup appears.

let layoutMap = null;
async function loadLayout() {
  if (!navigator.keyboard || !navigator.keyboard.getLayoutMap) return;
  try { layoutMap = await navigator.keyboard.getLayoutMap(); } catch {}
}
loadLayout();
window.addEventListener('focus', loadLayout);

const CONTROL_KEYS = {
  Backspace: '\x7f',
  Enter: '\r',
  Tab: '\t',
  Space: ' ',
  Escape: '\x1b',
  ArrowLeft: '\x1b[D',
  ArrowRight: '\x1b[C',
  ArrowUp: '\x1b[A',
  ArrowDown: '\x1b[B',
  Delete: '\x1b[3~',
  Home: '\x1b[H',
  End: '\x1b[F',
  PageUp: '\x1b[5~',
  PageDown: '\x1b[6~',
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
  if (seq !== null) ipcRenderer.send('pty-write', '\x1b' + seq);
}, true);

['compositionstart', 'compositionupdate', 'compositionend', 'textInput'].forEach((type) => {
  window.addEventListener(type, swallow, true);
});
window.addEventListener('beforeinput', (e) => {
  if (e.isComposing || (e.inputType && e.inputType.startsWith('insertComposi'))) swallow(e);
}, true);

// Private OSC 1983 = tdub-specific commands. Payload:
//   tdub-browse;pid=X;url=U   — flip the window into browser mode
// The URL is always the last param so it can contain `;` and `=` raw.
term.parser.registerOscHandler(1983, (data) => {
  const semi = data.indexOf(';');
  const kind = semi === -1 ? data : data.slice(0, semi);
  const rest = semi === -1 ? '' : data.slice(semi + 1);

  if (kind !== 'tdub-browse') return false;

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
    if (key === 'url') {
      urlPart = i === -1 ? val : val + ';' + remaining;
      break;
    }
    params[key] = val;
  }
  ipcRenderer.send('tdub-browse', {
    pid: String(params.pid || ''),
    url: urlPart || 'about:blank',
  });
  return true;
});

function reportSize() {
  fit.fit();
  ipcRenderer.send('pty-resize', { cols: term.cols, rows: term.rows });
}

window.addEventListener('resize', reportSize);

requestAnimationFrame(() => {
  fit.fit();
  ipcRenderer.send('renderer-ready', { cols: term.cols, rows: term.rows });
});
