const { app, BrowserWindow, WebContentsView, ipcMain } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const pty = require('node-pty');

const APP_DIR = __dirname;
const BIN_DIR = path.join(APP_DIR, 'bin');
const CHROME_HTML = path.join(APP_DIR, 'browser-chrome.html');
const CHROME_BAR_HEIGHT = 28;
const CHROME_EXPANDED_MAX = 320;

let win = null;
let termView = null;
let ptyProc = null;

// The window is in exactly one of two states: terminal (null) or browser
// (an object). Entering browser mode stacks two WebContentsViews on top of
// the terminal; exiting destroys them and re-focuses the terminal.
let browser = null;

function ptyEnv() {
  return {
    ...process.env,
    TERM: 'xterm-256color',
    PATH: `${BIN_DIR}:${process.env.PATH || ''}`,
    TDUB_BIN: BIN_DIR,
    // Hijack zsh's rc directory so every zsh spawned inside tdub — including
    // every tmux pane — re-prepends $TDUB_BIN after the user's rc runs.
    // Survives macOS path_helper wiping PATH on login shells.
    ZDOTDIR: path.join(APP_DIR, 'shell', 'zsh'),
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
    if (termView && !termView.webContents.isDestroyed()) {
      termView.webContents.send('pty-data', data);
    }
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

// ---------- browser mode ----------

function layoutBrowser() {
  if (!browser || !win || win.isDestroyed()) return;
  const wb = win.getContentBounds();
  const desired = browser.chromeExpandedHeight > CHROME_BAR_HEIGHT
    ? Math.min(browser.chromeExpandedHeight, CHROME_EXPANDED_MAX)
    : CHROME_BAR_HEIGHT;
  const barH = Math.min(desired, wb.height);
  browser.chromeView.setBounds({ x: 0, y: 0, width: wb.width, height: barH });
  browser.view.setBounds({
    x: 0, y: barH,
    width: wb.width, height: Math.max(0, wb.height - barH),
  });
}

function enterBrowser({ pid, url }) {
  if (browser) exitBrowser();
  const target = normalizeUrl(url);

  const view = new WebContentsView({
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  const chromeView = new WebContentsView({
    webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false },
  });
  chromeView.setBackgroundColor('#1b1b1b');
  chromeView.webContents.loadFile(CHROME_HTML);

  browser = { pid: String(pid), view, chromeView, chromeExpandedHeight: 0 };

  const pushNavState = () => {
    if (!browser || chromeView.webContents.isDestroyed()) return;
    chromeView.webContents.send('nav-state', {
      url: view.webContents.getURL() || '',
      canGoBack: view.webContents.canGoBack(),
      canGoForward: view.webContents.canGoForward(),
    });
  };
  browser.pushNavState = pushNavState;

  const onStateChange = () => {
    pushNavState();
    try { recordVisit(view.webContents.getURL(), view.webContents.getTitle()); } catch {}
  };
  view.webContents.on('did-navigate', onStateChange);
  view.webContents.on('did-navigate-in-page', onStateChange);
  view.webContents.on('did-finish-load', onStateChange);
  view.webContents.on('page-title-updated', onStateChange);

  view.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.key === 'Escape' && input.alt) {
      event.preventDefault();
      exitBrowser();
    }
  });

  win.contentView.addChildView(view);
  win.contentView.addChildView(chromeView);
  layoutBrowser();
  view.webContents.loadURL(target);
}

function exitBrowser() {
  if (!browser) return;
  const { pid, view, chromeView } = browser;
  browser = null;
  try { win.contentView.removeChildView(chromeView); } catch {}
  try { chromeView.webContents.close(); } catch {}
  try { win.contentView.removeChildView(view); } catch {}
  try { view.webContents.close(); } catch {}
  const n = Number(pid);
  if (Number.isFinite(n)) {
    try { process.kill(n, 'SIGTERM'); } catch {}
  }
  if (termView && !termView.webContents.isDestroyed()) {
    try { termView.webContents.focus(); } catch {}
  }
}

function resizeTermView() {
  if (!win || win.isDestroyed() || !termView) return;
  const wb = win.getContentBounds();
  termView.setBounds({ x: 0, y: 0, width: wb.width, height: wb.height });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1000, height: 650,
    title: 'tdub',
    backgroundColor: '#000000',
  });

  termView = new WebContentsView({
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });
  win.contentView.addChildView(termView);
  termView.webContents.loadFile('index.html');
  resizeTermView();

  win.on('resize', () => {
    resizeTermView();
    layoutBrowser();
  });
  win.on('closed', () => {
    killPty();
    win = null;
    termView = null;
    browser = null;
  });
}

// ---------- IPC ----------

ipcMain.on('renderer-ready', (_e, { cols, rows }) => {
  if (!ptyProc) spawnPty(cols || 100, rows || 30);
});
ipcMain.on('pty-write', (_e, data) => { if (ptyProc) ptyProc.write(data); });
ipcMain.on('pty-resize', (_e, { cols, rows }) => {
  if (ptyProc) {
    try { ptyProc.resize(cols, rows); } catch {}
  }
});

ipcMain.on('tdub-browse', (_e, params) => enterBrowser(params));

ipcMain.on('chrome-ready', () => {
  if (!browser) return;
  browser.pushNavState();
  const u = browser.view.webContents.getURL() || '';
  if (/^about:blank\b/.test(u)) {
    try { browser.chromeView.webContents.focus(); } catch {}
    try { browser.chromeView.webContents.send('focus-url'); } catch {}
  }
});
ipcMain.on('chrome-defocus', () => exitBrowser());
ipcMain.on('chrome-expand', (_e, height) => {
  if (!browser) return;
  browser.chromeExpandedHeight = (height && height > CHROME_BAR_HEIGHT) ? height : 0;
  layoutBrowser();
});
ipcMain.on('nav-back', () => {
  if (browser && browser.view.webContents.canGoBack()) browser.view.webContents.goBack();
});
ipcMain.on('nav-forward', () => {
  if (browser && browser.view.webContents.canGoForward()) browser.view.webContents.goForward();
});
ipcMain.on('nav-reload', () => {
  if (browser) browser.view.webContents.reload();
});
ipcMain.on('nav-url', (_e, raw) => {
  if (!browser) return;
  const target = normalizeUrl(raw);
  if (!target) return;
  try { browser.view.webContents.loadURL(target); } catch {}
  try { browser.view.webContents.focus(); } catch {}
});
ipcMain.handle('omnibox-suggest', (_e, query) => combinedSuggest(query || ''));

app.whenReady().then(() => {
  loadHistory();
  createWindow();
});

app.on('window-all-closed', () => {
  app.quit();
});
