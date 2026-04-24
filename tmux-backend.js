// tmux-backend.js — thin wrapper around a bundled tmux binary.
//
// ophanim hosts every terminal pane's shell inside a dedicated tmux server
// so that shells outlive the Electron process. Benefits:
//   - Quit ophanim → shells keep running. Relaunch → reattach and everything
//     (scrollback, cwd, running processes, ssh sessions) is still there.
//   - Converting a term pane to a browser pane no longer SIGHUPs the shell —
//     we only kill the attach client, the session stays alive.
//   - External terminals can `tmux -L ophanim attach -t term-pN` to see the
//     same shell ophanim is showing.
//
// We own a tiny `ophanim-tmux.conf` that neuters every tmux UI feature so
// tmux is purely a PTY supervisor — no status bar, no prefix keys, no mouse
// capture. Everything a user types flows straight to the shell.
//
// If the bundled binary is missing and no override is set, `available()`
// returns false and main.js falls back to direct node-pty spawning (today's
// behavior, no persistence).

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const pty = require('node-pty');

const SOCKET_LABEL = 'ophanim';

const TMUX_CONF = `# ophanim runtime tmux config — generated, do not edit.
# We want tmux purely as a PTY supervisor, not a UI. Everything that could
# intercept keystrokes, mutate the visible buffer, or change sizing behavior
# in surprising ways is disabled here.
set -g prefix None
unbind-key -a
set -g status off
set -g mouse off
set -g exit-empty off
set -g default-terminal tmux-256color
set -g history-limit 50000
set -g window-size latest
set -g detach-on-destroy off
`;

function createBackend({ unpackedDir, userDataDir, getOverridePath }) {
  let confPath = null;
  let cachedTmuxPath = undefined; // undefined = not yet resolved, null = unavailable, string = path

  function bundledTmuxPath() {
    return path.join(unpackedDir, 'build', 'vendor', `tmux-${process.arch}`, 'tmux');
  }

  function resolveTmuxPath() {
    // User-configured override wins if valid.
    const override = (getOverridePath && getOverridePath()) || '';
    if (override && typeof override === 'string') {
      try {
        fs.accessSync(override, fs.constants.X_OK);
        return override;
      } catch {
        console.warn('[tmux-backend] terminal.tmuxPath set but not executable:', override);
      }
    }
    // Otherwise the bundled binary.
    const bundled = bundledTmuxPath();
    try {
      fs.accessSync(bundled, fs.constants.X_OK);
      return bundled;
    } catch {
      return null;
    }
  }

  function tmuxPath() {
    if (cachedTmuxPath === undefined) cachedTmuxPath = resolveTmuxPath();
    return cachedTmuxPath;
  }

  // Clear the cache so a config change (terminal.tmuxPath) takes effect
  // without restarting. main.js can call this from its config reload hook.
  function invalidatePathCache() { cachedTmuxPath = undefined; }

  function available() { return tmuxPath() !== null; }

  function ensureConfFile() {
    if (confPath) return confPath;
    const p = path.join(userDataDir, 'ophanim-tmux.conf');
    try {
      fs.mkdirSync(userDataDir, { recursive: true });
      fs.writeFileSync(p, TMUX_CONF);
      confPath = p;
    } catch (e) {
      console.warn('[tmux-backend] could not write conf file:', e.message);
      // Fall back to no conf — tmux defaults will be used. Not ideal but
      // the user still gets persistence.
      confPath = null;
    }
    return confPath;
  }

  function baseArgs() {
    const args = ['-L', SOCKET_LABEL];
    const conf = ensureConfFile();
    if (conf) args.push('-f', conf);
    return args;
  }

  function sessionName(paneId) { return `term-${paneId}`; }

  function runControl(extraArgs, opts = {}) {
    const bin = tmuxPath();
    if (!bin) throw new Error('tmux not available');
    return execFileSync(bin, [...baseArgs(), ...extraArgs], {
      encoding: 'utf8',
      stdio: opts.stdio || ['ignore', 'pipe', 'pipe'],
      env: opts.env || process.env,
    });
  }

  function hasSession(paneId) {
    if (!available()) return false;
    try {
      runControl(['has-session', '-t', sessionName(paneId)]);
      return true;
    } catch {
      return false;
    }
  }

  function createSession(paneId, { shellCommand, env, cwd }) {
    if (!available()) throw new Error('tmux not available');
    const args = [
      'new-session', '-d',
      '-s', sessionName(paneId),
      '-x', '200', '-y', '50',      // initial size; resized on attach
      '-c', cwd || process.env.HOME || '/',
    ];
    // shellCommand is a single pre-quoted shell command line; tmux runs
    // it via /bin/sh -c. If omitted, tmux uses default-shell (usually
    // $SHELL or /bin/sh).
    if (shellCommand) args.push(shellCommand);
    runControl(args, { env: env || process.env });
  }

  function killSession(paneId) {
    if (!available()) return;
    try {
      runControl(['kill-session', '-t', sessionName(paneId)]);
    } catch {
      // Already gone — benign.
    }
  }

  function listSessions() {
    if (!available()) return [];
    try {
      const out = runControl(['list-sessions', '-F', '#{session_name}']);
      return out.split('\n').filter(Boolean);
    } catch {
      return [];  // no sessions = non-zero exit
    }
  }

  function attach(paneId, { cols, rows, env }) {
    if (!available()) throw new Error('tmux not available');
    // TMUX env var has to be unset; tmux refuses to attach from inside an
    // existing client otherwise ("sessions should be nested with care").
    const childEnv = { ...(env || process.env), TMUX: '' };
    const args = [...baseArgs(), 'attach-session', '-t', sessionName(paneId)];
    return pty.spawn(tmuxPath(), args, {
      name: 'tmux-256color',
      cols: cols || 100,
      rows: rows || 30,
      cwd: childEnv.HOME || '/',
      env: childEnv,
    });
  }

  return {
    available,
    tmuxPath,
    invalidatePathCache,
    sessionName,
    hasSession,
    createSession,
    killSession,
    listSessions,
    attach,
  };
}

module.exports = { createBackend, SOCKET_LABEL };
