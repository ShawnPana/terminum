// session-store.js — write / read the world-layout snapshot so that
// quitting and relaunching ophanim brings back every workspace, split
// tree position, browser pane URL + history + scroll + form state, and
// (via tmux-backend) every terminal shell still running exactly where
// it was.
//
// The file lives at `<userData>/sessions.json`. Writes are debounced
// 2.5s during normal use (matches Chrome's session-service cadence) and
// synchronous on `before-quit`. Atomic via .tmp + rename so a torn write
// can never leave a partially-valid file on disk.

const fs = require('fs');
const path = require('path');

const VERSION = 1;
const SAVE_DEBOUNCE_MS = 2500;

function createStore({ userDataDir, getWorlds }) {
  const sessionPath   = path.join(userDataDir, 'sessions.json');
  const tmpPath       = sessionPath + '.tmp';

  let dirtyTimer = null;
  let stopped = false;

  // ---- tree serialization ----
  // Runtime tree nodes use live paneIds (`p1`, `p5`, …) which reset on
  // each process. Snapshot encodes leaves as `leafIdx` — position in the
  // workspace's flat `leaves` array — so fresh paneIds can be minted at
  // restore without breaking structural links.
  function serializeNode(node, leavesInOrder, paneById) {
    if (!node) return null;
    if (node.kind === 'leaf') {
      const pane = paneById.get(node.paneId);
      if (!pane) return null;
      const leafIdx = leavesInOrder.length;
      leavesInOrder.push(captureLeaf(pane));
      return { kind: 'leaf', leafIdx };
    }
    return {
      kind: 'split',
      dir: node.dir,
      ratio: node.ratio,
      a: serializeNode(node.a, leavesInOrder, paneById),
      b: serializeNode(node.b, leavesInOrder, paneById),
    };
  }

  function captureLeaf(pane) {
    if (pane.kind === 'term') {
      return { kind: 'term', tmuxSession: `term-${pane.id}` };
    }
    if (pane.kind === 'browser') {
      return captureBrowserLeaf(pane);
    }
    // Config panes have no state worth preserving; restore opens a fresh one.
    return { kind: 'config' };
  }

  function captureBrowserLeaf(pane) {
    const out = { kind: 'browser', engaged: !!pane.engaged };
    if (typeof pane.zoomFactor === 'number' && pane.zoomFactor !== 1) {
      out.zoomFactor = pane.zoomFactor;
    }
    try {
      const wc = pane.view && pane.view.webContents;
      if (wc && !wc.isDestroyed()) {
        const nh = wc.navigationHistory;
        if (nh && typeof nh.getAllEntries === 'function') {
          out.history = nh.getAllEntries();          // [{url,title,pageState}, …]
          out.historyIndex = nh.getActiveIndex();
        }
      }
    } catch (e) {
      // navigationHistory might not be ready yet on a fresh pane; fine.
    }
    return out;
  }

  // Find which leaf is currently focused and return its leafIdx.
  function focusedLeafIdxFor(ws, root, leavesInOrder, paneById) {
    // Same traversal order as serializeNode — find a leaf whose paneId
    // matches ws.focusedPaneId and return its index.
    let result = -1;
    let counter = 0;
    (function walk(node) {
      if (result !== -1 || !node) return;
      if (node.kind === 'leaf') {
        if (node.paneId === ws.focusedPaneId) result = counter;
        counter++;
        return;
      }
      walk(node.a); walk(node.b);
    })(root);
    return result;
  }

  // ---- world serialization ----
  function serializeWorlds() {
    const worlds = getWorlds();
    const out = { version: VERSION, savedAt: Date.now(), windows: [] };
    for (const world of worlds.values()) {
      if (!world || !world.win || world.win.isDestroyed()) continue;
      const bounds = world.win.getBounds();
      const workspaces = [];
      for (const ws of world.workspaces) {
        const leavesInOrder = [];
        const paneById = ws.panes;
        const root = serializeNode(ws.root, leavesInOrder, paneById);
        if (!root) continue;
        const focusedLeafIdx = focusedLeafIdxFor(ws, ws.root, leavesInOrder, paneById);
        workspaces.push({
          name: ws.name,
          focusedLeafIdx: focusedLeafIdx >= 0 ? focusedLeafIdx : 0,
          root,
          leaves: leavesInOrder,
        });
      }
      if (!workspaces.length) continue;
      out.windows.push({
        bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
        activeWsIdx: Math.max(0, Math.min(world.activeIdx || 0, workspaces.length - 1)),
        zoomDelta: world.zoomDelta || 0,
        workspaces,
      });
    }
    return out;
  }

  function atomicWrite(json) {
    try {
      fs.mkdirSync(userDataDir, { recursive: true });
      fs.writeFileSync(tmpPath, json);
      fs.renameSync(tmpPath, sessionPath);
    } catch (e) {
      console.warn('[session-store] write failed:', e.message);
    }
  }

  function flushSync() {
    if (stopped) return;
    try {
      const snap = serializeWorlds();
      atomicWrite(JSON.stringify(snap, null, 2));
    } catch (e) {
      console.warn('[session-store] flushSync failed:', e.message);
    }
  }

  function scheduleDirtyWrite() {
    if (stopped) return;
    if (dirtyTimer) return;
    dirtyTimer = setTimeout(() => {
      dirtyTimer = null;
      flushSync();
    }, SAVE_DEBOUNCE_MS);
  }

  function stop() {
    stopped = true;
    if (dirtyTimer) { clearTimeout(dirtyTimer); dirtyTimer = null; }
  }

  // ---- restore ----
  function tryRestoreSession() {
    let raw;
    try { raw = fs.readFileSync(sessionPath, 'utf8'); }
    catch (e) { return null; }   // no file = no restore = normal seed

    let parsed;
    try { parsed = JSON.parse(raw); }
    catch (e) {
      // Keep the evidence around and start fresh rather than silently losing data.
      const brokenPath = sessionPath + '.broken.' + Date.now();
      try { fs.renameSync(sessionPath, brokenPath); } catch {}
      console.warn('[session-store] corrupt sessions.json, moved to', brokenPath);
      return null;
    }

    if (!parsed || parsed.version !== VERSION) {
      console.warn('[session-store] version mismatch, skipping restore');
      return null;
    }
    if (!Array.isArray(parsed.windows)) return null;
    return parsed;
  }

  return {
    serializeWorlds,
    captureLeaf,
    captureBrowserLeaf,
    scheduleDirtyWrite,
    flushSync,
    tryRestoreSession,
    stop,
    sessionPath,
  };
}

module.exports = { createStore, VERSION };
