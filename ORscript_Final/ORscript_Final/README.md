# OR — Roblox Studio + AgentScript AI agent

Turn any major AI chat (**DeepSeek, ChatGPT, Google Gemini, Kimi, GLM, Qwen, Arena, Meta AI, GitHub Copilot, Crax GPT, or Ollama running locally**) into an autonomous development agent. Three switchable engines:

| Engine | Toggle | Target | Port |
|---|---|---|---|
| **Roblox** (RS) | — | Roblox Studio via its built-in MCP server | ws://127.0.0.1:17613 |
| **AgentScript** (AS) | — | A local project folder — files + terminal | ws://127.0.0.1:17615 |
| **Animation** (AN) | — | Roblox Studio scoped to the motion workflow | ws://127.0.0.1:17613 |

Describe what you want in plain English and the AI builds instances, writes Luau/code files, sculpts terrain, tunes lighting, generates UI, runs builds and tests, and audits your project — inside Studio or directly on disk.

No API keys, no monthly fees. Chromium browsers (Chrome, Brave, Edge, Thorium). Theme is black/white outlines.

---

## Engines

- The bar above every supported chat composer carries a segmented **RS / AS / AN** toggle. Switching engines wipes tool caches so commands cannot cross engines.
- **RS** drives Roblox Studio through StudioMCP (stdio JSON-RPC spawned by `or-agent`).
- **AS** gives the AI full control of ONE local folder ("the workspace") through native Rust tools — sandboxed paths, exact-match diff editing, glob/content search, and terminal execution with hard timeouts.
- **AN** rides the same Roblox bridge as RS but steers the system prompt into the animation_* workflow.

Large `execute_luau` scripts are auto-chunked around 24 KB so Studio's parser never hits the ~64 KB wall. Each chunk is still one NDJSON/JSON-RPC line.

---

## Setup

1. Open `chrome://extensions` → Developer mode → **Load unpacked** → this folder (`manifest.json`).
2. Double-click **`or-agent.exe`** (or `or-agent --headless`). It starts:
   - HTTP API on `http://127.0.0.1:3000`
   - WS bridges on `17613` (RS/AN) and `17615` (AS)
   - Workspace folder for AgentScript (`OR_WORKSPACE_ROOT` / `--workspace` / `%USERPROFILE%\ORWorkspace`)
3. **RS/AN:** Roblox Studio → Assistant AI → ⋯ → Manage MCP Servers → Enable Studio as MCP Server.
4. Open a supported chat and click **Start agent**.

---

## Agent

- Native crate: `agent/` (`or-agent` 1.13.0). Status window, MCP helper spawn, outbound WS channel so ping/status keep flowing during a 20 s `execute_luau`.
- Service worker skips stale-socket reconnect and MCP heal while a `call_tool` is in flight (the 25 s stale window used to kill long tools).
- 30 Studio skills, a 24-command animation suite, AgentScript file/terminal tools.
- Personas (Builder / Scripter / Animator / Fixer), Extra Thinking, Forge GUI, Image → Model, auto-fix playtest errors.

---

## Testing

```bash
node test-skills.js
node test-parser.js
node test-chatgpt.js
node test-animlib.js
node test-v111.js
node test-v112.js
node test-v115.js
node test-shots.js
node --check core/main.js && node --check core/config.js && node --check background.js
cd agent && cargo test
```

`test-bridges.js` is a live smoke test: start `or-agent` first.

`test-shots.js` needs no browser and no Studio: it loads the real `core/main.js` with the real
`background.js` behind a fake DOM and drives the screenshot command's three targets
(`or_screenshot` for `studio` / `blender` / `desktop`), the internal fallback routes
(`_route:"window"|"tab"|"auto"`), `attach_feedback` with its aliases, and `shot_test`, through the
`window.__rsRunTool` seam. A scope bug like the one that
broke every screenshot with `Cannot access 'RECENT_IMAGES_MAX' before initialization` shows up here
in under a second, where `node --check` cannot see it. It checks HTTP `:3000` and WS `17613` / `17615` (no Unreal port).

## Screenshots (and what needs what)

Check the machinery before blaming a command: **`shot_test {}`** writes a small test picture
through the capture script, reads it back exactly the way a real screenshot is handed over, and
verifies the checksum. It needs no Studio window. `agent_info {}` reports which `or-agent.exe`
is running and which hand-over is in use.

**The three screenshots — one command, three targets, no aliases:**

```
or_screenshot {}  (or {"target":"studio"})   a picture taken INSIDE Roblox Studio  - Studio just has to be open
or_screenshot {"target":"blender"}           a picture taken INSIDE Blender        - Blender just has to be open
or_screenshot {"target":"desktop"}           a picture of the WHOLE PC             - every monitor, no Studio needed
```

That is the entire screenshot surface. There is no `screenshot`, `take_screenshot`, `send_screenshot`,
`capture_screenshot`, `screen_capture`, `window`, `tab` or `auto` command, and `or_screenshot` has no
aliases: ask for anything else and OR answers with the three it has instead of quietly taking a
different picture. `shot_test {}` is a diagnostic (it takes no picture of Studio); `attach_feedback`
re-sends or copies a picture that already exists.

The removed names are not just undocumented, they are **refused by name**: calling
`screenshot`, `take_screenshot`, `send_screenshot` or the old `or_focus_studio` family returns an
instant error naming the three real targets. It never falls through to a capture, and it never
hangs waiting for an answer that was never coming.

| target | what it does | if it cannot |
| --- | --- | --- |
| `studio` (default) | **Studio takes its own picture** through its MCP (`screen_capture`) — no window, no focus, no PowerShell. The browser being in front or behind makes no difference; Blender parity is the goal | falls back to photographing the Studio **window** through the agent, which also never needs a window in front |
| `blender` | the Blender viewport, captured inside Blender by the addon | falls back to the Blender window through the agent |
| `desktop` | the whole desktop, every monitor, grabbed from the screen itself | nothing to fall back to — it either grabs the screen or says why |

**Which window is in front never matters.** None of the three raises or focuses a window, and
`or_screenshot {target:"desktop"}` photographs the desktop exactly as it looks, Studio open or not.

**Fallbacks are automatic and internal.** The `window` / `tab` routes still exist behind these three
(the `tab` route photographs whatever is in front, and `chrome://` pages, the New Tab page and PDFs
can never be captured). They are reachable for tests as `_route:"window"|"tab"|"auto"` - they are not
commands, and the model is told not to call them.

**How the picture gets here.** Studio's MCP may hand its capture over in any of three shapes and OR
accepts all of them: an MCP **image block**, a **file path** (the server saved the PNG — OR reads that
file back as base64 text), or **base64 text** in the answer. If the tool's own schema offers a
`save_path`-style argument, OR asks for the file once and reads that. Image blocks need an agent build
with image support; the other two work on the current exe with no rebuild. Whichever way it arrived,
the answer says so.

**The base64 text tunnel.** Handing a file to the browser normally needs the agent's
`read_file_base64` (1.18.0+). An older `or-agent.exe` — including the prebuilt one in this repo,
which lists 18 tools and everything but that — still has `read_file` and `run_command`, so
`studio_shot.ps1` also writes the capture as `<file>.b64` and OR reads it back in chunks of
numbered lines, then checks the byte count and SHA-256 before attaching anything. A picture that
was cut short or damaged is refused with the reason, never attached silently. Rebuilding the agent
(`cd agent && cargo build --release`) is therefore an optimisation, not a requirement.

## Privacy

Everything runs locally. The extension talks only to `127.0.0.1`. No telemetry. AgentScript stays inside the workspace root unless you flip FULL ACCESS.
