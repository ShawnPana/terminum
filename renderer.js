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
ipcRenderer.on('reset', () => {
  term.reset();
  fit.fit();
  term.focus();
  ipcRenderer.send('pty-resize', { cols: term.cols, rows: term.rows });
});

function reportSize() {
  fit.fit();
  ipcRenderer.send('pty-resize', { cols: term.cols, rows: term.rows });
}
window.addEventListener('resize', reportSize);

// One frame later the layout is real; measure and tell main to spawn the pty.
requestAnimationFrame(() => {
  fit.fit();
  ipcRenderer.send('renderer-ready', { cols: term.cols, rows: term.rows });
});
