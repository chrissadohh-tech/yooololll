// OR screenshot-path harness (run: node test-shots.js). Not shipped.
//
// WHY THIS EXISTS: a grep-based test cannot see SCOPE. The 2026-09 regression
// ("Cannot access 'RECENT_IMAGES_MAX' before initialization" killing every
// or_screenshot / attach_feedback call) was invisible to every static check in
// test-v118.js, because the helper block had been inserted INSIDE runTool() where
// its `const` was in the temporal dead zone for the branches declared above it.
// So this file LOADS the real core/main.js in a VM (with a fake DOM and the real
// background.js behind chrome.runtime.sendMessage) and then CALLS every
// screenshot command through the page seam, asserting what comes back.
const fs = require("fs");
const path = require("path");
const vm = require("vm");

let failed = 0;
const ok = (name, cond, extra) => {
  console.log((cond ? "PASS" : "FAIL") + "  " + name + (cond || extra === undefined ? "" : "  → " + String(extra).slice(0, 300)));
  if (!cond) failed++;
};

const root = __dirname;
const bgSrc = fs.readFileSync(path.join(root, "background.js"), "utf8");
const cfgSrc = fs.readFileSync(path.join(root, "core/config.js"), "utf8");
const mainSrc = fs.readFileSync(path.join(root, "core/main.js"), "utf8");

// ── fake DOM: only what main.js touches, deliberately dumb ──────────────────
// OR's OWN UI selectors (and the composer anchor it attaches to). Everything the
// core looks up by these must resolve; anything else (chat-site markup) must not,
// so the harness stays honest about what the page provides.
const orSelector = (sel) => /^([#.]rs-|\[data-rs|#or-|\[class\*=rs-|\[id\^=rs-|#bar|#composer|\[class\*=or-|#rs)/.test(String(sel));

function makeEl(tag) {
  const el = {
    tagName: (tag || "div").toUpperCase(),
    children: [], childNodes: [], style: {}, dataset: {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    _text: "", _html: "",
    get textContent() { return this._text; }, set textContent(v) { this._text = String(v); },
    get innerHTML() { return this._html; }, set innerHTML(v) { this._html = String(v); },
    get outerHTML() { return this._html; },
    appendChild(c) { this.children.push(c); return c; },
    append(...c) { this.children.push(...c); },
    prepend(c) { this.children.unshift(c); return c; },
    insertBefore(c) { this.children.unshift(c); return c; },
    removeChild(c) { this.children = this.children.filter((x) => x !== c); return c; },
    remove() {}, replaceWith() {}, removeAttribute() {}, setAttribute() {}, getAttribute: () => null,
    hasAttribute: () => false, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => true,
    querySelector: (sel) => (orSelector(sel) ? makeEl() : null), querySelectorAll: (sel) => (orSelector(sel) ? [makeEl()] : []),
    closest: () => null, contains: () => false,
    getElementsByClassName: () => [], getElementsByTagName: () => [], getElementById: (id) => (String(id).startsWith("rs") ? makeEl() : null),
    focus() {}, blur() {}, click() {}, scrollIntoView() {}, getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 100, height: 20 }),
    getClientRects: () => [], insertAdjacentHTML() {}, insertAdjacentElement() {}, cloneNode() { return makeEl(tag); },
    animate: () => ({ cancel() {}, finished: Promise.resolve() }), attachShadow() { return makeEl("shadow"); },
  };
  return el;
}
function makeDoc() {
  const body = makeEl("body");
  const head = makeEl("head");
  const doc = {
    documentElement: makeEl("html"), body, head, title: "test",
    hidden: false, visibilityState: "visible", readyState: "complete", cookie: "",
    createElement: (t) => makeEl(t),
    createElementNS: (_ns, t) => makeEl(t),
    createTextNode: (t) => ({ textContent: String(t) }),
    createDocumentFragment: () => makeEl("fragment"),
    // OR's OWN UI selectors must resolve (main.js creates and then re-finds its
    // panel/bar); anything else stays null, exactly like a chat page with no OR
    // UI in it. Returning null for OR's own nodes is what tripped the load with
    // "Cannot read properties of null (reading 'classList')".
    // OR's own UI + the composer anchor it hangs off (the provider supplies
    // barAnchor() in the real world; the stub returns null, so the core falls
    // back to a page query for the bar - give it a node).
    querySelector: (sel) => (orSelector(sel) ? makeEl() : null),
    querySelectorAll: (sel) => (orSelector(sel) ? [makeEl()] : []),
    getElementById: (id) => (String(id).startsWith("rs") || String(id).startsWith("or-") ? makeEl() : null),
    getElementsByClassName: () => [],
    getElementsByTagName: () => [],
    addEventListener() {}, removeEventListener() {}, dispatchEvent: () => true,
    elementFromPoint: () => null,
  };
  return doc;
}
function makeWindow(doc) {
  const win = {
    document: doc, location: { href: "https://chat.deepseek.com/", hostname: "chat.deepseek.com", pathname: "/", origin: "https://chat.deepseek.com", search: "" },
    innerWidth: 1280, innerHeight: 800, devicePixelRatio: 1, navigator: { userAgent: "Mozilla/5.0 Chrome/128", clipboard: { write: async () => {} } },
    addEventListener() {}, removeEventListener() {}, dispatchEvent: () => true,
    setTimeout, clearTimeout, setInterval: (fn, ms) => setInterval(fn, ms), clearInterval,
    requestAnimationFrame: (fn) => setTimeout(() => fn(Date.now()), 0), cancelAnimationFrame: clearTimeout,
    getComputedStyle: () => ({ getPropertyValue: () => "", display: "block", visibility: "visible", opacity: "1" }),
    matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
    MutationObserver: class { observe() {} disconnect() {} takeRecords() { return []; } },
    ResizeObserver: class { observe() {} disconnect() {} },
    IntersectionObserver: class { observe() {} disconnect() {} },
    requestIdleCallback: (fn) => setTimeout(fn, 0), cancelIdleCallback: clearTimeout,
    postMessage() {}, open: () => null, focus() {}, scrollTo() {}, getSelection: () => ({ toString: () => "" }),
    atob, btoa, crypto: require("crypto").webcrypto, Blob: class { constructor(p) { this.parts = p; } }, File: class { constructor(p, n, o) { this.parts = p; this.name = n; this.type = (o || {}).type; } },
    DataTransfer: class { constructor() { this.items = { add() {}, length: 0 }; this.files = []; } },
    ClipboardItem: class { constructor(o) { Object.assign(this, o); } },
    Image: class { set src(_v) {} },
    createImageBitmap: async () => ({ width: 640, height: 480 }),
    HTMLTextAreaElement: class {}, HTMLInputElement: class {}, HTMLElement: class {}, Node: class {},
    CustomEvent: class { constructor(t, o) { this.type = t; Object.assign(this, o || {}); } },
    Event: class { constructor(t, o) { this.type = t; Object.assign(this, o || {}); } },
    KeyboardEvent: class { constructor(t, o) { this.type = t; Object.assign(this, o || {}); } },
    MouseEvent: class { constructor(t, o) { this.type = t; Object.assign(this, o || {}); } },
    ClipboardEvent: class { constructor(t, o) { this.type = t; Object.assign(this, o || {}); } },
    AbortController, URL, TextDecoder, TextEncoder, Promise, Math, Date, JSON, Object, Array, String, Number, Boolean, RegExp, Error, Map, Set, WeakMap, Symbol,
    console,
  };
  win.window = win; win.self = win; win.globalThis = win; win.top = win; win.parent = win;
  return win;
}


// ── a FAKE or-agent.exe ────────────────────────────────────────────────────
// Deliberately the build the user actually runs: 18 tools, read_file_base64
// MISSING. It speaks the real bridge protocol ({"type":"tool_result",...}) over a
// paired in-memory WebSocket, has a virtual workspace, and its read_file numbers
// lines and CLIPS the reply the way agent/src/workspace.rs does - so the chunked
// text tunnel is exercised for real, including the self-healing on a clipped page.
const crypto = require("crypto");
function makeFakeAgent(opts) {
  const o = opts || {};
  const OLD_TOOLS = ["workspace_info", "list_directory", "tree", "read_file", "write_file", "edit_file",
    "create_folder", "delete_path", "move_path", "search_files", "grep_files", "run_command",
    "file_info", "env_info", "process_list", "process_kill", "open_path", "download_file"];
  const clipChars = o.clipChars || 40000;     // MAX_TEXT_CHARS in workspace.rs
  const files = o.files || Object.create(null);
  const state = { calls: [], connected: 0 };
  // A deterministic ~90 KB "JPEG": big enough to need several read_file pages.
  const shotBytes = Buffer.alloc(90 * 1024);
  for (let i = 0; i < shotBytes.length; i++) shotBytes[i] = (i * 31 + 7) & 0xff;
  files["or_studio_window.jpg"] = shotBytes;                       // what the ps1 writes
  files["or_studio_window.jpg.b64"] = Buffer.from(shotBytes.toString("base64"), "utf8");
  // Damage the file AT READ TIME: a fresh capture rewrites the .b64 twin, so
  // corrupting it up front would be silently repaired by the capture itself.
  const damage = { on: false, hide: false };
  state.noCompile = false;                 // the fast helper could not be compiled on this PC
  state.captureFails = false;              // the capture step itself threw
  state.trailingNoise = false;             // PowerShell printed something after the result line
  state.selftestBroken = false;            // PowerShell/GDI failure
  state.selftestBadRoundtrip = false;      // the script cannot decode its own tunnel text
  state.maxReadBytes = 0;                 // 0 = no limit; set to model the agent's 2 MB cap
  state.smallPayload = false;             // true after a -MaxWidth <= 1100 re-capture
  state.corruptOnRead = () => { damage.on = true; };
  state.hideB64OnRead = () => { damage.hide = true; };
  const base = (p) => String(p || "").split(/[\\/]/).pop();
  const resolve = (p) => { const b = base(p); return files[b] ? b : (files[p] ? p : null); };
  const reply = (sock, obj) => { try { sock.__toClient(JSON.stringify(obj)); } catch {} };
  const handle = (sock, msg) => {
    if (!msg || typeof msg !== "object") return;
    const { id, type, name, arguments: a } = msg;
    if (type === "list_tools") { reply(sock, { type: "tools", id, ok: true, tools: OLD_TOOLS.map((n) => ({ name: n })) }); return; }
    if (type !== "call_tool") return;
    state.calls.push(name);
    const okText = (text) => reply(sock, { type: "tool_result", id, ok: true, text });
    const fail = (error) => reply(sock, { type: "tool_result", id, ok: false, error });
    if (name === "read_file_base64") { fail("unknown tool: read_file_base64"); return; }   // THE OLD EXE
    if (name === "write_file") { files[a.path] = Buffer.from(String(a.content || ""), "utf8"); okText("wrote " + a.path); return; }
    if (name === "run_command" && /-SelfTest/.test(String(a.command || ""))) {
      const selftest = Buffer.alloc(1500);
      for (let i = 0; i < selftest.length; i++) selftest[i] = (i * 17 + 3) & 0xff;
      files["or_shot_selftest.jpg"] = selftest;
      const b64 = selftest.toString("base64");
      const body = b64.match(/.{1,400}/g).join("\n") + "\n";
      files["or_shot_selftest.jpg.b64"] = Buffer.from(body, "utf8");
      if (state.selftestBroken) { okText("OR_STUDIO_SHOT " + JSON.stringify({ ok: false, selftest: true, error: "self-test failed: A generic error occurred in GDI+" })); return; }
      okText("OR_STUDIO_SHOT " + JSON.stringify({ ok: true, selftest: true, file: "or_shot_selftest.jpg", bytes: selftest.length, mime: "image/jpeg",
        base64_file: "or_shot_selftest.jpg.b64", base64_chars: b64.length, base64_lines: b64.length / 400,
        sha256: crypto.createHash("sha256").update(selftest).digest("hex"), roundtrip_ok: !state.selftestBadRoundtrip, jpeg_ok: true, tunnel_error: "" }));
      return;
    }
    if (name === "run_command" && /9876/.test(String(a.command || ""))) { okText("BLENDER_UP"); return; }   // the Blender addon's port answers
    if (name === "run_command" && /blender_once\.(py|ps1)/.test(String(a.command || ""))) {
      const bpng = Buffer.alloc(45 * 1024);
      for (let i = 0; i < bpng.length; i++) bpng[i] = (i * 7 + 11) & 0xff;
      files["or_blender_shot.png"] = bpng;
      files["or_blender_out.json"] = Buffer.from(JSON.stringify({ status: "ok", result: { ok: true, filepath: "or_blender_shot.png", width: 1280, height: 720 } }), "utf8");
      okText("OR_BLENDER_OK");
      return;
    }
    if (name === "run_command" && /-B64Only/.test(String(a.command || ""))) {
      const fm = String(a.command || "").match(/-B64Only\s+"?([^"\s]+)"?/);
      const target = resolve(fm ? fm[1] : "");
      const data = target ? files[target] : null;
      if (!data) { okText("OR_STUDIO_SHOT " + JSON.stringify({ ok: false, b64_only: true, error: "no such file: " + target })); return; }
      const b64 = data.toString("base64");
      files[target + ".b64"] = Buffer.from(b64.match(/.{1,400}/g).join("\n") + "\n", "utf8");
      okText("OR_STUDIO_SHOT " + JSON.stringify({ ok: true, b64_only: true, file: target, bytes: data.length, mime: /png$/.test(target) ? "image/png" : "image/jpeg",
        base64_file: target + ".b64", base64_chars: b64.length, base64_lines: b64.length / 400,
        sha256: crypto.createHash("sha256").update(data).digest("hex"), tunnel_error: "" }));
      return;
    }
    if (name === "run_command") {
      const m = String(a.command || "").match(/-Out\s+(\S+)/);
      const out = m ? m[1].replace(/\.png$/i, ".jpg") : "or_studio_window.jpg";
      const wm = String(a.command || "").match(/-MaxWidth\s+(\d+)/);
      if (wm && Number(wm[1]) <= 1100) state.smallPayload = true;      // the retake is smaller
      const bytes = files[out] || (state.smallPayload ? Buffer.alloc(20 * 1024) : shotBytes);
      if (state.smallPayload && !files["__small__"]) { files[out] = Buffer.alloc(20 * 1024); files["__small__"] = Buffer.from("x"); }
      const real = files[out] || bytes;
      const b64 = real.toString("base64");
      const lines = [];
      for (let i = 0; i < b64.length; i += 400) lines.push(b64.slice(i, i + 400));
      files[out + ".b64"] = Buffer.from(lines.join("\n") + "\n", "utf8");
      if (state.captureFails) { okText("OR_STUDIO_SHOT " + JSON.stringify({ ok: false, error: "the capture step failed: Exception calling CopyFromScreen with 5 argument(s)", route: "no-compile", compile_error: "Add-Type: could not load file or assembly System.CodeDom", code: 3 })); return; }
      const meta = { ok: true, file: out, bytes: real.length, method: state.noCompile ? "screen-nocompile" : "printwindow", focused: false,
        window: { process: "RobloxStudioBeta", pid: 4242, width: 1280, height: 800 },
        base64_file: out + ".b64", base64_chars: b64.length, base64_lines: lines.length,
        sha256: crypto.createHash("sha256").update(real).digest("hex"), mime: "image/jpeg" };
      if (state.noCompile) meta.compile_error = "Add-Type: could not load file or assembly System.CodeDom";
      okText("OR_STUDIO_SHOT " + JSON.stringify(meta) + (state.trailingNoise ? "\nWARNING: something harmless printed after the result line" : ""));
      return;
    }
    if (name === "read_file") {
      if (damage.hide && /b64$/.test(String(a.path))) { fail("no such file: " + a.path); return; }
      const key = resolve(a.path);
      let data = key ? files[key] : null;
      // The real agent refuses any file over MAX_READ_BYTES (2 MB) with this wording.
      if (data && state.maxReadBytes && data.length > state.maxReadBytes) {
        fail("'" + a.path + "' is " + (data.length / 1024).toFixed(1) + " KB - too large to read whole (limit 2.0 MB). Read it in parts with offset/limit if you really need to.");
        return;
      }
      if (!data) { fail("no such file: " + a.path); return; }
      let all = data.toString("utf8");
      if (damage.on && /b64$/.test(String(a.path))) {
        const mid = Math.floor(all.length / 2);
        all = all.slice(0, mid) + (all[mid] === "A" ? "B" : "A") + all.slice(mid + 1);   // one wrong character
      }
      const arr = all.split("\n"); if (arr.length > 1 && arr[arr.length - 1] === "") arr.pop();
      const start = Math.max(1, Number(a.offset) || 1);
      const limit = Math.min(4000, Math.max(1, Number(a.limit) || 2000));
      const page = arr.slice(start - 1, start - 1 + limit);
      const header = a.path + "  (" + arr.length + " lines)";
      if (!page.length) { okText(header + "\n(no lines in range " + start + "-" + (start + limit - 1) + ")"); return; }
      let body = header + "\n" + page.map((l, i) => String(start + i).padStart(5) + " | " + l).join("\n");
      const end = start - 1 + page.length;
      if (end < arr.length) body += "\n... lines " + (end + 1) + "-" + arr.length + " continue (use offset=" + (end + 1) + ")";
      if (body.length > clipChars) body = body.slice(0, clipChars) + "\n... [output truncated at " + clipChars + " characters]";
      okText(body);
      return;
    }
    if (name === "screen_capture") { okText("screen capture taken (this build drops image blocks)"); return; }
    if (name === "list_directory") { okText("(1 entry)\n" + Object.keys(files).join("\n")); return; }
    okText("ok: " + name);
  };
  // one paired socket per connection attempt, like a real server
  state.openSocket = () => {
    const client = { readyState: 0, onopen: null, onmessage: null, onerror: null, onclose: null,
      send(str) { let m = null; try { m = JSON.parse(str); } catch {} setTimeout(() => handle(this, m), 0); },
      close() { this.readyState = 3; } };
    const toClient = (str) => setTimeout(() => { try { client.onmessage && client.onmessage({ data: str }); } catch {} }, 0);
    client.__toClient = toClient;
    setTimeout(() => {
      client.readyState = 1;
      try { client.onopen && client.onopen(); } catch {}
      state.connected++;
      toClient(JSON.stringify({ type: "connected", workspace_root: "C:\\OR-workspace", tools: OLD_TOOLS.map((n) => ({ name: n })) }));
    }, 1);
    return client;
  };
  return state;
}

// ── the bridge: real background.js behind a chrome.runtime mock ─────────────
function makeBridge(engine) {
  const listeners = [];
  const chromeStub = {
    runtime: {
      id: "or-test",
      onMessage: { addListener: (fn) => listeners.push(fn) },
      // Callback form AND promise form: MV3's sendMessage returns a promise when no
      // callback is passed, and the worker calls .catch() on it in several places.
      sendMessage: (msg, cb) => {
        let answer = { ok: false, error: "no background listener" };
        const respond = (r) => { answer = r === undefined ? { ok: false } : r; try { cb && cb(answer); } catch {} };
        const hit = listeners.find(Boolean);
        if (hit) {
          try { hit(msg, { tab: { id: 7, url: "https://chat.deepseek.com/", windowId: 1 } }, respond); }
          catch (e) { respond({ ok: false, error: String(e && e.message || e) }); }
        }
        if (typeof cb === "function") return undefined;
        return Promise.resolve(answer);
      },
      getURL: (p) => "chrome-extension://or-test/" + p,
      getPlatformInfo: () => Promise.resolve({ os: "win", arch: "x86-64" }),
      onStartup: { addListener() {} }, onInstalled: { addListener() {} }, lastError: null,
      getManifest: () => ({ version: "1.18.0", name: "OR (test)" }),
      getContexts: () => Promise.resolve([]),
      onConnect: { addListener() {} }, connect: () => ({ postMessage() {}, onMessage: { addListener() {} }, disconnect() {} }),
    },
    i18n: { getMessage: (k) => k },
    permissions: { contains: () => Promise.resolve(true), request: () => Promise.resolve(true), onAdded: { addListener() {} } },
    scripting: { executeScript: () => Promise.resolve([]), insertCSS: () => Promise.resolve() },
    windows: { getCurrent: () => Promise.resolve({ id: 1 }), update: () => Promise.resolve() },
    action: { setBadgeText() {}, setBadgeBackgroundColor() {}, setTitle() {}, onClicked: { addListener() {} } },
    alarms: { create() {}, clear: () => Promise.resolve(), onAlarm: { addListener() {} } },
    contextMenus: { create() {}, removeAll: () => Promise.resolve(), onClicked: { addListener() {} } },
    commands: { onCommand: { addListener() {} } },
    storage: { local: {
      // The engine lives in storage; "local" is the AgentScript engine backed by
      // or-agent.exe, which is what the user runs.
      get: (k, cb) => { const o = (engine === "local" && (k === "rs-engine" || (k && k["rs-engine"] === undefined))) ? { "rs-engine": "local" } : {}; const r = (typeof k === "string" && engine === "local" && k === "rs-engine") ? { "rs-engine": "local" } : {}; const out = Object.keys(r).length ? r : o; if (cb) cb(out); return Promise.resolve(out); },
      set: () => Promise.resolve(), remove: () => Promise.resolve() }, onChanged: { addListener() {} } },
    tabs: {
      query: () => Promise.resolve([{ id: 7, url: "https://chat.deepseek.com/", title: "OR test chat", windowId: 1 }]),
      sendMessage: () => Promise.resolve(),
      captureVisibleTab: (_a, b, c) => {
        const url = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/AF+7E1mAAAAAElFTkSuQmCC";
        const cb = typeof b === "function" ? b : c;
        if (typeof cb === "function") cb(url);
      },
    },
  };
  return { chromeStub, listeners };
}

// ── provider stub: the seam main.js talks to instead of a real chat site ────
function makeProvider(win, log) {
  const editor = win.document.createElement("textarea");
  return {
    id: "deepseek", displayName: "DeepSeek (test stub)",
    timings: { typeMs: 1, sendWaitMs: 10, pollMs: 10, genIdleMs: 50, turnMaxMs: 2000 },
    supportsVision: true,
    thinkingSel: ".think", chipAtItemLevel: false, reliableCounts: false,
    attachImages: async (images) => { log.attached.push(...(images || [])); return true; },
    clearAttachments: async () => true,
    allItems: () => [], isUserItem: () => false, isAssistantItem: () => false, itemText: () => "", classifyText: () => ({ body: "", hasCommand: false }),
    assistantCount: () => 0, userCount: () => 0, lastAssistant: () => null, lastAssistantId: () => null, itemKey: () => "k",
    readAssistant: () => "", streamLen: () => 0, snapshot: () => ({}),
    getEditor: () => editor, editorText: () => editor.value || "", chatIsEmpty: () => true, isFreshChat: () => true,
    composerFrame: () => null, barAnchor: () => null, setInputLock() {},
    typeAndSend: async () => true, stopGeneration: async () => true,
    isGenerating: () => false, isBusyNow: () => false, isHardGenerating: () => false, genDebug: () => ({}),
    enforceComposer: () => ({ ready: true }), ensureComposerReady: async () => ({ ready: true }),
    turnHalted: () => false, findContinueBtn: () => null, clickContinueBtn() {},
    scanError: () => null, isTooLongMsg: () => false, isBusyMsg: () => false,
    conversationKey: () => "/c/test", installSendHooks() {}, findToolBlockSpot: () => null,
    uiHooks: {}, help() {},
  };
}

// ── load everything ────────────────────────────────────────────────────────
const skipped = [];
let ctx = null;
function build(replies, opts) {
  const fakeAgent = (opts && opts.fakeAgent) || null;
  const doc = makeDoc();
  const win = makeWindow(doc);
  const { chromeStub } = makeBridge(opts && opts.engine);
  const log = { attached: [], toasts: [] };
  const sandbox = win;
  sandbox.chrome = chromeStub;
  sandbox.RS = vm.runInNewContext(cfgSrc + "\n;RS;", { window: {}, console });
  sandbox.RSProvider = makeProvider(win, log);
  // A packaged extension file must be readable through fetch() (that is how the
  // worker gets studio_shot.ps1), so serve chrome-extension:// from disk; anything
  // else still fails - no network here on purpose.
  sandbox.fetch = async (url) => {
    const u = String(url);
    if (u.startsWith("chrome-extension://or-test/")) {
      const rel = u.replace("chrome-extension://or-test/", "").split("?")[0];
      const full = path.join(root, rel);
      if (fs.existsSync(full)) {
        const buf = fs.readFileSync(full);
        return { ok: true, status: 200, text: async () => buf.toString("utf8"), json: async () => JSON.parse(buf.toString("utf8")), arrayBuffer: async () => buf.buffer };
      }
      return { ok: false, status: 404, text: async () => "", json: async () => ({}) };
    }
    throw new Error("no network in this harness");
  };
  // A real browser fails a loopback WebSocket FAST (connection refused -> onerror),
  // and nothing is listening on the agent port in this sandbox. A stub that never
  // fires onerror would make every agent call sit on its whole timeout, which is a
  // harness artifact, not the product's behaviour.
  sandbox.WebSocket = class {
    constructor(url) {
      // The fake agent lives on the LOCAL ENGINE port only. The bridge socket
      // (17613) is NOT answered - nothing is listening there in this sandbox - so a
      // stub that connects everything would fake a Roblox MCP that does not exist.
      const isLocalEngine = fakeAgent && /:17615\b/.test(String(url || ""));   // PORT_LOCAL: the agent's own socket
      if (isLocalEngine) {                               // a live (fake) or-agent.exe
        const sock = fakeAgent.openSocket();
        this.readyState = 0;
        Object.defineProperty(this, "onopen", { get: () => sock.onopen, set: (f) => { sock.onopen = f; } });
        Object.defineProperty(this, "onmessage", { get: () => sock.onmessage, set: (f) => { sock.onmessage = f; } });
        Object.defineProperty(this, "onerror", { get: () => sock.onerror, set: (f) => { sock.onerror = f; } });
        Object.defineProperty(this, "onclose", { get: () => sock.onclose, set: (f) => { sock.onclose = f; } });
        Object.defineProperty(this, "readyState", { get: () => sock.readyState, set: (v) => { sock.readyState = v; } });
        this.send = (str) => sock.send(str);
        this.close = () => sock.close();
        this.addEventListener = () => {}; this.removeEventListener = () => {};
        return;
      }
      this.readyState = 0;
      setTimeout(() => { this.readyState = 3; try { this.onerror && this.onerror(new Event("error")); } catch {} }, 5);
    }
    send() {} close() { this.readyState = 3; } addEventListener() {} removeEventListener() {}
  };
  sandbox.chrome = chromeStub;
  const c = vm.createContext(sandbox);
  // the real service worker runs in the same context, so chrome.runtime.sendMessage
  // in main.js reaches the REAL background code
  vm.runInContext(bgSrc, c, { filename: "background.js" });
  try {
    vm.runInContext(mainSrc, c, { filename: "core/main.js" });
  } catch (e) {
    // Surface WHERE it died: a load-time failure means no OR UI at all, so the
    // harness must not hide it behind a one-line message.
    e.message = e.message + "\n    at " + String(e.stack || "").split("\n").slice(1, 4).join("\n    at ");
    throw e;
  }
  return { ctx: c, log, replies };
}

// ── drive the page seam ────────────────────────────────────────────────────
const seam = (c) => vm.runInContext("typeof window.__rsRunTool === 'function' ? window.__rsRunTool : null", c);
const call = async (c, tool, args, ms = 4000) => {
  const run = seam(c);
  if (typeof run !== "function") return "__no_seam__";
  try {
    return await Promise.race([run(tool, args), new Promise((r) => setTimeout(() => r("__timeout__"), ms))]);
  } catch (e) {
    // A rejection is a failure the user would see as a broken command - surface the
    // message instead of letting the harness die with a stack trace.
    return "THREW: " + String((e && e.message) || e);
  }
};

(async () => {
  // ── 0. it must LOAD at all (this is what the TDZ bug broke) ──
  let built = null;
  try {
    built = build();
    ok("core/main.js evaluates with the real background.js present", true);
  } catch (e) {
    ok("core/main.js evaluates with the real background.js present", false, e.message);
    console.log("\n" + failed + " FAILED (load aborted)");
    process.exit(1);
  }
  const c = built.ctx;

  // ── 1. the seam ──
  ok("main.js exposes a command seam for testing", typeof seam(c) === "function");

  // ── 2. every screenshot command must return SOMETHING usable (never a throw,
  //       never a bare empty string, never a TDZ/reference error) ──
  const targets = ["auto", "studio", "roblox", "viewport", "blender", "window", "studio_window", "os",
                   "desktop", "tab", "chat", "page", "self", "bogus-typo", ""];
  for (const t of targets) {
    const out = await call(c, "or_screenshot", t === "" ? {} : { target: t });
    const s = String(out);
    const bad = /before initialization|is not defined|Cannot read prop|\bundefined\b.*undefined|__no_seam__|__timeout__/.test(s);
    ok(`or_screenshot target:"${t}" answers cleanly`, !bad && s.length > 20, s.slice(0, 160));
  }
  for (const alias of ["screenshot", "take_screenshot", "send_screenshot"]) {
    const s = String(await call(c, alias, { target: "studio" }));
    ok(`alias ${alias} answers cleanly`, s.length > 20 && !/before initialization|is not defined/.test(s), s.slice(0, 120));
  }
  for (const args of [{}, { source: "recent" }, { index: 0 }, { path: "nope.png" }, { copy: true, send: false }, { paste: true }, { send: false, paste: false }, { source: "studio" }]) {
    const s = String(await call(c, "attach_feedback", args));
    ok(`attach_feedback ${JSON.stringify(args)} answers cleanly`, s.length > 20 && !/before initialization|is not defined/.test(s), s.slice(0, 140));
  }
  for (const alias of ["attachfeedbackor", "attach_image", "attach_file", "attach_screenshot", "attach_last_screenshot", "attach_recent_image", "copy_screenshot", "paste_screenshot", "or_attach"]) {
    const s = String(await call(c, alias, {}));
    ok(`attach alias ${alias} answers cleanly`, s.length > 20 && !/before initialization|is not defined/.test(s), s.slice(0, 120));
  }
  for (const name of ["or_focus_studio", "focus_studio", "bring_studio_to_front", "studio_focus", "studio_to_front"]) {
    const s = String(await call(c, name, {}));
    ok(`${name} answers cleanly`, s.length > 20 && !/before initialization|is not defined/.test(s), s.slice(0, 140));
  }

  // ── 3. the plumbing is reachable from the UI layer too (the popup buttons) ──
  // The same misplacement made rememberImages/copyImageToClipboard invisible to
  // the ui IIFE, so those buttons were broken as well.
  {
    // Line-based, not a character window: a slice window silently came up short and
    // reported a false failure. Order proves the scope: helper definitions sit ABOVE
    // `async function runTool` (closure level), and the popup code that calls them
    // sits inside the ui closure - so both see them. Nested inside runTool (the bug)
    // they would be above neither.
    const lineOf = (re) => mainSrc.split("\n").findIndex((l) => re.test(l)) + 1;
    const L = { copyDef: lineOf(/async function copyImageToClipboard/), rememberDef: lineOf(/function rememberImages/),
                runTool: lineOf(/async function runTool\(call\)/), popupCopy: lineOf(/copyImageToClipboard\(images\[0\]\)/),
                popupUse: lineOf(/rememberImages\(images, "popup"\)/), ui: lineOf(/const ui = \(\(\) =>/) };
    ok("helpers are defined at closure scope, above runTool", L.copyDef > 0 && L.rememberDef > 0 && L.copyDef < L.runTool && L.rememberDef < L.runTool,
       JSON.stringify(L));
    ok("the popup's Copy button can see copyImageToClipboard", L.popupCopy > 0 && L.popupCopy > L.copyDef && L.popupCopy > L.ui, JSON.stringify(L));
    ok("the popup's Use-as-feedback can see rememberImages", L.popupUse > 0 && L.popupUse > L.rememberDef, JSON.stringify(L));
    // scope check by execution: the helpers must exist at closure scope, which we
    // prove by asking whether the seam's closure resolves them (it does, since the
    // screenshot path above used them without a ReferenceError).
    const used = String(await call(c, "or_screenshot", { target: "tab" }));
    ok("the shared capture path actually ran (helpers resolved)", /Output of 'or_screenshot'|ERROR: or_screenshot/.test(used), used.slice(0, 160));
  }

  // ── 4. no screenshot path may report success with zero images ──
  {
    const s = String(await call(c, "or_screenshot", { target: "auto" }));
    const claimsImage = /attached to THIS message/i.test(s);
    const hasError = /^ERROR/.test(s);
    ok("a capture claim always comes with an image or an error", hasError || claimsImage, s.slice(0, 200));
  }

  // ── 5. THE USER'S MACHINE: an or-agent.exe with 18 tools and NO read_file_base64 ──
  // Everything above ran with no agent at all. These run against a fake agent that
  // is byte-for-byte the build in the repo root (18 tools, read_file_base64 absent),
  // over the real bridge protocol, with a real ~90 KB capture in its workspace and a
  // read_file that clips replies the way the Rust one does. If a screenshot can reach
  // the browser HERE, it can reach it on the user's machine without any rebuild.
  {
    const agent = makeFakeAgent({ clipChars: 20000 });   // clip hard -> forces chunk self-healing
    let cAgent = null;
    try {
      cAgent = build({}, { fakeAgent: agent, engine: "local" }).ctx;
      ok("main.js loads with a live (old) agent attached", true);
    } catch (e) {
      ok("main.js loads with a live (old) agent attached", false, e.message);
    }
    if (cAgent) {
      const recent = () => vm.runInContext("typeof window.__rsRecentImages === 'function' ? window.__rsRecentImages() : []", cAgent);
      const info = String(await call(cAgent, "agent_info", {}, 15000));
      ok("agent_info reports the running build truthfully", /RUNNING with 18 tools/.test(info) && /read_file_base64 is missing/i.test(info), info.slice(0, 220));
      ok("...and says screenshots DO work without a rebuild (text tunnel)", /TEXT TUNNEL/i.test(info) && /Screenshots DO work/i.test(info), info.slice(0, 300));
      ok("...and scopes the rebuild as optional, not required", /Rebuilding is optional/i.test(info), info.slice(0, 220));

      const shot = String(await call(cAgent, "or_screenshot", { target: "window" }, 40000));
      ok("or_screenshot {target:window} answers on the OLD agent", !/THREW|__timeout__/.test(shot), shot.slice(0, 200));
      ok("...it claims the picture arrived", /attached to THIS message/i.test(shot), shot.slice(0, 300));
      ok("...and names the text tunnel as the delivery route", /text tunnel/i.test(shot), shot.slice(0, 300));
      const imgs = recent();
      ok("...and image bytes were really attached (not just a claim)", imgs.length > 0 && String(imgs[0].data || "").length > 1000, JSON.stringify({ n: imgs.length, bytes: String((imgs[0] || {}).data || "").length }));
      const expected = fs.readFileSync(path.join(root, "or-agent.exe")); // any 90KB payload: compare hashes below instead
      if (imgs.length) {
        const got = Buffer.from(String(imgs[0].data || ""), "base64");
        const want = Buffer.alloc(90 * 1024);
        for (let i = 0; i < want.length; i++) want[i] = (i * 31 + 7) & 0xff;
        ok("...the attached picture is EXACTLY the captured bytes", got.length === want.length && crypto.createHash("sha256").update(got).digest("hex") === crypto.createHash("sha256").update(want).digest("hex"),
           "got " + got.length + " bytes, wanted " + want.length);
        ok("...and it is labelled as a JPEG (a .png name holding JPEG bytes would lie)", String(imgs[0].mimeType) === "image/jpeg", String(imgs[0].mimeType));
      }
      ok("the agent was driven over the real protocol (write_file + run_command + read_file)", agent.calls.includes("write_file") && agent.calls.includes("run_command") && agent.calls.includes("read_file"), agent.calls.join(","));
      ok("read_file was called in pages (the tunnel really chunks)", agent.calls.filter((n) => n === "read_file").length >= 2, String(agent.calls.filter((n) => n === "read_file").length) + " read_file calls");

      // target "studio" with an old agent: the MCP cannot hand over its image blocks,
      // so the WINDOW route must take over - that is the case that used to fail.
      const viaStudio = String(await call(cAgent, "or_screenshot", { target: "studio" }, 40000));
      ok("or_screenshot {target:studio} still delivers on the OLD agent (window fallback)", /attached to THIS message/i.test(viaStudio), viaStudio.slice(0, 260));
      const viaAuto = String(await call(cAgent, "or_screenshot", {}, 40000));
      ok("or_screenshot {target:auto} delivers on the OLD agent", /attached to THIS message/i.test(viaAuto), viaAuto.slice(0, 200));

      // ── and it must REFUSE to attach a damaged picture ──
      const bad = makeFakeAgent({ clipChars: 20000 });
      bad.corruptOnRead();
      const cBad = build({}, { fakeAgent: bad, engine: "local" }).ctx;
      const badShot = String(await call(cBad, "or_screenshot", { target: "window" }, 40000));
      const badImgs = vm.runInContext("window.__rsRecentImages()", cBad);
      ok("a corrupted capture is NOT attached as if it were the screenshot", badImgs.length === 0 && /^ERROR/.test(badShot), badShot.slice(0, 240));
      ok("...and the failure says the capture itself worked, only the hand-over did not", /could not be read back|damaged|incomplete|checksum/i.test(badShot), badShot.slice(0, 300));

      // ── Blender viewport shot on the OLD agent: the addon writes a PNG, the agent
      //    cannot read it as base64, so it must travel through the text tunnel. ──
      {
        const bl = makeFakeAgent({});
        const cBl = build({}, { fakeAgent: bl, engine: "local" }).ctx;
        // teach the worker that Blender is connected, exactly like the UI's Connect Blender
        await call(cBl, "blender_connect", {}, 20000);
        const bshot = String(await call(cBl, "or_screenshot", { target: "blender" }, 40000));
        const bimgs = vm.runInContext("window.__rsRecentImages()", cBl);
        ok("or_screenshot {target:blender} delivers on the OLD agent (PNG via the tunnel)",
           /attached to THIS message/i.test(bshot) && bimgs.length === 1, bshot.slice(0, 260));
        if (bimgs.length) {
          const got = Buffer.from(String(bimgs[0].data || ""), "base64");
          const want = Buffer.alloc(45 * 1024);
          for (let i = 0; i < want.length; i++) want[i] = (i * 7 + 11) & 0xff;
          ok("...the Blender picture is the exact captured file, labelled PNG",
             got.length === want.length && crypto.createHash("sha256").update(got).digest("hex") === crypto.createHash("sha256").update(want).digest("hex") && String(bimgs[0].mimeType) === "image/png",
             JSON.stringify({ n: got.length, mime: bimgs[0].mimeType }));
        }
        ok("...and the B64Only twin was requested from the script", bl.calls.some((n) => n === "run_command"), bl.calls.join(","));
      }

      // ── shot_test: "prove it BEFORE I open Studio" ──
      const st = String(await call(cAgent, "shot_test", {}, 40000));
      ok("shot_test proves the path on the old agent (self-test, no Studio open)", /Everything a screenshot needs works/i.test(st), st.slice(0, 260));
      ok("...it reports each step that passed", /checksum verified/i.test(st) && /script written into the agent workspace/i.test(st), st.slice(0, 260));
      ok("...and it names the tunnel as the hand-over in use", /TEXT TUNNEL/i.test(st), st.slice(0, 200));
      for (const alias of ["or_shot_test", "screenshot_test", "test_screenshot"]) {
        const t2 = String(await call(cAgent, alias, {}, 40000));
        ok("shot_test alias " + alias + " answers", /Output of 'shot_test'/.test(t2), t2.slice(0, 120));
      }
      {
        const broken = makeFakeAgent({}); broken.selftestBroken = true;
        const cB = build({}, { fakeAgent: broken, engine: "local" }).ctx;
        const b = String(await call(cB, "shot_test", {}, 40000));
        ok("a PowerShell failure is reported as a setup problem, with the reason", /SCREENSHOT PATH BROKEN/.test(b) && /GDI|self-test failed/i.test(b), b.slice(0, 300));
        ok("...and it says the test needs no Studio window", /needs no Studio window/i.test(b), b.slice(0, 300));
      }
      {
        const badRt = makeFakeAgent({}); badRt.selftestBadRoundtrip = true;
        const cB = build({}, { fakeAgent: badRt, engine: "local" }).ctx;
        const b = String(await call(cB, "shot_test", {}, 40000));
        ok("a broken tunnel format is caught by the self-test", /SCREENSHOT PATH BROKEN/.test(b) && /tunnel format is broken/i.test(b), b.slice(0, 300));
      }

      // ── the PC where the fast helper cannot be compiled: the script must fall back to
      //    the pure-.NET route and STILL deliver a picture ──
      {
        const nc = makeFakeAgent({}); nc.noCompile = true; nc.trailingNoise = true;
        const cNc = build({}, { fakeAgent: nc, engine: "local" }).ctx;
        const nshot = String(await call(cNc, "or_screenshot", { target: "window" }, 40000));
        const nimgs = vm.runInContext("window.__rsRecentImages()", cNc);
        ok("a PC that cannot compile the fast helper still gets its screenshot", /attached to THIS message/i.test(nshot) && nimgs.length === 1, nshot.slice(0, 300));
        ok("...and the result says the fallback route was used, not a silent downgrade", /fallback route/i.test(nshot), nshot.slice(0, 300));
        ok("...and a warning printed AFTER the result line does not hide it", nimgs.length === 1, nshot.slice(0, 200));
      }
      {
        const cf = makeFakeAgent({}); cf.captureFails = true;
        const cCf = build({}, { fakeAgent: cf, engine: "local" }).ctx;
        const fshot = String(await call(cCf, "or_screenshot", { target: "window" }, 40000));
        const fimgs = vm.runInContext("window.__rsRecentImages()", cCf);
        ok("a capture-step failure is reported with the script's own reason", fimgs.length === 0 && /capture step failed/i.test(fshot), fshot.slice(0, 320));
        ok("...and the blocked-compile detail is passed on, not swallowed", /could not load file or assembly|CodeDom/i.test(fshot), fshot.slice(0, 320));
      }

      // ── a capture too big to read back as text must be RETAKEN smaller ──
      const big = makeFakeAgent({ clipChars: 20000 });
      big.maxReadBytes = 60000;                    // the 90 KB image's base64 is ~123 KB -> refused
      const cBig = build({}, { fakeAgent: big, engine: "local" }).ctx;
      const bigShot = String(await call(cBig, "or_screenshot", { target: "window" }, 40000));
      const bigImgs = vm.runInContext("window.__rsRecentImages()", cBig);
      ok("a capture too big for the agent to read is retaken smaller, not reported as a dead end",
         /attached to THIS message/i.test(bigShot) && /retaken smaller/i.test(bigShot), bigShot.slice(0, 300));
      ok("...and the smaller picture really is attached", bigImgs.length === 1 && String(bigImgs[0].data || "").length > 100, JSON.stringify({ n: bigImgs.length, len: String((bigImgs[0] || {}).data || "").length }));

      const gone = makeFakeAgent({ clipChars: 20000 });
      gone.hideB64OnRead();
      const cGone = build({}, { fakeAgent: gone, engine: "local" }).ctx;
      const goneShot = String(await call(cGone, "or_screenshot", { target: "window" }, 40000));
      ok("a missing tunnel file is reported plainly, never as an empty success", /^ERROR/.test(goneShot) && !/attached to THIS message/i.test(goneShot), goneShot.slice(0, 240));
    }
  }

  console.log("\n" + (failed ? failed + " FAILED" : "all screenshot-path checks passed"));
  process.exit(failed ? 1 : 0);
})();
