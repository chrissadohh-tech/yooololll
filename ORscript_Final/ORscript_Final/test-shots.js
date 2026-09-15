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
    atob, btoa, Blob: class { constructor(p) { this.parts = p; } }, File: class { constructor(p, n, o) { this.parts = p; this.name = n; this.type = (o || {}).type; } },
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

// ── the bridge: real background.js behind a chrome.runtime mock ─────────────
function makeBridge() {
  const listeners = [];
  const chromeStub = {
    runtime: {
      id: "or-test",
      onMessage: { addListener: (fn) => listeners.push(fn) },
      sendMessage: (msg, cb) => {
        const respond = (r) => { try { cb && cb(r); } catch {} };
        const hit = listeners.find(Boolean);
        if (!hit) { respond({ ok: false, error: "no background listener" }); return; }
        try { hit(msg, { tab: { id: 7, url: "https://chat.deepseek.com/", windowId: 1 } }, respond); }
        catch (e) { respond({ ok: false, error: String(e && e.message || e) }); }
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
    storage: { local: { get: (_k, cb) => { cb && cb({}); return Promise.resolve({}); }, set: () => Promise.resolve(), remove: () => Promise.resolve() }, onChanged: { addListener() {} } },
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
function build(replies) {
  const doc = makeDoc();
  const win = makeWindow(doc);
  const { chromeStub } = makeBridge();
  const log = { attached: [], toasts: [] };
  const sandbox = win;
  sandbox.chrome = chromeStub;
  sandbox.RS = vm.runInNewContext(cfgSrc + "\n;RS;", { window: {}, console });
  sandbox.RSProvider = makeProvider(win, log);
  sandbox.fetch = async () => { throw new Error("no network in this harness"); };
  // A real browser fails a loopback WebSocket FAST (connection refused -> onerror),
  // and nothing is listening on the agent port in this sandbox. A stub that never
  // fires onerror would make every agent call sit on its whole timeout, which is a
  // harness artifact, not the product's behaviour.
  sandbox.WebSocket = class {
    constructor() { this.readyState = 0; setTimeout(() => { this.readyState = 3; try { this.onerror && this.onerror(new Event("error")); } catch {} }, 5); }
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

  console.log("\n" + (failed ? failed + " FAILED" : "all screenshot-path checks passed"));
  process.exit(failed ? 1 : 0);
})();
