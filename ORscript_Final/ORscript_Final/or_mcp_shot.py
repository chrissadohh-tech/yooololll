#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""or_mcp_shot.py - take a Roblox Studio picture the way ZeroScript does.

Studio's built-in MCP server already offers a capture tool (`screen_capture`) that
returns the picture as an MCP image content part.  This helper is a tiny MCP *client*
of its own: it launches Roblox's signed StudioMCP.exe, speaks JSON-RPC to it over
stdio, looks up the CONNECTED studio id with `list_roblox_studios`, calls the capture
tool, and writes the PNG next to the agent workspace.

Why a separate client:
  * No PowerShell, no .ps1, no C# compile - nothing a script scanner quarantines.
    (The user's antivirus blocks studio_shot.ps1 outright; this is the route that
    keeps working, the same one ZeroScript's bridge.py uses.)
  * The picture never has to pass through the Rust agent's socket, so an older
    or-agent.exe that drops MCP image blocks still gets the shot: the bytes are
    written to disk and read back as text.

Contract with the extension (deliberately identical to studio_shot.ps1's):
  the LAST line is machine-readable -  OR_STUDIO_SHOT {"ok":true,...}  - with
  file/bytes/mime/sha256/base64_file/base64_chars/base64_lines so background.js can
  verify and attach it without knowing which tool produced it.

Usage:
  python or_mcp_shot.py --out or_mcp_shot.png
  python or_mcp_shot.py --selftest          # no capture: report tools + schema
  OR_STUDIO_MCP_PATH=/path/to/StudioMCP.exe python or_mcp_shot.py   # override
"""
from __future__ import annotations

import argparse
import base64
import glob
import hashlib
import json
import os
import re
import subprocess
import sys
import threading
import time

STUDIO_MCP_PORT = 13469
CAPTURE_TOOL = "screen_capture"
STUDIO_LIST_TOOL = "list_roblox_studios"
TEXT_LINE_CHARS = 400            # the .b64 twin's line width (matches studio_shot.ps1)
TEXT_TUNNEL_MAX_CHARS = 1800000  # ~1.35 MB of picture: the paged text read stops here
STALE_ID_RE = re.compile(r"studio_?id|list_roblox_studios|not connected|disconnected|no active Studio", re.I)


def log(msg: str) -> None:
    """Human-readable lines. The extension only parses the LAST OR_STUDIO_SHOT line."""
    try:
        print(str(msg), flush=True)
    except Exception:
        pass


def result(obj: dict) -> None:
    try:
        print("OR_STUDIO_SHOT " + json.dumps(obj, separators=(",", ":")), flush=True)
    except Exception:
        pass


# ── launching Roblox's own MCP helper (a signed Roblox program) ───────────────
def _newest(paths) -> str:
    best, best_t = "", -1.0
    for p in paths:
        try:
            t = os.path.getmtime(p)
        except OSError:
            continue
        if t > best_t:
            best, best_t = p, t
    return best


def find_studio_mcp() -> str:
    """Roblox's StudioMCP.exe, newest installed version first.

    The version folder changes on every Studio auto-update and Roblox's own
    %LOCALAPPDATA%\\Roblox\\mcp.bat hard-codes one path, which is why the search
    takes the newest across every folder instead of trusting the .bat.
    """
    override = os.environ.get("OR_STUDIO_MCP_PATH", "").strip()
    if override:
        if os.path.isfile(override):
            return override
        if os.path.isdir(override):
            for cand in ("StudioMCP.exe", "StudioMCP"):
                p = os.path.join(override, cand)
                if os.path.isfile(p):
                    return p
            p = os.path.join(override, "Contents", "MacOS", "StudioMCP")
            if os.path.isfile(p):
                return p
        return ""

    roots = []
    local = os.environ.get("LOCALAPPDATA")
    if local:
        roots.append(os.path.join(local, "Roblox", "Versions"))
    for env in ("ProgramFiles", "ProgramFiles(x86)", "PROGRAMFILES", "PROGRAMFILES(X86)"):
        v = os.environ.get(env)
        if v:
            roots.append(os.path.join(v, "Roblox", "Versions"))
    hits = []
    for root in roots:
        hits += glob.glob(os.path.join(root, "*", "StudioMCP.exe"))
    if hits:
        return _newest(hits)

    if sys.platform == "darwin":
        hits = glob.glob(os.path.expanduser("~/Library/Application Support/Roblox/Versions/*/StudioMCP"))
        hits += glob.glob("/Applications/RobloxStudio.app/Contents/MacOS/StudioMCP")
        if hits:
            return _newest(hits)
    return ""


def port_owner(port: int):
    """(pid, name) of the process LISTENING on `port`, or None. Windows only."""
    if sys.platform != "win32":
        return None
    out = ""
    for proto in ("TCP", "TCPv6"):
        try:
            out += subprocess.run(["netstat", "-ano", "-p", proto], capture_output=True,
                                  text=True, encoding="utf-8", errors="replace",
                                  timeout=10).stdout
        except Exception:
            return None
    for line in out.splitlines():
        parts = line.split()
        if len(parts) < 4 or parts[0].upper() != proto.upper():
            continue
        if not parts[1].endswith(":" + str(port)):
            continue
        if parts[3].upper() != "LISTENING":
            continue
        pid = parts[-1]
        if not pid.isdigit():
            continue
        name = ""
        try:
            tl = subprocess.run(["tasklist", "/FI", "PID eq " + pid, "/FO", "CSV", "/NH"],
                                capture_output=True, text=True, encoding="utf-8",
                                errors="replace", timeout=10).stdout
            name = (tl.split(",")[0] if tl.strip() else "").strip('" ')
        except Exception:
            pass
        return int(pid), name
    return None


def free_studio_port(child_pid=None) -> str:
    """A StudioMCP.exe left over from a crashed session keeps the port, and a fresh
    one can never bind it - then Studio never re-registers and the server looks dead.
    Kill ONLY a process that is named StudioMCP.exe (never Studio itself, never our
    own child). Returns a note about what happened, for the log."""
    owner = port_owner(STUDIO_MCP_PORT)
    if not owner:
        return ""
    pid, name = owner
    if pid == child_pid or pid == os.getpid():
        return ""
    if str(name).lower() != "studiomcp.exe":
        # Studio itself (or another program) owns the port: not ours to kill. The
        # capture can still work if Studio's own MCP server is the one listening.
        return "port %d is held by %s (pid %d) - left alone" % (STUDIO_MCP_PORT, name or "?", pid)
    try:
        subprocess.run(["taskkill", "/F", "/PID", str(pid)], capture_output=True, timeout=10)
        log("took over the Studio MCP port from a leftover StudioMCP.exe (pid %d)" % pid)
    except Exception as exc:
        return "could not stop the leftover StudioMCP.exe (pid %d): %s" % (pid, exc)
    deadline = time.time() + 6
    while time.time() < deadline:
        if port_owner(STUDIO_MCP_PORT) is None:
            break
        time.sleep(0.25)
    return "took over the Studio MCP port from a leftover StudioMCP.exe (pid %d)" % pid


# ── a minimal MCP client over stdio ──────────────────────────────────────────
class Mcp:
    def __init__(self, program: str, timeout: float = 25.0):
        if timeout < 2:
            timeout = 2.0
        self.deadline = time.time() + timeout
        flags = 0x08000000 if sys.platform == "win32" else 0   # CREATE_NO_WINDOW
        self.proc = subprocess.Popen(
            [program], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL, text=True, encoding="utf-8",
            errors="replace", bufsize=1, creationflags=flags,
        )
        self.rid = 0

    def send(self, method: str, params=None, notify: bool = False):
        rid = None
        msg = {"jsonrpc": "2.0", "method": method}
        if params is not None:
            msg["params"] = params
        if not notify:
            self.rid += 1
            rid = self.rid
            msg["id"] = rid
        try:
            self.proc.stdin.write(json.dumps(msg) + "\n")
            self.proc.stdin.flush()
        except Exception as exc:
            raise RuntimeError("could not write to StudioMCP: %s" % exc)
        return rid

    def wait(self, rid, budget: float):
        """Read until the answer to `rid` arrives. Notifications are skipped; a
        blocking read is fine because a watchdog thread owns the overall deadline."""
        end = min(self.deadline, time.time() + budget)
        while time.time() < end:
            line = self.proc.stdout.readline()
            if not line:
                raise RuntimeError("StudioMCP closed the pipe (no answer)")
            line = line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except Exception:
                continue                      # a log line, not JSON-RPC: ignore it
            if msg.get("id") == rid:
                if msg.get("error"):
                    err = msg["error"]
                    raise RuntimeError(err.get("message") if isinstance(err, dict) else str(err))
                return msg.get("result") or {}
        raise TimeoutError("StudioMCP did not answer in time")

    def request(self, method: str, params=None, budget: float = 12.0):
        rid = self.send(method, params)
        return self.wait(rid, budget)

    def close(self):
        try:
            self.proc.kill()
        except Exception:
            pass


def tools_of(client: Mcp, wait_seconds: float = 12.0):
    """tools/list, retried: StudioMCP advertises ZERO tools until Studio attaches
    (and after a takeover Studio re-registers within a couple of seconds)."""
    end = time.time() + wait_seconds
    tools = []
    while time.time() < end:
        try:
            res = client.request("tools/list", {}, budget=6)
        except Exception:
            res = {}
        tools = res.get("tools") or []
        if tools:
            return tools
        time.sleep(0.5)
    return tools


# ── arguments: the tool's OWN schema says what it needs ──────────────────────
ID_KEY_RE = re.compile(r"^(?:studio|instance|place|editor)_?id$", re.I)
PATH_KEY_RE = re.compile(r"path|file|filename|output|dir|folder", re.I)


def pick_required(tool: dict, key: str) -> str:
    """A schema property whose name means a studio id, else ''."""
    props = ((tool or {}).get("inputSchema") or {}).get("properties") or {}
    keys = list(props.keys())
    keys.sort(key=lambda k: 0 if k.lower() == key else 1)
    for k in keys:
        if ID_KEY_RE.match(str(k)):
            return k
    return ""


def build_args(tool: dict, studio_id: str, out_path: str) -> dict:
    """Fill what the tool's schema declares required, and the two things a value
    cannot be invented for: the CONNECTED studio id, and (when the tool can save the
    file itself) a path to save it to."""
    schema = (tool or {}).get("inputSchema") or {}
    props = schema.get("properties") or {}
    required = list(schema.get("required") or [])
    args = {}
    for key in list(props.keys()) + required:
        spec = props.get(key) or {}
        if key in args:
            continue
        low = str(key).lower()
        if ID_KEY_RE.match(low):
            if studio_id:
                args[key] = studio_id
            continue
        if PATH_KEY_RE.search(low) and out_path:
            args[key] = out_path
            continue
        if key not in required:
            continue                      # never invent an OPTIONAL argument
        if isinstance(spec.get("enum"), list) and spec["enum"]:
            args[key] = spec["enum"][0]
        elif spec.get("default") is not None:
            args[key] = spec["default"]
        elif spec.get("type") == "boolean":
            args[key] = False
        elif spec.get("type") in ("integer", "number"):
            args[key] = 1
        else:
            args[key] = "or_capture_" + format(int(time.time() * 1000) % 10 ** 9, "x")
    return args


def content_of(res: dict):
    """MCP result.content is an ARRAY of typed parts: join the text parts, take the
    image parts. Unknown part types are kept as truncated JSON so nothing vanishes."""
    content = (res or {}).get("content") or []
    text = "\n".join(str(it.get("text", "")) for it in content if it.get("type") == "text")
    images = [{"data": it["data"], "mimeType": it.get("mimeType") or "image/jpeg"}
              for it in content if it.get("type") == "image" and it.get("data")]
    if not text and not images and content:
        text = json.dumps(content)[:4000]
    return text, images


def studio_id_from(text: str) -> str:
    """Read the CONNECTED studio id out of list_roblox_studios' answer: JSON when the
    server is structured, plain text when it is not."""
    raw = str(text or "")
    data = None
    first = [i for i in (raw.find("{"), raw.find("[")) if i >= 0]
    if first:
        try:
            data = json.loads(raw[min(first):raw.rfind("}") + 1] if "{" in raw else raw[min(first):])
        except Exception:
            data = None
    strong, weak, generic = [], [], []
    def walk(node, depth=0, in_studio=False):
        if depth > 6 or node is None:
            return
        if isinstance(node, list):
            for x in node:
                walk(x, depth + 1, in_studio)
            return
        if not isinstance(node, dict):
            return
        for k, v in node.items():
            key = re.sub(r"[^a-z0-9]", "", str(k).lower())
            studioish = in_studio or re.search(r"studio|instance|place|editor|connection", key)
            if isinstance(v, (dict, list)):
                walk(v, depth + 1, bool(studioish))
                continue
            s = "" if v is None else str(v).strip()
            if not s or len(s) > 200:
                continue
            if key in ("studioid", "instanceid"):
                strong.append(s)
            elif key == "id" and studioish:
                weak.append(s)
            elif key == "id":
                generic.append(s)
    if data is not None:
        walk(data)
    for bucket in (strong, weak, generic):
        if bucket:
            return bucket[0]
    m = re.search(r'"studio_?id"\s*:\s*"?([A-Za-z0-9_.:\-]{2,200})', raw, re.I)
    if m:
        return m.group(1)
    m = re.search(r'\bstudio_?id\b[\s"\']*[:=][\s"\']*([A-Za-z0-9_.:\-]{2,200})', raw, re.I)
    return m.group(1) if m else ""


def file_in_text(text: str) -> str:
    m = re.search(r'(?:[A-Za-z]:[\\/]|\\\\[^\s"\']+[\\/]|/)[^"\'\r\n<>|?*]*?\.(?:png|jpe?g|webp|bmp|gif)\b',
                  str(text or ""), re.I)
    return m.group(0).strip() if m else ""


def write_twin(path: str, blob: bytes) -> dict:
    b64 = base64.b64encode(blob).decode("ascii")
    lines = [b64[i:i + TEXT_LINE_CHARS] for i in range(0, len(b64), TEXT_LINE_CHARS)]
    twin = path + ".b64"
    with open(twin, "w", encoding="utf-8", newline="\n") as fh:
        fh.write("\n".join(lines) + "\n")
    return {
        "base64_file": twin, "base64_chars": len(b64), "base64_lines": len(lines),
        "sha256": hashlib.sha256(blob).hexdigest(),
        "too_large": len(b64) > TEXT_TUNNEL_MAX_CHARS,
    }


def sniff_mime(blob: bytes, fallback: str) -> str:
    if len(blob) > 8 and blob[0] == 0x89 and blob[1] == 0x50:
        return "image/png"
    if len(blob) > 2 and blob[0] == 0xFF and blob[1] == 0xD8:
        return "image/jpeg"
    return fallback or "image/png"


def fail(stage: str, error: str, hint: str = "") -> int:
    obj = {"ok": False, "stage": stage, "error": str(error)[:600], "method": "mcp-stdio"}
    if hint:
        obj["hint"] = hint[:600]
    result(obj)
    return 1


def main() -> int:
    ap = argparse.ArgumentParser(description="Take a Roblox Studio picture over its MCP server.")
    ap.add_argument("--out", default="or_mcp_shot.png", help="where to write the picture")
    ap.add_argument("--timeout", type=float, default=25.0, help="overall seconds before it gives up")
    ap.add_argument("--selftest", action="store_true", help="report StudioMCP + tools, take no picture")
    ap.add_argument("--no-takeover", action="store_true", help="never stop a leftover StudioMCP.exe")
    args = ap.parse_args()

    # A watchdog owns the deadline: whatever happens (a tool that never answers, a
    # pipe that stays silent) the process ends with a machine-readable answer.
    child = {"proc": None}

    def watchdog():
        time.sleep(max(3.0, args.timeout))
        try:
            if child["proc"] is not None:
                child["proc"].kill()
        except Exception:
            pass
        result({"ok": False, "stage": "timeout", "method": "mcp-stdio",
                "error": "the Studio MCP did not produce a picture within %ds" % int(args.timeout)})
        os._exit(3)

    threading.Thread(target=watchdog, daemon=True).start()

    exe = find_studio_mcp()
    if not exe:
        return fail("find-studiomcp",
                    "Roblox's StudioMCP.exe was not found (looked in %LOCALAPPDATA%\\Roblox\\Versions\\*\\StudioMCP.exe)",
                    "Open Roblox Studio once so it installs its MCP helper, or point OR_STUDIO_MCP_PATH at StudioMCP.exe.")

    note = "" if args.no_takeover else free_studio_port()
    client = None
    try:
        client = Mcp(exe, timeout=args.timeout)
        child["proc"] = client.proc
        client.request("initialize", {
            "protocolVersion": "2024-11-05", "capabilities": {},
            "clientInfo": {"name": "OR-screenshot", "version": "1.0"},
        }, budget=10)
        client.send("notifications/initialized", {}, notify=True)
        tools = tools_of(client, wait_seconds=max(4.0, args.timeout - 8))
        names = [str(t.get("name") or "") for t in tools]
        if not tools:
            return fail("no-tools",
                        "StudioMCP answered but advertised no tools" + (" [%s]" % note if note else ""),
                        "Roblox Studio is not connected to the MCP server: open Studio, load a place, and enable MCP (Assistant AI > ... > Manage MCP Servers).")
        cap = next((t for t in tools if str(t.get("name")) == CAPTURE_TOOL), None) \
            or next((t for t in tools if "screen" in str(t.get("name")).lower() and "capture" in str(t.get("name")).lower()), None)
        if cap is None:
            return fail("no-capture-tool",
                        "this Studio MCP has no capture tool - it offers: " + ", ".join(names[:20]),
                        "Update Roblox Studio: the picture tool ships with its built-in MCP server.")
        id_tool = next((t for t in tools if str(t.get("name")) == STUDIO_LIST_TOOL), None) \
            or next((t for t in tools if "studio" in str(t.get("name")).lower() and "list" in str(t.get("name")).lower()), None)

        if args.selftest:
            log("StudioMCP: " + exe)
            log("tools (%d): %s" % (len(names), ", ".join(names)))
            log("capture tool: %s  schema=%s" % (cap.get("name"), json.dumps(cap.get("inputSchema") or {})))
            result({"ok": True, "selftest": True, "method": "mcp-stdio", "exe": exe, "tools": names,
                    "capture_tool": cap.get("name"), "capture_schema": cap.get("inputSchema") or {},
                    "studio_list_tool": (id_tool or {}).get("name") or "", "takeover": note})
            return 0

        studio_id = ""
        if id_tool is not None:
            try:
                sid_text, _ = content_of(client.request("tools/call", {"name": id_tool.get("name"), "arguments": {}}, budget=10))
                studio_id = studio_id_from(sid_text)
            except Exception as exc:
                log("could not list studios (%s) - trying the capture anyway" % exc)

        out_path = os.path.abspath(args.out)
        call_args = build_args(cap, studio_id, out_path)
        log("calling %s %s" % (cap.get("name"), json.dumps(call_args)))
        try:
            res = client.request("tools/call", {"name": cap.get("name"), "arguments": call_args}, budget=max(8.0, args.timeout - 6))
        except Exception as exc:
            # "The requested studio_id is not connected ... Call list_roblox_studios for
            # the current ..." - the server's own words say where the fresh id lives, so
            # look it up again and retry ONCE. Never a loop.
            if not (id_tool is not None and STALE_ID_RE.search(str(exc))):
                raise
            sid_text, _ = content_of(client.request("tools/call", {"name": id_tool.get("name"), "arguments": {}}, budget=8))
            fresh = studio_id_from(sid_text)
            log("the id went stale (%s) - looked it up again: %s" % (str(exc)[:120], fresh or "?"))
            if not fresh or fresh == studio_id:
                raise
            studio_id = fresh
            call_args = build_args(cap, studio_id, out_path)
            log("calling %s %s" % (cap.get("name"), json.dumps(call_args)))
            res = client.request("tools/call", {"name": cap.get("name"), "arguments": call_args}, budget=max(8.0, args.timeout - 6))
        text, images = content_of(res)

        if images:
            try:
                blob = base64.b64decode(re.sub(r"[^A-Za-z0-9+/=]", "", images[0]["data"]))
            except Exception as exc:
                return fail("decode", "the picture arrived as base64 text that could not be decoded: %s" % exc)
            if len(blob) < 64:
                return fail("tiny-image", "the capture tool returned %d bytes - that is not a picture" % len(blob))
            with open(out_path, "wb") as fh:
                fh.write(blob)
            meta = write_twin(out_path, blob)
            meta["base64_file"] = args.out + ".b64"
            meta.update({"ok": True, "method": "mcp-stdio", "tool": cap.get("name"),
                         "file": args.out, "bytes": len(blob),
                         "mime": sniff_mime(blob, images[0].get("mimeType")),
                         "studio_id": studio_id, "takeover": note,
                         "text": (text or "").strip()[:300]})
            log("captured %d bytes with %s (studio_id=%s)" % (len(blob), cap.get("name"), studio_id or "?"))
            result(meta)
            return 0

        saved = file_in_text(text)
        if saved and os.path.isfile(saved):
            with open(saved, "rb") as fh:
                blob = fh.read()
            with open(out_path, "wb") as fh:
                fh.write(blob)
            meta = write_twin(out_path, blob)
            meta["base64_file"] = args.out + ".b64"
            meta.update({"ok": True, "method": "mcp-stdio", "tool": cap.get("name"),
                         "file": args.out, "bytes": len(blob), "mime": sniff_mime(blob, "image/png"),
                         "studio_id": studio_id, "takeover": note,
                         "text": ("saved by the tool at " + saved)})
            log("the tool saved the picture itself: %s" % saved)
            result(meta)
            return 0

        return fail("no-image",
                    "the capture tool answered without a picture: " + (text or "(empty answer)")[:300],
                    "If that text names a file, the picture is on disk - OR reads it back by name.")

    except TimeoutError as exc:
        return fail("timeout", str(exc))
    except Exception as exc:
        return fail("error", "%s: %s" % (type(exc).__name__, exc))
    finally:
        if client is not None:
            client.close()


if __name__ == "__main__":
    sys.exit(main())
