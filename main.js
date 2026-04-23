const { app, BrowserWindow, WebContentsView, ipcMain } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const net = require('net');
const pty = require('node-pty');

const APP_DIR = __dirname;
const BIN_DIR = path.join(APP_DIR, 'bin');
const CHROME_HTML = path.join(APP_DIR, 'browser-chrome.html');
const CHROME_BAR_HEIGHT = 28;             // collapsed navbar height
const CHROME_EXPANDED_MAX = 320;           // cap for omnibox dropdown expansion
// Stable per-user socket path at $HOME. Fixed path means tdub restarts don't
// invalidate long-lived shells (e.g. tmux panes), and living in $HOME means
// `browse` can compute the path from $HOME without depending on a TDUB_SOCK
// env var that may or may not have propagated through tmux's env plumbing.
const SOCKET_PATH = path.join(os.homedir(), '.tdub.sock');

let win = null;
let ptyProc = null;
let browserView = null;     // page content
let chromeView = null;      // navbar + omnibox
let mode = 'terminal';
let chromeExpandedHeight = 0;  // 0 = collapsed; >0 = dropdown open

function ptyEnv() {
  return {
    ...process.env,
    TERM: 'xterm-256color',
    PATH: `${BIN_DIR}:${process.env.PATH || ''}`,
    TDUB_SOCK: SOCKET_PATH,
  };
}

function spawnPty(cols = 100, rows = 30) {
  const shell = process.env.SHELL || '/bin/zsh';
  ptyProc = pty.spawn(shell, [], {
    name: 'xterm-256color',
    cols, rows,
    cwd: os.homedir(),
    env: ptyEnv(),
  });
  ptyProc.onData((data) => {
    if (win && !win.isDestroyed()) win.webContents.send('pty-data', data);
  });
  ptyProc.onExit(() => { ptyProc = null; });
}

function killPty() {
  if (ptyProc) {
    try { ptyProc.kill(); } catch {}
    ptyProc = null;
  }
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

// ---------- history store ----------

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

// ---------- google suggest ----------

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
  } catch {
    return [];
  }
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

// ---------- browser / navbar layout ----------

function layoutBrowser() {
  if (!win || win.isDestroyed()) return;
  const b = win.getContentBounds();
  if (chromeView) {
    const desired = chromeExpandedHeight > CHROME_BAR_HEIGHT
      ? Math.min(chromeExpandedHeight, CHROME_EXPANDED_MAX)
      : CHROME_BAR_HEIGHT;
    const barH = Math.min(desired, b.height);
    chromeView.setBounds({ x: 0, y: 0, width: b.width, height: barH });
    if (browserView) {
      browserView.setBounds({
        x: 0, y: barH,
        width: b.width,
        height: Math.max(0, b.height - barH),
      });
    }
  } else if (browserView) {
    browserView.setBounds({ x: 0, y: 0, width: b.width, height: b.height });
  }
}

function pushChromeState() {
  if (!chromeView || chromeView.webContents.isDestroyed()) return;
  if (!browserView) return;
  chromeView.webContents.send('nav-state', {
    url: browserView.webContents.getURL() || '',
    canGoBack: browserView.webContents.canGoBack(),
    canGoForward: browserView.webContents.canGoForward(),
  });
}

function enterBrowser(url) {
  const target = normalizeUrl(url);
  if (mode === 'browser' && browserView) {
    browserView.webContents.loadURL(target);
    return;
  }

  // Page content.
  browserView = new WebContentsView({
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  // Opaque background so the xterm underneath doesn't bleed through on
  // about:blank (and during the brief load-time blank before a page paints).
  browserView.setBackgroundColor('#ffffff');
  browserView.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.key === 'Escape' && input.alt) {
      event.preventDefault();
      exitBrowser();
    }
  });
  const onStateChange = () => {
    pushChromeState();
    try {
      recordVisit(browserView.webContents.getURL(), browserView.webContents.getTitle());
    } catch {}
  };
  browserView.webContents.on('did-navigate', onStateChange);
  browserView.webContents.on('did-navigate-in-page', onStateChange);
  browserView.webContents.on('did-finish-load', onStateChange);
  browserView.webContents.on('page-title-updated', onStateChange);

  // Navbar — its own WebContentsView so it has nodeIntegration without
  // taking it on the page.
  chromeView = new WebContentsView({
    webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false },
  });
  chromeView.setBackgroundColor('#1b1b1b');
  chromeView.webContents.loadFile(CHROME_HTML);

  // Add content first, then chrome, so chrome is on top in z-order for the
  // dropdown overlay.
  win.contentView.addChildView(browserView);
  win.contentView.addChildView(chromeView);

  browserView.webContents.loadURL(target);
  chromeExpandedHeight = 0;
  layoutBrowser();
  mode = 'browser';
  killPty();
}

function exitBrowser() {
  if (chromeView) {
    try { win.contentView.removeChildView(chromeView); } catch {}
    try { chromeView.webContents.close(); } catch {}
    chromeView = null;
  }
  if (browserView) {
    try { win.contentView.removeChildView(browserView); } catch {}
    try { browserView.webContents.close(); } catch {}
    browserView = null;
  }
  chromeExpandedHeight = 0;
  mode = 'terminal';
  spawnPty();
  if (win && !win.isDestroyed()) {
    try { win.webContents.send('reset'); } catch {}
    try { win.webContents.focus(); } catch {}
  }
}

function startSocketServer() {
  try { fs.unlinkSync(SOCKET_PATH); } catch {}
  const server = net.createServer((conn) => {
    let buf = '';
    conn.on('data', (chunk) => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        const m = line.match(/^browse\s+(.+)$/);
        if (m) enterBrowser(m[1].trim());
      }
    });
  });
  server.listen(SOCKET_PATH);
  return server;
}

function createWindow() {
  win = new BrowserWindow({
    width: 1000, height: 650,
    title: 'tdub',
    backgroundColor: '#000000',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });
  win.loadFile('index.html');

  win.on('resize', layoutBrowser);
  win.on('closed', () => {
    killPty();
    win = null;
  });
}

// ---------- IPC ----------

// PTY
ipcMain.on('renderer-ready', (_e, { cols, rows }) => {
  if (!ptyProc) spawnPty(cols || 100, rows || 30);
});
ipcMain.on('pty-write', (_e, data) => { if (ptyProc) ptyProc.write(data); });
ipcMain.on('pty-resize', (_e, { cols, rows }) => {
  if (ptyProc) {
    try { ptyProc.resize(cols, rows); } catch {}
  }
});

// Navbar
ipcMain.on('chrome-ready', () => {
  pushChromeState();
  // Chrome-style new-tab behavior: on about:blank, focus the URL input so
  // the user can type a URL immediately without clicking.
  if (browserView && chromeView && !chromeView.webContents.isDestroyed()) {
    const u = browserView.webContents.getURL() || '';
    if (/^about:blank\b/.test(u)) {
      try { chromeView.webContents.focus(); } catch {}
      try { chromeView.webContents.send('focus-url'); } catch {}
    }
  }
});
ipcMain.on('chrome-click', () => { /* no-op in tdub */ });
ipcMain.on('chrome-defocus', () => exitBrowser());
ipcMain.on('chrome-expand', (_e, height) => {
  chromeExpandedHeight = (height && height > CHROME_BAR_HEIGHT) ? height : 0;
  layoutBrowser();
});
ipcMain.on('nav-back', () => {
  if (browserView && browserView.webContents.canGoBack()) browserView.webContents.goBack();
});
ipcMain.on('nav-forward', () => {
  if (browserView && browserView.webContents.canGoForward()) browserView.webContents.goForward();
});
ipcMain.on('nav-reload', () => {
  if (browserView) browserView.webContents.reload();
});
ipcMain.on('nav-url', (_e, raw) => {
  if (!browserView) return;
  const target = normalizeUrl(raw);
  if (!target) return;
  try { browserView.webContents.loadURL(target); } catch {}
  try { browserView.webContents.focus(); } catch {}
});
ipcMain.handle('omnibox-suggest', (_e, query) => combinedSuggest(query || ''));

app.whenReady().then(() => {
  loadHistory();
  startSocketServer();
  createWindow();
});

app.on('window-all-closed', () => {
  try { fs.unlinkSync(SOCKET_PATH); } catch {}
  app.quit();
});
