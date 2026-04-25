"""Ophanim CDP helper. Standalone — drives terminal AND browser panes
through one connection.

Discovery: ophanim writes its CDP port to ~/Library/Application
Support/Ophanim/cdp.json on launch. This module reads it, finds the
renderer target (URL ends with /index.html), attaches over CDP, and
exposes the renderer's window.__ophanim namespace as Python functions.

Requires `websocket-client` (pip install websocket-client). No other
deps; deliberately not tied to browser-harness.
"""

import json
import threading
import urllib.request
from pathlib import Path

import websocket  # type: ignore  # pip install websocket-client

CDP_FILE = Path.home() / "Library" / "Application Support" / "Ophanim" / "cdp.json"
INDEX_SUFFIX = "/index.html"

_lock = threading.Lock()
_state = {"ws": None, "session_id": None, "msg_id": 0}


def _next_id() -> int:
    _state["msg_id"] += 1
    return _state["msg_id"]


def _resolve_target(port: int) -> dict:
    """Find the renderer target (the one rendering index.html)."""
    raw = urllib.request.urlopen(f"http://127.0.0.1:{port}/json", timeout=2).read()
    targets = json.loads(raw)
    for t in targets:
        if t.get("url", "").endswith(INDEX_SUFFIX):
            return t
    raise RuntimeError("ophanim renderer target not found — is ophanim running?")


def _connect():
    """Open WS to the renderer + Target.attachToTarget. Returns (ws, session_id)."""
    if _state["ws"] is not None:
        return _state["ws"], _state["session_id"]
    if not CDP_FILE.exists():
        raise RuntimeError(f"{CDP_FILE} not found — is ophanim running?")
    info = json.loads(CDP_FILE.read_text())
    port = info["port"]
    target = _resolve_target(port)
    ws = websocket.create_connection(target["webSocketDebuggerUrl"], timeout=5)
    aid = _next_id()
    ws.send(json.dumps({
        "id": aid,
        "method": "Target.attachToTarget",
        "params": {"targetId": target["id"], "flatten": True},
    }))
    while True:
        m = json.loads(ws.recv())
        if m.get("id") == aid:
            if "error" in m:
                raise RuntimeError(m["error"])
            session_id = m["result"]["sessionId"]
            break
    _state["ws"] = ws
    _state["session_id"] = session_id
    return ws, session_id


def close():
    """Drop the cached WS connection. Next call reconnects."""
    ws = _state.pop("ws", None)
    _state["ws"] = None
    _state["session_id"] = None
    if ws is not None:
        try: ws.close()
        except Exception: pass


def _eval(expr: str):
    """Evaluate JS in the renderer; return the resulting value (returnByValue=True)."""
    with _lock:
        try:
            ws, sid = _connect()
        except Exception:
            close()
            raise
        rid = _next_id()
        ws.send(json.dumps({
            "id": rid,
            "sessionId": sid,
            "method": "Runtime.evaluate",
            "params": {
                "expression": expr,
                "returnByValue": True,
                "awaitPromise": True,
            },
        }))
        while True:
            try:
                m = json.loads(ws.recv())
            except Exception:
                close()
                raise
            if m.get("id") != rid:
                continue
            if "error" in m:
                raise RuntimeError(m["error"])
            r = m["result"]["result"]
            if r.get("subtype") == "error":
                raise RuntimeError(r.get("description", "JS error in renderer"))
            return r.get("value")


def _q(v) -> str:
    return json.dumps(v)


# ---------- public API ----------

def list_panes():
    """Return [{paneId, kind, label, focused}]."""
    return _eval("window.__ophanim.list()")


def read_pane(handle, lines: int = 50) -> str:
    """Last `lines` lines of the pane's xterm buffer. Accepts paneId or label."""
    return _eval(f"window.__ophanim.read({_q(handle)}, {int(lines)})")


def type_pane(handle, text: str) -> bool:
    """Write text into the pane's pty (no Enter). Accepts paneId or label."""
    return _eval(f"window.__ophanim.type({_q(handle)}, {_q(text)})")


def keys_to_pane(handle, *keys) -> bool:
    """Send special keys: 'Enter', 'Escape', 'Tab', 'Up'/'Down'/'Left'/'Right',
    'C-c', 'M-x', etc."""
    arr = list(keys)
    return _eval(f"window.__ophanim.keys({_q(handle)}, {_q(arr)})")


def activate_pane(handle) -> bool:
    """Focus the pane."""
    return _eval(f"window.__ophanim.activate({_q(handle)})")


def label_pane(handle, name) -> bool:
    """Attach a stable user-friendly label. Pass empty string to clear."""
    return _eval(f"window.__ophanim.label({_q(handle)}, {_q(name)})")


def resolve(name: str):
    """Find paneId for a label, or None."""
    for p in list_panes() or []:
        if p.get("label") == name or p.get("paneId") == name:
            return p["paneId"]
    return None


__all__ = [
    "list_panes", "read_pane", "type_pane", "keys_to_pane",
    "activate_pane", "label_pane", "resolve", "close",
]
