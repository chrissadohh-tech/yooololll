#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""End-to-end test for or_mcp_shot.py (the ZeroScript-style capture carrier).

Roblox Studio cannot run in CI, so the *server* side is faked: a tiny program that
speaks the same JSON-RPC over stdio (initialize / tools/list / tools/call) and returns
the same shape of answer Studio's MCP server does - text parts AND an image part.
or_mcp_shot.py is then run against it exactly as it runs on the user's PC.

What this proves: the handshake, the schema-driven argument filling, the CONNECTED
studio_id lookup, the stale-id retry, the image extraction, the PNG + .b64 twin on
disk, the checksum in the machine-readable line, and that every failure mode ends in a
machine-readable answer instead of hanging.

Run:  python3 test-mcp-helper.py
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
HELPER = os.path.join(HERE, "or_mcp_shot.py")
PY = sys.executable or "python3"

passed = 0
failed = 0


def ok(name, cond, detail=""):
    global passed, failed
    if cond:
        passed += 1
        print("PASS  " + name)
    else:
        failed += 1
        print("FAIL  " + name + (("  -> " + str(detail)[:300]) if detail else ""))


# ── the fake Studio MCP server (what StudioMCP.exe would be) ─────────────────
FAKE = r'''#!/usr/bin/env python3
import base64, json, os, sys, time

MODE = os.environ.get("FAKE_MODE", "success")

# a real 1x1 PNG, so the bytes that come out are a picture, not noise
PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/AF+7E1mAAAAAElFTkSuQmCC")


def send(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


TOOLS = [
    {"name": "workspace_info", "inputSchema": {"type": "object", "properties": {}}},
    {"name": "list_roblox_studios", "inputSchema": {"type": "object", "properties": {}}},
    {"name": "screen_capture", "inputSchema": {
        "type": "object",
        "properties": {"capture_id": {"type": "string", "description": "identifier"},
                       "studio_id": {"type": "string", "description": "the connected Studio"}},
        "required": ["capture_id", "studio_id"]}},
]
calls = {"capture": 0, "list": 0}

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        msg = json.loads(line)
    except Exception:
        continue
    method = msg.get("method")
    if method == "initialize":
        send({"jsonrpc": "2.0", "id": msg.get("id"), "result": {
            "protocolVersion": "2024-11-05", "capabilities": {},
            "serverInfo": {"name": "fake-studio-mcp", "version": "1"}}})
    elif method in ("notifications/initialized", "notifications/cancelled"):
        continue
    elif method == "tools/list":
        if MODE == "hang":
            time.sleep(600)
            continue
        send({"jsonrpc": "2.0", "id": msg.get("id"), "result": {"tools": [] if MODE == "empty" else TOOLS}})
    elif method == "tools/call":
        name = (msg.get("params") or {}).get("name")
        a = (msg.get("params") or {}).get("arguments") or {}
        if name == "list_roblox_studios":
            calls["list"] += 1
            # In "stale" mode the FIRST lookup hands out an id that has already gone
            # (the hub was restarted); the next lookup - the one a stale-id error sends
            # the client back for - gives the live one.
            sid = "st_fake_old" if (MODE == "stale" and calls["list"] == 1) else "st_fake42"
            send({"jsonrpc": "2.0", "id": msg.get("id"), "result": {"content": [
                {"type": "text", "text": json.dumps({"studios": [{"studio_id": sid, "name": "OR Test", "connected": True}]})}]}})
        elif name == "screen_capture":
            calls["capture"] += 1
            if not a.get("capture_id"):
                send({"jsonrpc": "2.0", "id": msg.get("id"), "error": {"message": "Missing required argument: capture_id"}})
                continue
            if a.get("studio_id") != "st_fake42":
                send({"jsonrpc": "2.0", "id": msg.get("id"), "error": {"message":
                    "The requested `studio_id` is not connected - that Roblox Studio instance may have been "
                    "closed or its place unloaded. Call list_roblox_studios for the current list."}})
                continue
            send({"jsonrpc": "2.0", "id": msg.get("id"), "result": {"content": [
                {"type": "text", "text": "Captured viewport at 1920x1080"},
                {"type": "image", "data": base64.b64encode(PNG).decode("ascii"), "mimeType": "image/png"}]}})
        else:
            send({"jsonrpc": "2.0", "id": msg.get("id"), "error": {"message": "unknown tool: %s" % name}})
'''


def run_helper(exe_path, mode, extra=None, timeout=40, out="or_mcp_shot.png", cwd=None):
    env = dict(os.environ)
    env["OR_STUDIO_MCP_PATH"] = exe_path
    env["FAKE_MODE"] = mode
    cmd = [PY, HELPER, "--out", out] + list(extra or [])
    t0 = time.time()
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, env=env, cwd=cwd)
        out_text, code = proc.stdout + proc.stderr, proc.returncode
    except subprocess.TimeoutExpired as exc:
        out_text, code = (exc.stdout or "") + "\n[the helper itself had to be killed]", "KILLED"
    return out_text, code, time.time() - t0


def meta_of(text):
    hits = re.findall(r"OR_STUDIO_SHOT\s+(\{.*\})", text or "")
    if not hits:
        return None
    body = hits[-1]
    depth, end, instr, esc = 0, -1, False, False
    for i, ch in enumerate(body):
        if esc:
            esc = False
            continue
        if ch == "\\":
            esc = True
            continue
        if ch == '"':
            instr = not instr
            continue
        if instr:
            continue
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                end = i + 1
                break
    try:
        return json.loads(body[:end] if end > 0 else body)
    except Exception:
        return None


def main():
    tmp = tempfile.mkdtemp(prefix="or-mcp-helper-")
    fake = os.path.join(tmp, "StudioMCP.exe")
    with open(fake, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(FAKE)
    os.chmod(fake, os.stat(fake).st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)

    # ── the happy path: handshake, id lookup, capture, file on disk ───────────
    out_name = os.path.join(tmp, "or_mcp_shot.png")
    text, code, secs = run_helper(fake, "success", out=out_name)
    meta = meta_of(text)
    ok("the helper talks to Studio's MCP and reports a picture", code == 0 and meta and meta.get("ok") is True, text[-400:])
    ok("...and it used the tool's own name for the capture", bool(meta and meta.get("tool") == "screen_capture"), meta)
    ok("...and it looked the CONNECTED studio id up (never invented one)", bool(meta and meta.get("studio_id") == "st_fake42"), meta)
    ok("...and the PNG really is on disk", os.path.isfile(out_name), out_name)
    blob = open(out_name, "rb").read() if os.path.isfile(out_name) else b""
    ok("...and the bytes are a PNG", blob[:8] == b"\x89PNG\r\n\x1a\n", blob[:8])
    ok("...and the reported size matches the file", bool(meta and meta.get("bytes") == len(blob)), (meta or {}).get("bytes"))
    ok("...and the reported checksum matches the file",
       bool(meta and meta.get("sha256") == hashlib.sha256(blob).hexdigest()), (meta or {}).get("sha256"))
    ok("...and the mime type comes from the bytes", bool(meta and meta.get("mime") == "image/png"), (meta or {}).get("mime"))
    twin = os.path.join(tmp, "or_mcp_shot.png.b64")
    ok("...and a .b64 twin was written for the text read-back", os.path.isfile(twin), twin)
    if os.path.isfile(twin):
        lines = [l for l in open(twin, encoding="utf-8").read().split("\n") if l]
        b64 = "".join(lines)
        ok("...with 400-character lines (what the paged reader expects)", all(len(l) <= 400 for l in lines), [len(l) for l in lines][:4])
        ok("...and the reported base64 length matches the twin", bool(meta and meta.get("base64_chars") == len(b64)), (meta or {}).get("base64_chars"))
        ok("...and decoding the twin gives back the same bytes", base64.b64decode(b64) == blob)
    ok("...and it finished quickly (no waiting around)", secs < 20, "%.1fs" % secs)

    # ── a stale id is refreshed ONCE, from the server's own hint ──────────────
    text, code, _ = run_helper(fake, "stale", out=os.path.join(tmp, "stale.png"))
    meta = meta_of(text)
    ok("a stale studio_id is refreshed and the capture still lands", code == 0 and meta and meta.get("ok") is True, text[-400:])
    ok("...after exactly one refusal and one retry, never a loop", text.count("calling screen_capture") == 2, text[-400:])
    ok("...and the retry used the FRESH id the second lookup returned", "st_fake42" in text and "st_fake_old" in text, text[-400:])

    # ── selftest: diagnose without taking a picture ──────────────────────────
    text, code, _ = run_helper(fake, "success", extra=["--selftest"], out=os.path.join(tmp, "nope.png"))
    meta = meta_of(text)
    ok("the self-test reports the tools and the capture tool's schema",
       code == 0 and meta and meta.get("selftest") is True and "screen_capture" in (meta.get("tools") or []), text[-400:])
    ok("...and it takes no picture", not os.path.isfile(os.path.join(tmp, "nope.png")))

    # ── failure modes end in a machine-readable answer, never a hang ─────────
    text, code, _ = run_helper(os.path.join(tmp, "missing-StudioMCP.exe"), "success")
    meta = meta_of(text)
    ok("a missing StudioMCP.exe is reported by name, with the folder it looked in",
       code != 0 and meta and meta.get("stage") == "find-studiomcp" and
       "StudioMCP.exe" in str(meta.get("error")) and "Versions" in str(meta.get("error")) and
       "Open Roblox Studio" in str(meta.get("hint")), text[-300:])

    text, code, _ = run_helper(fake, "empty", extra=["--timeout", "8"], out=os.path.join(tmp, "nope2.png"))
    meta = meta_of(text)
    ok("Studio open with no place loaded is explained (no tools yet)",
       code != 0 and meta and meta.get("stage") == "no-tools" and "load a place" in str(meta.get("hint")), text[-300:])

    text, code, secs = run_helper(fake, "hang", extra=["--timeout", "4"], out=os.path.join(tmp, "nope3.png"), timeout=30)
    meta = meta_of(text)
    ok("an MCP server that never answers is cut off by the deadline",
       code == 3 and meta and meta.get("stage") == "timeout" and secs < 25, "%s in %.1fs" % (code, secs))

    shutil.rmtree(tmp, ignore_errors=True)
    print("\n%d PASS / %d FAIL" % (passed, failed))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
