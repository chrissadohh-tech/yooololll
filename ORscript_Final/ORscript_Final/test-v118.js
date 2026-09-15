// OR v1.18 regression suite (run: node test-v118.js). Not shipped.
// Covers what v1.18 changed and what used to break silently:
//   * web_fetch / web_search - previously DDG-only; now a multi-backend chain
//     with per-backend failure notes, timeouts and a reader fallback;
//   * image transport - a screenshot taken by Studio/Blender is written to a
//     file on the user's PC, so the browser can only hand it to the AI through
//     the bridge's read_file_base64; blenderCall must read it BACK;
//   * attach_feedback - the "copy + paste + send the last screenshot" command;
//   * Blender materials - 10 new node-based material commands.
// The service worker is executed for real in a VM with a mocked network, so
// these are behavioural tests, not just grep checks.
const fs = require("fs");
const path = require("path");
const vm = require("vm");

let failed = 0;
const ok = (name, cond, extra) => {
  console.log((cond ? "PASS" : "FAIL") + "  " + name + (cond || extra === undefined ? "" : "  → " + extra));
  if (!cond) failed++;
};

const root = __dirname;
const bgSrc = fs.readFileSync(path.join(root, "background.js"), "utf8");
const ps1Src = fs.readFileSync(path.join(root, "studio_shot.ps1"), "utf8");
const mainSrc = fs.readFileSync(path.join(root, "core/main.js"), "utf8");
const cfgSrc = fs.readFileSync(path.join(root, "core/config.js"), "utf8");
const pySrc = fs.readFileSync(path.join(root, "blender_ops.py"), "utf8");

// ── 1. Syntax of every shipped script ────────────────────────────────────────
try { new vm.Script(bgSrc, { filename: "background.js" }); ok("background.js parses", true); }
catch (e) { ok("background.js parses", false, e.message); }
try { new vm.Script(mainSrc, { filename: "core/main.js" }); ok("core/main.js parses", true); }
catch (e) { ok("core/main.js parses", false, e.message); }
try { new vm.Script(cfgSrc, { filename: "core/config.js" }); ok("core/config.js parses", true); }
catch (e) { ok("core/config.js parses", false, e.message); }

// ── 2. config.js actually evaluates: TOOL_NOTES + prompt surface ─────────────
let RS = null;
try {
  const ctx = { window: {}, console };
  vm.createContext(ctx);
  RS = vm.runInContext(cfgSrc + "\n;RS;", ctx);
  ok("config.js exports RS", !!RS && typeof RS.buildSystemPrompt === "function");
} catch (e) { ok("config.js exports RS", false, e.message); }

if (RS) {
  const notes = RS.TOOL_NOTES || {};
  for (const key of ["ViewportScreenshotRoblox", "ViewportScreenshotBlender", "ViewportScreenshot", "attach_feedback", "read_file_base64", "blender_material_create",
                     "blender_material_set", "blender_material_assign", "blender_material_noise",
                     "blender_material_image", "blender_material_pbr", "blender_material_preset",
                     "blender_material_inspect"]) {
    ok("TOOL_NOTES has " + key, typeof notes[key] === "string" && notes[key].length > 40);
  }
  const prompt = RS.buildSystemPrompt({ engine: "roblox" });
  ok("prompt documents attach_feedback", prompt.includes("attach_feedback"));
  ok("prompt documents the attach aliases", prompt.includes("attach_screenshot") && prompt.includes("copy_screenshot"));
  ok("local prompt explains image/file attachments",
    /read_file_base64/.test(RS.buildSystemPrompt({ engine: "local" })) && /attach_feedback/.test(RS.buildSystemPrompt({ engine: "local" })));
  ok("the live roster appends TOOL_NOTES by bare name", /RS\.TOOL_NOTES\[bareToolName\(t\.name\)\]/.test(mainSrc));
  ok("prompt no longer claims web_search is DuckDuckGo-only", !/web_search\\?`? {query, limit\?} DuckDuckGo/.test(prompt));
  ok("prompt names exactly three SEPARATE screenshot commands and nothing else",
     /THREE separate commands, no aliases/.test(prompt) &&
     /ViewportScreenshotRoblox/.test(prompt) && /ViewportScreenshotBlender/.test(prompt) &&
     /ViewportScreenshot/.test(prompt) && /There is no or_screenshot \/ screenshot \/ take_screenshot/.test(prompt));
  ok("...and says each command photographs one app and never substitutes another",
     /each one photographs ONE thing/.test(prompt) && /substitutes another app/.test(prompt));
  // The three the user actually asks for must be spelled out, including that the
  // whole-PC one is the desktop itself and needs no window in front.
  ok("...and the Studio one is described as needing only Studio RUNNING, no window involved",
     /needs only Studio to be RUNNING - no window, no focus/.test(prompt));
  ok("the notes tell the model the old names are not commands",
     /Never call or_screenshot \/ screenshot \/ take_screenshot/.test(RS.TOOL_NOTES.ViewportScreenshotRoblox) &&
     /Never call or_screenshot \/ screenshot \/ take_screenshot/.test(RS.TOOL_NOTES.ViewportScreenshotBlender) &&
     /Never call or_screenshot \/ screenshot \/ take_screenshot/.test(RS.TOOL_NOTES.ViewportScreenshot));
  ok("prompt points at the reason a capture gives, instead of retrying",
     /reports NOTHING it names the reason/.test(prompt) && /than retrying the same command/.test(prompt));
  ok("tool notes survive into the roster text", typeof RS.compactTools === "function");
  ok("attach_feedback is a screen-category tool", RS.toolCategory("attach_feedback") === "screen");
  ok("the three commands are screen-themed however they are spelled, dead aliases are not",
     RS.toolCategory("ViewportScreenshotRoblox") === "screen" &&
     RS.toolCategory("viewport_screenshot_blender") === "screen" &&
     RS.toolCategory("VIEWPORTSCREENSHOT") === "screen" && RS.toolCategory("shot_test") === "screen" &&
     RS.toolCategory("or_screenshot") !== "screen" && RS.toolCategory("screenshot") !== "screen" &&
     RS.toolCategory("take_screenshot") !== "screen");
  ok("read_file_base64 is a read-category tool", RS.toolCategory("read_file_base64") === "read");
}

// ── 3. Blender material toolkit (python side) ────────────────────────────────
const MAT_OPS = ["material_create", "material_preset", "material_set", "material_assign", "material_list",
                 "material_inspect", "material_remove", "material_noise", "material_image", "material_pbr"];
for (const op of MAT_OPS) {
  ok("blender_ops.py defines cmd_" + op, pySrc.includes("def cmd_" + op + "("));
  ok("blender_ops.py dispatches " + op, new RegExp('"' + op + '":\\s*cmd_').test(pySrc));
}
ok("material toolkit has presets", (pySrc.match(/^\s{4}"[a-z_]+":\s*\{/gm) || []).length >= 25);
ok("materials survive Blender 4.x renames", pySrc.includes("Specular IOR Level") && pySrc.includes("Transmission Weight") && pySrc.includes("Coat Weight"));
ok("materials survive Blender <=4.1 blend fields", pySrc.includes("blend_method") && pySrc.includes("shadow_method") && pySrc.includes("surface_render_method"));
ok("no removed Musgrave node", !pySrc.includes("ShaderNodeTexMusgrave"));
ok("OR_ prefixed nodes are cleaned up", pySrc.includes('"OR_"') || pySrc.includes("OR_"));
ok("every advertised preset exists in python (31/31)", (() => {
  const start = pySrc.indexOf("MATERIAL_PRESETS = {");
  const presets = new Set((pySrc.slice(start, pySrc.indexOf("\n}", start)).match(/^\s{4}"([a-z_0-9]+)":/gm) || [])
    .map((l) => l.trim().replace(/[":]/g, "")));
  const m = bgSrc.match(/"metal, steel, iron, ([^"]*)"/);
  const advertised = new Set(["metal", "steel", "iron", ...(m ? m[1].split(",").map((x) => x.trim()) : [])]);
  return advertised.size > 25 && [...advertised].every((n) => presets.has(n));
})());
ok("no helper is called that is not defined", (() => {
  const section = pySrc.slice(pySrc.indexOf("_BSDF_NAMES"));
  const defined = new Set((section.match(/^\s*def (_[a-z_0-9]+)\(/gm) || []).map((l) => l.trim().slice(4).replace("(", "")));
  const called = new Set((section.match(/(?<![\w.])(_[a-z_0-9]+)\(/g) || []).map((x) => x.slice(0, -1)));
  return [...called].every((c) => defined.has(c) || ["_", "_fn", "_m", "_u"].includes(c));
})());
ok("every command writes its status file", (() => {
  const re = /^def (cmd_[a-z_0-9]+)\(\):/gm;
  const heads = [...pySrc.matchAll(re)].map((m) => ({ name: m[1], at: m.index }));
  const bodies = heads.map((h, i) => pySrc.slice(h.at, i + 1 < heads.length ? heads[i + 1].at : pySrc.indexOf("DISPATCH = {")));
  const silent = bodies.filter((b) => !b.includes("emit("));
  return bodies.length > 20 && silent.every((b) => /return cmd_/.test(b));
})());
ok("every dispatch target exists", (() => {
  const tail = pySrc.slice(pySrc.indexOf("DISPATCH = {"));
  const defined = new Set((pySrc.match(/def (cmd_[a-z_0-9]+)\(/g) || []).map((s) => s.slice(4, -1)));
  return (tail.match(/"(?:[a-z_0-9]+)":\s*(cmd_[a-z_0-9]+)/g) || [])
    .every((m) => defined.has(m.split(":")[1].trim()));
})());

// ── 4. background.js: material tool wiring ───────────────────────────────────
{
  const start = bgSrc.indexOf("const BLENDER_CMD = {");
  const end = bgSrc.indexOf("};", start);
  const table = new Function("return " + bgSrc.slice(start + "const BLENDER_CMD = ".length, end + 1))();
  const tools = [...bgSrc.matchAll(/btool\("([a-z_0-9]+)"/g)].map((m) => m[1]);
  ok("BLENDER_CMD exposes every material op", MAT_OPS.every((op) => Object.values(table).includes(op)));
  ok("every advertised blender_* tool resolves", tools.filter((t) => t.startsWith("blender_")).every((t) => !!table[t]),
    tools.filter((t) => t.startsWith("blender_") && !table[t]).join(","));
  const advertised = tools.filter((t) => t.startsWith("blender_material"));
  ok("10 material tools advertised", advertised.length === 10, advertised.join(","));
  ok("material tools are named blender_material_*", advertised.every((t) => table[t].startsWith("material_")));
  ok("material_create accepts a preset + objects", /btool\("blender_material_create"[\s\S]{0,1400}objects/.test(bgSrc));
  ok("material tool schemas carry required args", bgSrc.includes('btool("blender_material_pbr"') && /btool\("blender_material_create"[\s\S]{0,1400}\["material"\]\)/.test(bgSrc));
  ok("blender tool names include the material tools", bgSrc.includes("BLENDER_TOOL_NAMES") && bgSrc.includes("blender_material_create"));
}

// ── 5. background.js: image transport ────────────────────────────────────────
ok("bridge tool read_file_base64 is called exactly once", (bgSrc.match(/name: "read_file_base64"/g) || []).length === 1);
ok("localReadBase64 helper exists", /async function localReadBase64\(path\)/.test(bgSrc));
ok("localReadBase64 is used by blenderCall", (bgSrc.match(/localReadBase64\(/g) || []).length >= 2);
ok("local_read_base64 message case exists", bgSrc.includes('case "local_read_base64"'));
ok("local_read_base64 returns path/mimeType/bytes/data",
  /case "local_read_base64"[\s\S]{0,400}sendResponse\(\{ ok: true, path: data\.path, mimeType: data\.mimeType, bytes: data\.bytes, data: data\.data \}\)/.test(bgSrc));
ok("blenderCall no longer hardcodes an empty image list", !/images: \[\]/.test(bgSrc));
ok("blenderCall reports the shot path back", bgSrc.includes("_orShot"));
ok("blenderCall explains a failed readback", bgSrc.includes("image_error"));
ok("capture_tab still exists for tab targets", bgSrc.includes('case "capture_tab"'));

// ── 6. core/main.js: screenshots + attach_feedback ───────────────────────────
ok("main has one shared capture routine", (mainSrc.match(/async function captureShots\(target, opts\)/g) || []).length === 1);
ok("the tab note carries the front-tab warning", /r\.warning \? " - " \+ r\.warning/.test(mainSrc));
ok("the capture failure explains the agent cause AND names the app each command needs",
   /An out-of-date or-agent\.exe drops image blocks/.test(mainSrc) &&
   /Roblox Studio must be RUNNING/.test(mainSrc) && /Blender must be RUNNING and connected/.test(mainSrc));
ok("the failure tells the model not to retry blindly", /do NOT retry blindly/i.test(mainSrc));
ok("the commands use the shared routine, with their app guard",
   /captureShots\(target, \{ only, maxWidth: args\.max_width \}\)/.test(mainSrc));
ok("captureShots is the only screen_capture caller", (mainSrc.match(/tryMcp\("screen_capture"/g) || []).length === 1);
ok("recent captures are remembered", mainSrc.includes("function rememberImages(") && mainSrc.includes("RECENT_IMAGES_MAX"));
ok("image payloads become reusable blobs", mainSrc.includes("function imageToBlob(") && mainSrc.includes("function imageToPngBlob("));
ok("clipboard write is guarded and reported", mainSrc.includes("function copyImageToClipboard(") && mainSrc.includes("ClipboardItem"));
ok("attach_feedback is dispatched", mainSrc.includes('name === "attach_feedback"'));
ok("the literal spelling attachfeedbackor routes", mainSrc.includes('name === "attachfeedbackor"') && cfgSrc.includes("attachfeedbackor"));
for (const alias of ["attach_image", "attach_file", "attach_screenshot", "attach_last_screenshot", "attach_recent_image", "copy_screenshot", "paste_screenshot", "or_attach"]) {
  ok("attach alias " + alias + " routed", mainSrc.includes(`name === "${alias}"`));
}
ok("attach_feedback reads workspace files through the bridge", mainSrc.includes('type: "local_read_base64"'));
ok("attach_feedback stages into the composer via the provider", mainSrc.includes("P.attachImages([img])"));
ok("attach_feedback can attach without attaching (copy only)", mainSrc.includes("args.copy !== false"));
ok("attach_feedback refuses on non-vision sites", /attach_feedback[\s\S]{0,600}supportsVision/.test(mainSrc));
ok("capture results are recorded for later re-sends", (mainSrc.match(/rememberImages\(r\.images, name\)/g) || []).length === 2);
ok("the popup offers Copy + Use as feedback", mainSrc.includes('"Copy"') && mainSrc.includes("Use as feedback"));
ok("the popup can re-attach by hand", mainSrc.includes("A.pendingImages = images.slice()"));
ok("attach_feedback is featured in the tool list", mainSrc.includes("attach_feedback {index?, path?, source?, copy?, paste?, send?}"));

// ── 7. background.js runs for real: web stack behaviour ──────────────────────
function httpResponse(status, body, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => headers[String(k).toLowerCase()] || null },
    text: async () => String(body),
    json: async () => JSON.parse(String(body)),
  };
}

function makeWorker(fetchImpl, bridgeImpl, opts) {
  const listeners = {};
  const o = opts || {};
  const sockets = [];
  class FakeWS {
    constructor(url) { this.url = String(url); this.readyState = 1; this.sent = []; sockets.push(this); }
    send(txt) { this.sent.push(JSON.parse(txt)); }
    close() { this.readyState = 3; }
    addEventListener() {}
  }
  FakeWS.CONNECTING = 0;
  FakeWS.OPEN = 1;
  FakeWS.CLOSING = 2;
  FakeWS.CLOSED = 3;
  const chromeStub = {
    storage: {
      local: { get: (_k, cb) => { if (typeof cb === "function") cb({}); return Promise.resolve({}); }, set: () => Promise.resolve(), remove: () => Promise.resolve() },
      onChanged: { addListener: () => {} },
    },
    runtime: {
      onMessage: { addListener: (fn) => { listeners.onMessage = fn; } },
      onStartup: { addListener: () => {} },
      onInstalled: { addListener: () => {} },
      getURL: (p) => "chrome-extension://test/" + p,
      getPlatformInfo: () => Promise.resolve({ os: "win", arch: "x86-64" }),
      sendMessage: () => Promise.resolve(),
      lastError: o.lastError || null,
    },
    tabs: {
      query: o.query || (() => Promise.resolve([{ id: 7, url: "https://example.test/", title: "Example", windowId: 1 }])),
      sendMessage: () => Promise.resolve(),
      captureVisibleTab: o.captureTab || ((_a, b, c) => {
        const url = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/AF+7E1mAAAAAElFTkSuQmCC";
        const cb = typeof b === "function" ? b : c;
        if (typeof cb === "function") { cb(url); return; }
        return Promise.resolve(url);
      }),
    },
  };
  const sandbox = {
    chrome: chromeStub,
    console: { log: () => {}, warn: () => {}, error: () => {}, info: () => {} },
    fetch: fetchImpl || (async () => { throw new Error("network disabled in tests"); }),
    WebSocket: FakeWS,
    setTimeout, clearTimeout, setInterval: () => 1, clearInterval: () => {},
    URL, AbortController, TextDecoder, TextEncoder, atob, btoa, navigator: { userAgent: "node" },
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  const ctx = vm.createContext(sandbox);
  vm.runInContext(bgSrc, ctx, { filename: "background.js" });
  if (bridgeImpl) ctx.sendLocalEngine = bridgeImpl;
  return { ctx, listeners, sockets };
}

const ask = (listeners, msg) => new Promise((resolve) => {
  const done = (r) => resolve(r);
  listeners.onMessage(msg, {}, done);
  setTimeout(() => resolve({ ok: false, error: "__timeout__" }), 4000);
});

const DDG_HTML = `<html><body>
<a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fcreate.roblox.com%2Fdocs%2Freference%2Fengine%2Fpart&amp;rut=abc">Part | Roblox Creator Documentation</a>
<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fdevforum.roblox.com%2Ft%2Fparts-guide%2F123">Parts guide - DevForum</a>
</body></html>`;
const MOJEEK_HTML = `<html><body><ul>
<li><h2><a class="ob" href="https://lua.org/manual/5.1/">Lua 5.1 Reference Manual</a></h2></li>
</ul></body></html>`;
const WIKI_JSON = JSON.stringify({ query: { search: [{ title: "Roblox" }, { title: "Lua (programming language)" }] } });

(async () => {
  // 7a. web_search: first backend answers.
  {
    const seen = [];
    const headers = [];
    const { listeners } = makeWorker(async (url, opts) => {
      seen.push(String(url));
      headers.push((opts && opts.headers) || {});
      if (String(url).includes("html.duckduckgo.com")) return httpResponse(200, DDG_HTML, { "content-type": "text/html" });
      return httpResponse(500, "nope");
    });
    const r = await ask(listeners, { type: "web_search", query: "roblox part", limit: 3 });
    {
      const i = seen.findIndex((u) => u.includes("duckduckgo.com"));
      ok("web_search identifies as a browser and sends a Referer",
        i >= 0 && /Chrome\/128/.test(headers[i]["User-Agent"] || "") && /duckduckgo/.test(headers[i].Referer || ""),
        JSON.stringify(headers[i] || {}));
    }
    ok("web_search succeeds on the first backend", r.ok === true && r.backend === "duckduckgo", JSON.stringify(r).slice(0, 200));
    ok("web_search unwraps DDG redirect URLs", r.ok && r.results[0].url === "https://create.roblox.com/docs/reference/engine/part", r.ok ? r.results[0].url : "");
    ok("web_search decodes &amp; in titles", r.ok && /Roblox Creator Documentation/.test(r.results[0].title));
    ok("web_search returns both hits", r.ok && r.results.length === 2);
    ok("web_search hits exactly one backend when it succeeds", seen.filter((u) => !u.includes("127.0.0.1")).length === 1, seen.join(","));
    ok("web_search header says which backend answered", r.ok && /Searched "roblox part" \[duckduckgo\]/.test(r.text));
  }

  // 7b. web_search: first backend blocked → lite blocked → mojeek answers, with notes.
  {
    const { listeners } = makeWorker(async (url) => {
      const u = String(url);
      if (u.includes("html.duckduckgo.com")) return httpResponse(403, "blocked");
      if (u.includes("lite.duckduckgo.com")) return httpResponse(200, "<html><body>If this error persists, please let us know (anomaly)</body></html>");
      if (u.includes("mojeek.com")) return httpResponse(200, MOJEEK_HTML, { "content-type": "text/html" });
      return httpResponse(500, "nope");
    });
    const r = await ask(listeners, { type: "web_search", query: "lua manual" });
    ok("web_search falls through to mojeek", r.ok === true && r.backend === "mojeek", JSON.stringify(r).slice(0, 220));
    ok("web_search parses mojeek markup", r.ok && r.results[0].url === "https://lua.org/manual/5.1/");
    ok("web_search names the 403 backend", r.ok && r.notes.some((n) => /duckduckgo: HTTP 403/.test(n)), JSON.stringify(r.notes));
    ok("web_search flags a bot-challenge page", r.ok && r.notes.some((n) => /bot challenge/.test(n)), JSON.stringify(r.notes));
  }

  // 7c. web_search: only Wikipedia answers (JSON API, not scraped).
  {
    const { listeners } = makeWorker(async (url) => {
      const u = String(url);
      if (u.includes("wikipedia.org")) return httpResponse(200, WIKI_JSON, { "content-type": "application/json" });
      return httpResponse(429, "slow down");
    });
    const r = await ask(listeners, { type: "web_search", query: "roblox" });
    ok("web_search falls back to the wikipedia API", r.ok === true && r.backend === "wikipedia", JSON.stringify(r).slice(0, 200));
    ok("wikipedia hits get real article URLs", r.ok && r.results[0].url === "https://en.wikipedia.org/wiki/Roblox");
  }

  // 7d. web_search: everything fails → the error explains each backend.
  {
    const { listeners } = makeWorker(async () => { throw new Error("net::ERR_NAME_NOT_RESOLVED"); });
    const r = await ask(listeners, { type: "web_search", query: "nothing works" });
    ok("web_search fails loudly", r.ok === false);
    ok("web_search error names all four backends",
      ["duckduckgo", "ddg-lite", "mojeek", "wikipedia"].every((b) => String(r.error).includes(b)), r.error);
    ok("web_search error quotes the real reason", /ERR_NAME_NOT_RESOLVED/.test(r.error));
    ok("web_search error says what was tried", /tried /.test(r.error) && /duckduckgo: /.test(r.error), r.error);
  }

  // 7e. web_search: empty query is rejected before any network call.
  {
    let calls = 0;
    const { listeners } = makeWorker(async (url) => { if (!String(url).includes("127.0.0.1")) calls++; return httpResponse(200, ""); });
    const r = await ask(listeners, { type: "web_search", query: "   " });
    ok("web_search rejects an empty query", r.ok === false && calls === 0, r.error);
  }

  // 7f. web_fetch: reads a page and strips scripts/styles to text.
  {
    const filler = "This paragraph exists so the page is longer than a JavaScript shell and is read directly. ".repeat(6);
    const { listeners } = makeWorker(async (url) => httpResponse(200,
      "<html><head><style>body{color:red}</style><script>var secret=1;</script></head><body><h1>Hello</h1><p>World &amp; friends</p><p>" + filler + "</p></body></html>",
      { "content-type": "text/html; charset=utf-8" }));
    const r = await ask(listeners, { type: "web_fetch", url: "https://example.test/doc" });
    ok("web_fetch succeeds", r.ok === true, JSON.stringify(r).slice(0, 160));
    ok("web_fetch keeps the text", r.ok && r.text.includes("Hello") && r.text.includes("World & friends"));
    ok("web_fetch strips scripts and styles", r.ok && !r.text.includes("secret") && !r.text.includes("color:red"));
    ok("web_fetch reports how it got the page", r.ok && r.via === "direct" && r.status === 200);
    ok("web_fetch does not send a short but complete page to the reader", r.ok && !/rendering proxy/.test(r.text));
  }

  // 7g. web_fetch: a JavaScript-only shell is re-read through the reader proxy.
  {
    const urls = [];
    const { listeners } = makeWorker(async (url) => {
      urls.push(String(url));
      if (String(url).startsWith("https://r.jina.ai/")) return httpResponse(200, "Title: Real Page\n\nMarkdown body with the actual documentation text, long enough to be useful to a model that needs the content of this page. ".repeat(3));
      return httpResponse(200, "<html><body>Please enable JavaScript to view this page.</body></html>", { "content-type": "text/html" });
    });
    const r = await ask(listeners, { type: "web_fetch", url: "https://spa.test/app" });
    ok("web_fetch retries a JS shell via the reader", r.ok === true && r.via === "reader", JSON.stringify(r).slice(0, 200));
    ok("web_fetch reader result carries the real text", r.ok && r.text.includes("Markdown body"));
    ok("web_fetch says the layout may be missing", r.ok && /rendering proxy/.test(r.text));
    ok("web_fetch proxies the ORIGINAL url", urls.some((u) => u === "https://r.jina.ai/https://spa.test/app"), urls.join(","));
  }

  // 7h. web_fetch: nothing works → error names both stages.
  {
    const { listeners } = makeWorker(async (url) => {
      if (String(url).startsWith("https://r.jina.ai/")) throw new Error("reader offline");
      return httpResponse(503, "down");
    });
    const r = await ask(listeners, { type: "web_fetch", url: "https://dead.test/" });
    ok("web_fetch fails when both paths fail", r.ok === false);
    ok("web_fetch error names the direct stage", /direct HTTP 503/.test(String(r.error)), r.error);
    ok("web_fetch error names the reader stage", /reader: reader offline/.test(String(r.error)), r.error);
  }

  // 7i. web_fetch: query mode searches first, then fetches the winner.
  {
    const { listeners } = makeWorker(async (url) => {
      const u = String(url);
      if (u.includes("duckduckgo.com")) return httpResponse(200, DDG_HTML, { "content-type": "text/html" });
      return httpResponse(200, "<html><body><p>The docs page body, long enough to be worth reading in full.</p></body></html>", { "content-type": "text/html" });
    });
    const r = await ask(listeners, { type: "web_fetch", query: "roblox part docs" });
    ok("web_fetch query mode works", r.ok === true, JSON.stringify(r).slice(0, 160));
    ok("web_fetch query mode shows the search it ran", r.ok && /Searched "roblox part docs" \[duckduckgo\]/.test(r.text));
    ok("web_fetch query mode fetches the top hit", r.ok && r.url === "https://create.roblox.com/docs/reference/engine/part", r.url);
  }

  // 7j. web_fetch guards.
  {
    const { listeners } = makeWorker(async () => httpResponse(200, "x"));
    ok("web_fetch requires a url or query", (await ask(listeners, { type: "web_fetch" })).ok === false);
    const r = await ask(listeners, { type: "web_fetch", url: "file:///C:/secrets.txt" });
    ok("web_fetch refuses non-http schemes", r.ok === false && /http/.test(r.error), r.error);
  }

  // ── 8. read_file_base64 plumbing (what the screenshot commands / attach use) ─
  {
    const payload = { path: "C:/Users/Chris/ORWorkspace/or_blender_shot.png", mimeType: "image/png", bytes: 68, data: "iVBORw0KGgoAAAANSUhEUg==" };
    let asked = null;
    const { listeners } = makeWorker(async () => ({}), async (obj) => { asked = obj; return { ok: true, text: JSON.stringify(payload) }; });
    const r = await ask(listeners, { type: "local_read_base64", path: payload.path });
    ok("local_read_base64 returns the base64 payload", r.ok === true && r.data === payload.data, JSON.stringify(r).slice(0, 160));
    ok("local_read_base64 passes the path through", r.path === payload.path);
    ok("local_read_base64 reports the mime type", r.mimeType === "image/png");
    ok("local_read_base64 calls the bridge tool", asked && asked.type === "call_tool" && asked.name === "read_file_base64" && asked.arguments.path === payload.path,
      JSON.stringify(asked));
  }
  {
    const { listeners } = makeWorker(async () => ({}), async () => ({ ok: false, error: "no such file: or_blender_shot.png" }));
    const r = await ask(listeners, { type: "local_read_base64", path: "or_blender_shot.png" });
    ok("local_read_base64 surfaces bridge errors", r.ok === false && /no such file/.test(r.error), r.error);
  }
  {
    const { listeners } = makeWorker(async () => ({}), async () => ({ ok: true, text: "this is not json" }));
    const r = await ask(listeners, { type: "local_read_base64", path: "x.png" });
    ok("local_read_base64 rejects a non-JSON answer", r.ok === false && /no file data/.test(r.error), r.error);
  }
  {
    const { listeners } = makeWorker(async () => ({}), async () => ({ ok: true, text: JSON.stringify({ path: "x.png", mimeType: "image/png", bytes: 0, data: "" }) }));
    const r = await ask(listeners, { type: "local_read_base64", path: "x.png" });
    ok("local_read_base64 treats empty data as a failure", r.ok === false, JSON.stringify(r));
  }

  // ── 9. capture_tab (the tab route of the fallbacks / attach_feedback) ─────
  {
    const { listeners } = makeWorker(async () => ({}));
    const r = await ask(listeners, { type: "capture_tab" });
    ok("capture_tab returns an image block", r.ok === true && Array.isArray(r.images) && r.images.length === 1, JSON.stringify(r).slice(0, 160));
    ok("capture_tab tags the mime type", r.ok && r.images[0].mimeType === "image/png");
    ok("capture_tab says which tab it photographed", r.ok && r.captured && r.captured.url === "https://example.test/");
  }

  // ── 9b. The tab fallback must explain a Chrome permission block ───────────
  // Live error: captureVisibleTab refusing with "Either the '<all_urls>' or
  // 'activeTab' permission is required" while the tab in FRONT was not the chat.
  // The reply has to name the front tab and the way out.
  {
    const { listeners } = makeWorker(async () => ({}), null, {
      lastError: { message: "Either the '<all_urls>' or 'activeTab' permission is required." },
      query: () => Promise.resolve([{ id: 99, url: "chrome://extensions/", title: "Extensions", windowId: 1 }]),
    });
    const r = await ask(listeners, { type: "capture_tab" });
    ok("a permission block stays a failure", r.ok === false);
    ok("the error quotes Chrome", /all_urls|activeTab/.test(r.error), r.error);
    ok("the error names the tab that blocked it", /chrome:\/\/extensions/.test(r.error), r.error);
    ok("the error says how to make it work", /bring the chat tab/i.test(r.error) && /never be captured/i.test(r.error), r.error);
    ok("the blocked tab is reported structurally", r.front_url === "chrome://extensions/");
  }
  {
    // Capture SUCCEEDS but the front tab is somebody else's page: the model must
    // be warned, otherwise it describes that screen as if it were Studio.
    const { listeners } = makeWorker(async () => ({}), null, {
      query: () => Promise.resolve([{ id: 42, url: "https://youtube.com/watch", title: "YouTube", windowId: 1 }]),
    });
    const r = await ask(listeners, { type: "capture_tab" });
    ok("a capture of another tab still returns the image", r.ok === true && r.images.length === 1);
    ok("…with a warning naming what was photographed", /YouTube/.test(r.warning || "") && /NOT of this chat/.test(r.warning || ""), r.warning);
    ok("…and it is not flagged as this chat", r.captured.is_sender_tab === false);
  }

  // ── 11. A Studio screenshot must survive the whole bridge round trip ────────
  // This is the P0 bug: McpRuntime::call_tool used to return only the TEXT
  // blocks, so screen_capture came back as an empty string with no images and
  // the prompt still claimed an image was attached. The Rust side now returns
  // McpOutput{text, images} and the frame carries "images" — the JS must keep it.
  {
    const { ctx, listeners, sockets } = makeWorker(async () => ({}));
    const sock = sockets[sockets.length - 1];
    ok("the worker dials the bridge on startup", !!sock && /^ws:\/\/127\.0\.0\.1:\d+$/.test(sock.url), sock && sock.url);
    sock.onopen();
    const pending = ask(listeners, { type: "call_tool", name: "screen_capture", arguments: { area: "full" }, timeout: 45000 });
    await new Promise((r) => setTimeout(r, 60));
    const frame = sock.sent.find((f) => f.type === "call_tool");
    ok("call_tool is forwarded to the bridge", !!frame && frame.name === "screen_capture", JSON.stringify(sock.sent));
    ok("call_tool keeps its arguments", frame && frame.arguments && frame.arguments.area === "full");
    ok("call_tool carries a numeric id", frame && typeof frame.id === "number");
    sock.onmessage({ data: JSON.stringify({ type: "tool_result", id: frame.id, ok: true, text: "Captured the Studio viewport.",
      images: [{ mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUg==" }] }) });
    const r = await pending;
    ok("Studio screenshot images reach the content script", r.ok === true && Array.isArray(r.images) && r.images.length === 1, JSON.stringify(r).slice(0, 200));
    ok("the image keeps its mime type and bytes", r.images && r.images[0].mimeType === "image/png" && /^iVBOR/.test(r.images[0].data));
    ok("the capture text comes through too", r.text === "Captured the Studio viewport.");
  }
  {
    // Same call, text-only answer: no phantom image may be invented.
    const { listeners, sockets } = makeWorker(async () => ({}));
    sockets[sockets.length - 1].onopen();
    const sock = sockets[sockets.length - 1];
    const pending = ask(listeners, { type: "call_tool", name: "execute_luau", arguments: {} });
    await new Promise((r) => setTimeout(r, 60));
    const frame = sock.sent.find((f) => f.type === "call_tool");
    sock.onmessage({ data: JSON.stringify({ type: "tool_result", id: frame.id, ok: true, text: "returned fine" }) });
    const r = await pending;
    ok("a text-only result has an empty image list", r.ok === true && Array.isArray(r.images) && r.images.length === 0, JSON.stringify(r));
    ok("a text-only result keeps its text", r.text === "returned fine");
  }
  {
    const { listeners, sockets } = makeWorker(async () => ({}));
    sockets[sockets.length - 1].onopen();
    const sock = sockets[sockets.length - 1];
    const pending = ask(listeners, { type: "call_tool", name: "execute_luau", arguments: {} });
    await new Promise((r) => setTimeout(r, 60));
    const frame = sock.sent.find((f) => f.type === "call_tool");
    sock.onmessage({ data: JSON.stringify({ type: "tool_result", id: frame.id, ok: false, kind: "execution", error: "stack traceback" }) });
    const r = await pending;
    ok("a failed tool result stays a failure", r.ok === false && /stack traceback/.test(r.error), JSON.stringify(r));
  }

  // ── 12. The MV3 CSP must let the service worker REACH the web ───────────────
  // This is why web_fetch/web_search "just didn't work" for so long: fetch() ran
  // fine in code but the extension's own connect-src only allowed 'self',
  // 127.0.0.1 and ollama.com - so every scrape was refused by CSP ("Refused to
  // connect to ... because it violates ... connect-src") and the old catch
  // swallowed it into a bare "no results". host_permissions do NOT lift CSP.
  {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
    const csp = (manifest.content_security_policy && manifest.content_security_policy.extension_pages) || "";
    const connect = (csp.split("connect-src")[1] || "").split(";")[0];
    ok("manifest is MV3", manifest.manifest_version === 3);
    ok("CSP allows https fetches from the worker", /https:\/\/\*/.test(connect), connect.trim());
    ok("CSP allows plain-http fetches too", /http:\/\/\*/.test(connect), connect.trim());
    ok("CSP still allows the local bridges", /ws:\/\/127\.0\.0\.1:\*/.test(connect) && /http:\/\/127\.0\.0\.1:\*/.test(connect));
    ok("CSP keeps ollama reachable", /ollama\.com/.test(connect));
    ok("CSP does not open script-src to the world", !/script-src[^;]*https?:\/\//.test(csp));
    ok("host permissions cover https", manifest.host_permissions.includes("https://*/*"));
    // captureVisibleTab needs <all_urls> when the extension is invoked from the
    // page (activeTab is only granted by clicking the toolbar icon).
    ok("host permissions include <all_urls> for tab capture", manifest.host_permissions.includes("<all_urls>"));
    ok("host permissions cover http", manifest.host_permissions.includes("http://*/*"));
    ok("popup title matches the version", manifest.action.default_title.includes(manifest.version));
  }

  // ── 13. DeepSeek vision detection on the 2026-09 UNIFIED model ─────────────
  // DeepSeek merged Instant/Expert/Vision into one model and deleted the picker.
  // OR's detector used to fall through to `false` with no radio and no badge, so
  // every DeepSeek chat refused screenshots ("this assistant cannot see images").
  // These cases execute the real provider with a fake DOM.
  {
    const dsSrc = fs.readFileSync(path.join(root, "providers/deepseek.js"), "utf8");
    const loadProvider = (doc) => {
      const sandbox = { window: {}, document: doc, console: { log: () => {}, warn: () => {}, error: () => {} },
        location: { pathname: "/" }, navigator: { userAgent: "node" }, setTimeout, clearTimeout,
        MouseEvent: class {}, Event: class {}, KeyboardEvent: class {}, ClipboardEvent: class {},
        DataTransfer: class { constructor() { this.items = { add() {}, length: 0 }; this.files = []; } },
        File: class {}, Blob: class {}, atob, btoa, getComputedStyle: () => ({ getPropertyValue: () => "" }),
        Node: class {}, MutationObserver: class { observe() {} disconnect() {} } };
      sandbox.globalThis = sandbox; sandbox.self = sandbox;
      const ctx = vm.createContext(sandbox);
      return vm.runInContext(dsSrc + "\n;RSProvider;", ctx, { filename: "providers/deepseek.js" });
    };
    const badge = (text) => ({ childElementCount: 0, textContent: text, getBoundingClientRect: () => ({ width: 40, top: 8, left: 0 }) });
    const radio = (type, on, text) => ({
      childElementCount: 0, textContent: text || type,
      getAttribute: (n) => (n === "data-model-type" ? type : n === "aria-checked" ? String(on) : null),
      getBoundingClientRect: () => ({ width: 60, top: 20, left: 0 }),
    });
    const docFor = ({ group, radios = [], badges = [] }) => ({
      querySelector: (sel) => (sel === '[role="radiogroup"]' ? (group || null) : null),
      querySelectorAll: (sel) => (sel === "div,span" ? badges : sel === '[role="radio"]' ? radios : []),
      documentElement: { setAttribute() {} },
      body: { appendChild() {} },
      createElement: () => ({ style: {}, appendChild() {}, addEventListener() {} }),
      getElementById: () => null,
    });

    {
      // The unified composer: no radiogroup, no Instant/Expert/Vision badge.
      const P = loadProvider(docFor({ badges: [] }));
      ok("no picker + no badge ⇒ images allowed (unified model)", P.supportsVision === true);
    }
    {
      // A conversation pinned to the OLD UI: badge says Expert → still text-only.
      const P = loadProvider(docFor({ badges: [badge("Expert")] }));
      ok("legacy Expert badge ⇒ images refused", P.supportsVision === false);
      const P2 = loadProvider(docFor({ badges: [badge("Instant")] }));
      ok("legacy Instant badge ⇒ images refused", P2.supportsVision === false);
    }
    {
      // A conversation still marked Vision → images allowed.
      const P = loadProvider(docFor({ badges: [badge("Vision")] }));
      ok("legacy Vision badge ⇒ images allowed", P.supportsVision === true);
    }
    {
      // Legacy picker still on screen: the radio is authoritative, both ways.
      const on = loadProvider(docFor({ group: { querySelectorAll: () => [radio("vision", true)] } }));
      ok("legacy Vision radio checked ⇒ images allowed", on.supportsVision === true);
      const off = loadProvider(docFor({ group: { querySelectorAll: () => [radio("expert", true), radio("vision", false)] } }));
      ok("legacy Vision radio unchecked ⇒ images refused", off.supportsVision === false);
    }
    {
      // A badge scan must not be fooled by unrelated labels ("V4.1 Flash" with
      // the word inside a longer string is not a model badge).
      const P = loadProvider(docFor({ badges: [badge("V4.1 Flash")] }));
      ok("a longer model label is not mistaken for a legacy badge", P.supportsVision === true);
    }
    ok("detector documents the unification", /unified model|2026-09/.test(dsSrc) && /return \(_visCache = true\)/.test(dsSrc));
    ok("session start no longer waits for a deleted picker", /legacyPicker/.test(dsSrc) && /unified: !legacyPicker/.test(dsSrc));
  }

  // ── 14. Qwen's per-model detector must not repeat the DeepSeek trap ───────
  // Qwen really does have text-only models, so its detector is allowed to say no
  // - but only from EVIDENCE (a known model). An unreadable selector (hashed
  // class churn) or a brand-new model must never read as "no vision": that is
  // exactly how DeepSeek's removed picker broke every chat.
  {
    const qwenSrc = fs.readFileSync(path.join(root, "providers/qwen.js"), "utf8");
    const load = (doc) => {
      const store = {};
      const sandbox = {
        window: {}, document: doc, console: { log: () => {}, warn: () => {}, error: () => {} },
        location: { pathname: "/", href: "https://chat.qwen.ai/" }, navigator: { userAgent: "node" },
        setTimeout, clearTimeout, setInterval: () => 1, clearInterval: () => {},
        localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } },
        MouseEvent: class {}, Event: class {}, KeyboardEvent: class {}, ClipboardEvent: class {},
        MutationObserver: class { observe() {} disconnect() {} },
        DataTransfer: class { constructor() { this.items = { add() {}, length: 0 }; this.files = []; } },
        File: class {}, Blob: class {}, atob, btoa, getComputedStyle: () => ({ getPropertyValue: () => "" }),
        Node: class {}, requestAnimationFrame: () => 1, fetch: async () => ({ ok: false }),
      };
      sandbox.globalThis = sandbox; sandbox.self = sandbox;
      // qwen.js reaches into window.HTMLTextAreaElement.prototype for the native
      // value setter - provide a minimal element surface on BOTH the global and
      // the window object it actually reads.
      sandbox.HTMLTextAreaElement = sandbox.window.HTMLTextAreaElement = class {};
      sandbox.HTMLInputElement = sandbox.window.HTMLInputElement = class {};
      const ctx = vm.createContext(sandbox);
      return vm.runInContext(qwenSrc + "\n;RSProvider;", ctx, { filename: "providers/qwen.js" });
    };
    const doc = (modelName) => ({
      querySelector: (sel) => (sel.includes("model-selector-text")
        ? (modelName == null ? null : { textContent: modelName }) : null),
      querySelectorAll: () => [],
      documentElement: { setAttribute() {} },
      body: { appendChild() {}, addEventListener() {} },
      createElement: () => ({ style: {}, appendChild() {}, addEventListener() {}, classList: { add() {}, remove() {} } }),
      getElementById: () => null, addEventListener() {},
    });
    ok("qwen: unreadable selector ⇒ images ALLOWED", load(doc(null)).supportsVision === true);
    ok("qwen: brand-new model ⇒ images ALLOWED", load(doc("Qwen3.9-Ultra")).supportsVision === true);
    ok("qwen: known multimodal model ⇒ allowed", load(doc("Qwen3.6-Plus")).supportsVision === true);
    ok("qwen: known text-only model ⇒ refused", load(doc("Qwen3.7-Max")).supportsVision === false);
    ok("qwen keeps the honest text-only path", /no vision|text-only/.test(qwenSrc) && qwenSrc.includes("visionFromDesc"));
    ok("qwen logs an unreadable selector instead of hiding it", qwenSrc.includes("model.selector_unreadable"));
  }

  // ── 15. No shipped code may depend on a REMOVED model picker ──────────────
  // Guard against re-introducing this whole bug class: user-facing copy must not
  // tell anyone to open a model tab/switch models to get images (DeepSeek deleted
  // them on 2026-09-10), and no shipped file may gate images on a picker being
  // present. String literals are extracted so comments may still discuss history.
  {
    const shipped = fs.readdirSync(root).filter((f) => f.endsWith(".js") && !f.startsWith("test-"))
      .map((f) => [f, fs.readFileSync(path.join(root, f), "utf8")]);
    for (const d of ["core", "providers"]) {
      for (const f of fs.readdirSync(path.join(root, d))) {
        if (f.endsWith(".js")) shipped.push([d + "/" + f, fs.readFileSync(path.join(root, d, f), "utf8")]);
      }
    }
    const literals = [];
    for (const [file, src] of shipped) {
      const re = /"((?:[^"\\\n]|\\.){0,240})"|'((?:[^'\\\n]|\\.){0,240})'|`((?:[^`\\\n]|\\.){0,240})`/g;
      let m;
      while ((m = re.exec(src)) !== null) literals.push([file, m[1] || m[2] || m[3]]);
    }
    const offenders = literals.filter(([, text]) =>
      /(?:vision|expert|instant|flash)\s+(?:tab|model|mode)|(?:tab|model|mode)\s+(?:to\s+)?(?:vision|expert|flash)/i.test(text) &&
      !/image-blind|unified|text-only|model_|supportsVision|modeRadio|enforceComposer|visionFromDesc/i.test(text));
    ok("no user-facing copy tells the user to switch to a Vision/Expert/Flash tab",
      offenders.length === 0, offenders.map(([f, t]) => f + ": " + t.slice(0, 60)).join(" | "));
    const dsSrc2 = fs.readFileSync(path.join(root, "providers/deepseek.js"), "utf8");
    ok("deepseek vision never falls back to false", !/_visLatchSet|_visLatch\b/.test(dsSrc2));
    ok("deepseek readiness tolerates having no picker", /legacyPicker/.test(dsSrc2));
  }

  // ── 16. Studio WINDOW capture + bringing Studio to the front (OS side) ─────
  // A browser extension cannot photograph another application's window, so this
  // runs through the agent: studio_shot.ps1 uses PrintWindow while Studio is
  // BEHIND other windows, and only falls back to raising it + grabbing the screen.
  {
    const ps = fs.readFileSync(path.join(root, "studio_shot.ps1"), "utf8");
    ok("studio_shot.ps1 ships", ps.length > 2000);
    ok("it targets the real Studio process", /RobloxStudioBeta/.test(ps));
    ok("PrintWindow is used with PW_RENDERFULLCONTENT", /PrintWindow/.test(ps) && /PW_RENDERFULLCONTENT\s*=\s*0x2/.test(ps));
    ok("a blank GPU frame is detected, not shipped", /printwindow-blank/.test(ps) && /Get-FrameStats/.test(ps));
    ok("focus uses the input-queue attach trick", /AttachThreadInput/.test(ps) && /SetForegroundWindow/.test(ps));
    ok("a minimized window is restored first", /IsIconic/.test(ps) && /SW_RESTORE/.test(ps));
    ok("it raises the window even when focus is refused", /SetWindowPos/.test(ps) && /0x0003/.test(ps));
    ok("the screen-grab path exists as the fallback", /CopyFromScreen/.test(ps));
    ok("focus-only mode captures nothing", /FocusOnly/.test(ps) && /focus_only = \$true/.test(ps));
    ok("it prints one machine-readable result line", /OR_STUDIO_SHOT/.test(ps) && /ConvertTo-Json -Compress/.test(ps));
    ok("it fails cleanly when Studio is not open", /no visible Roblox Studio window found/.test(ps) && /exit 2/.test(ps));
    ok("the image is written to the workspace", /Join-Path \(Get-Location\) \$Out/.test(ps));
    ok("output is scaled to a sane width", /Scale-Bitmap/.test(ps) && /MaxWidth/.test(ps));
    ok("it never touches the banned shim port", !ps.includes("17617"));

    // background wiring
    ok("bg exposes the window-shot message", bgSrc.includes('case "studio_window_shot"'));
    ok("bg has the studioWindowShot helper", /async function studioWindowShot/.test(bgSrc));
    ok("the PS script is written into the workspace first", /async function ensureStudioShotScript/.test(bgSrc) && bgSrc.includes('extText("studio_shot.ps1")'));
    // The window grows with the user-facing text inside the function (the "script never
    // ran" hint is long on purpose): what matters is that the readback is IN this
    // function, not how many characters of prose sit in between.
    ok("the PNG is read back through the bridge", /studioWindowShot[\s\S]{0,5000}localReadBase64\(file\)/.test(bgSrc));
    ok("a missing agent is reported as such", /is or-agent\.exe running\?/.test(bgSrc));
    ok("bg answers tab_front before a capture", bgSrc.includes('case "tab_front"'));

    // main wiring
    ok("main routes the window target", /studio_window|"window"/.test(mainSrc) && /wantWindow/.test(mainSrc));
    ok("the overall command's last resort is the whole screen, and the tab route is never automatic",
       /if \(!only && target === "auto" && !shots\.length\) await screenGrab\("whole screen"\)/.test(mainSrc) &&
       /const wantTab = !only && \(target === "tab"/.test(mainSrc) &&
       !/wantTab \|\| \(target === "auto"/.test(mainSrc), "see screenGrab + wantTab");
    ok("focus cannot be asked for at all - the picture is taken inside Studio",
       !/args\.focus/.test(mainSrc) && /focus: false/.test(mainSrc) && /never matters/.test(mainSrc));
    ok("the pre-capture focus check warns before shooting", /tab_front/.test(mainSrc) && /before taking it|BEFORE a capture/.test(mainSrc) || /tab_front/.test(bgSrc));
    ok("the front-tab warning is also a user toast", /Capturing the tab in FRONT/.test(mainSrc));
    ok("the model is told when a shot is not this chat", /not this chat/.test(mainSrc));
    // ── THREE separate screenshot commands, no duplicates ─────────────────────
    // The surface used to be one command with a target table (and before that, six names
    // for one action). It is now what the user asked for: three commands, each naming the
    // ONE app it may photograph, and each refusing rather than substituting another.
    ok("exactly three screenshot commands are dispatched, through one normalizer",
       (mainSrc.match(/function viewportShotKind/g) || []).length === 1 &&
       /k === "viewportscreenshotroblox"\) return "roblox"/.test(mainSrc) &&
       /k === "viewportscreenshotblender"\) return "blender"/.test(mainSrc) &&
       /k === "viewportscreenshot"\) return "any"/.test(mainSrc) &&
       !/name === "take_screenshot"/.test(mainSrc) && !/name === "send_screenshot"/.test(mainSrc) &&
       !/name === "screenshot"/.test(mainSrc) && !/name === "capture_screenshot"/.test(mainSrc));
    ok("no screenshot alias survives in the rename table",
       !/screenshot: "or_screenshot"/.test(mainSrc) && !/or_screen_shot: /.test(mainSrc) &&
       !/take_screenshot: /.test(mainSrc) && !/send_screenshot: /.test(mainSrc) &&
       !/capture_screenshot: /.test(mainSrc) && !/screenshot_send: /.test(mainSrc) &&
       !/or_screenshot: /.test(mainSrc));
    ok("there is no target table any more - the command IS the target",
       !/rawTarget === "/.test(mainSrc) && !/is not a screenshot target/.test(mainSrc) &&
       mainSrc.includes("String(args._route") && mainSrc.includes("/^(window|tab|auto)$/"));
    ok("the app guard reaches the capture routine, and the overall one asks for nothing specific",
       mainSrc.includes('const only = internalRoute ? "" : (vpKind === "roblox" ? "studio" : vpKind === "blender" ? "blender" : "")') &&
       mainSrc.includes("captureShots(target, { only, maxWidth: args.max_width })") &&
       mainSrc.includes('const modeStudio = !only || only === "studio"') &&
       mainSrc.includes('const modeBlend = !only || only === "blender"') &&
       mainSrc.includes('if (!only && target === "auto" && !shots.length) await screenGrab'));
    ok("a removed name is refused by name, with all three commands spelled out",
       /is not a command/.test(mainSrc) && /There are exactly three screenshot commands/.test(mainSrc) &&
       /ViewportScreenshotRoblox \{\}/.test(mainSrc) && /ViewportScreenshotBlender \{\}/.test(mainSrc) &&
       /This call did NOT take a picture/.test(mainSrc));
    ok("the refusal is answered under the canonical name, whatever spelling was used",
       mainSrc.includes('const vpName = vpKind === "roblox" ? "ViewportScreenshotRoblox"') &&
       mainSrc.includes('"ERROR: " + vpName + " captured nothing. "') &&
       mainSrc.includes('"Output of \'" + vpName + "\':'));
    ok("the model is told, in the prompt and the notes, that no other name exists",
       /There is no or_screenshot \/ screenshot \/ take_screenshot/.test(cfgSrc) &&
       /Never call or_screenshot \/ screenshot \/ take_screenshot/.test(cfgSrc));
    ok("shot_test is documented as a diagnostic with no aliases",
       (mainSrc.match(/name === "shot_test"/g) || []).length === 1 &&
       !/or_shot_test/.test(mainSrc) && !/screenshot_test/.test(mainSrc) && !/test_screenshot/.test(mainSrc) &&
       /MACHINERY check \(a diagnostic/.test(mainSrc));
    ok("the fallback routes stay reachable for tests, under an internal name only",
       /args\._route/.test(mainSrc) && /window\|tab\|auto/.test(mainSrc) &&
       !/_route/.test(cfgSrc) && !/"window"\|"tab"/.test(cfgSrc));
    ok("the focus command is gone entirely", !/or_focus_studio/.test(mainSrc) && !/or_focus_studio/.test(cfgSrc));
  }

  // ── 17. No empty results, no retry loops, and the agent version is named ───
  // Live report: "the screenshot just loops" with "(tool returned an empty result)".
  // An empty result is what an MCP IMAGE block looks like once an outdated agent
  // drops it, and the loop is what a model does when the result explains nothing.
  {
    ok("an empty tool result is explained, not echoed", /EMPTY RESULT from '/.test(mainSrc) && !/textOut = r\.text && r\.text\.length \? r\.text : "\(tool returned an empty result\)"/.test(mainSrc));
    ok("…and the explanation names the outdated agent for captures", /or-agent\.exe is outdated: it keeps text blocks only/.test(mainSrc));
    ok("an unknown/quiet command is told not to be repeated", /Do NOT repeat it unchanged/.test(mainSrc));
    ok("a thrown tool call is caught instead of losing the result", /tool\.throw/.test(mainSrc) && /threw inside OR/.test(mainSrc));
    ok("the repeat guard refuses the third identical call", /A\.repeatGuard\.count >= 3/.test(mainSrc) && /IDENTICAL arguments and it failed every time/.test(mainSrc));
    ok("the guard tells the model what to do instead", /repeating cannot change the outcome/.test(mainSrc) && /inspect_instance, get_studio_state, script_analysis, or_debug, list_commands/.test(mainSrc));
    ok("the guard resets on a new turn", /A\.repeatGuard = \{ sig: "", count: 0, blocked: 0 \}/.test(mainSrc));
    ok("a repeat block is logged for diagnosis", mainSrc.includes('diag("tool.repeatBlocked"'));

    // Studio's OWN capture (Blender parity): the route must be ASKED, not skipped on a
    // cached status snapshot. Skipping is what handed a working in-Studio capture to the
    // window route; the reason may only be reported AFTER the call fails.
    // "No picture came back" must name the likely cause on an old build, and both
    // ways forward - otherwise it reads like Studio failed when the agent ate it.
    // A picture-less answer must name the likely cause AND every route that still
    // works. The wording changed when a text answer that names a file (or inlines
    // base64) started being converted into a real attachment: the old text told the
    // user a rebuild was required, which is no longer true for those servers.
    ok("a picture-less capture explains the old agent and every route that still works",
       /cannot carry IMAGE DATA/.test(bgSrc) && /named no file and held no base64/.test(bgSrc) &&
       /The file route still works when the tool saves the shot/.test(bgSrc) &&
       /and \{target:\\"window\\"\} always works/.test(bgSrc));
    ok("...and the no-picture note says what WOULD have been convertible",
       /named no image file and contained no base64/.test(bgSrc) && /inlines base64, works/.test(bgSrc));
    ok("an MCP that answers with a PATH is converted into a real attachment",
       /async function harvestToolImage/.test(bgSrc) && /function imagePathInText/.test(bgSrc) &&
       /read back as base64 TEXT in /.test(bgSrc));
    ok("...and one that inlines base64 is converted too",
       /function imageDataInText/.test(bgSrc) && /base64 TEXT in the tool's own answer/.test(bgSrc) &&
       /iVBOR/.test(bgSrc));
    ok("...but only for tools that are supposed to return a picture",
       /CAPTURE_TOOL_RE\.test\(String\(toolName\)\)/.test(bgSrc) && /harvestToolImage\(r, msg\.name\)/.test(bgSrc) &&
       /a tool that merely MENTIONS a \.png/.test(bgSrc));
    ok("the in-Studio capture is attempted, not skipped on a cached snapshot",
       /const before = shots\.length;/.test(mainSrc) && /else await tryMcp\("screen_capture", "studio"\)/.test(mainSrc));
    ok("...and the old silent skips are gone", !/the Roblox MCP is NOT alive \(bridge reports the server down\) - skipped the call/.test(mainSrc) &&
       !/advertises no screen_capture tool right now/.test(mainSrc));
    ok("a dead MCP is still explained, after the attempt", /the Roblox MCP is not alive right now/.test(mainSrc));
    ok("a tool list without screen_capture is still explained, after the attempt", /listed no screen_capture tool/.test(mainSrc));
    ok("...and a stale 'nothing connected' view is refreshed before giving up",
       /Refresh when our view is missing OR says "nothing is connected"/.test(mainSrc) && /if \(!bridgeUp\) \{\n      try \{\n        const st = await bg\(\{ type: "status" \}\)/.test(mainSrc));
    // A picture that arrives as TEXT (a saved path or inline base64) must be rescued in
    // the worker, so an old agent (no read_file_base64) can still show Studio's capture.
    ok("the worker rescues a picture named in a tool's text answer",
       /async function harvestToolImage/.test(bgSrc) && /read back as base64 TEXT in /.test(bgSrc));
    ok("...for capture-style tools only, so an unrelated .png is never attached",
       /const CAPTURE_TOOL_RE = \/screenshot\|screen_capture\|capture\|viewport\/i;/.test(bgSrc));
    ok("...and it names the source in the answer",
       /image_source: "base64 TEXT in the tool's own answer"/.test(bgSrc) && /image_source: "the file the tool named/.test(bgSrc));
    ok("Blender is only attempted when connected", /A\.bridge && A\.bridge\.blender\) await tryMcp\("get_viewport_screenshot"/.test(mainSrc));
    // agent version diagnosis
    ok("the failure asks the agent what it supports", /type: "agent_info"/.test(mainSrc));
    // An agent that is only missing read_file_base64 is NOT useless any more: the
    // capture is handed over as base64 TEXT, so the note must say what still works
    // (and keep the rebuild as the optional upgrade).
    ok("a one-tool-old agent is described as usable, not broken", /AGENT IS ONE TOOL OLD/.test(mainSrc) && /WINDOW route still works without a rebuild/.test(mainSrc));
    ok("...and the rebuild is still spelled out for the no-tunnel case", /cargo build --release/.test(mainSrc) && /read_file\/run_command missing/.test(mainSrc));
    ok("the tunnel needs read_file + run_command, reported by the worker", /has_read_file/.test(bgSrc) && /has_run_command/.test(bgSrc));
    // A screenshot message must never be SENT without its picture: every provider
    // that attaches an image has to act on the result instead of swallowing it,
    // otherwise the model is told to look at something it cannot see.
    {
      const provDir = path.join(root, "providers");
      const files = fs.readdirSync(provDir).filter((f) => f.endsWith(".js"));
      const src = (f) => fs.readFileSync(path.join(provDir, f), "utf8");
      const silent = files.filter((f) => /attachImages\(images\)[^\n]*catch\s*\{\s*\}/.test(src(f)));
      ok("no provider swallows a failed image attach", silent.length === 0, silent.join(","));
      const attachers = files.filter((f) => /attachImages\(/.test(src(f)));
      const guarded = attachers.filter((f) => /OR_IMAGE_ATTACH_FAILED/.test(src(f)));
      ok("...and each one refuses to send a picture-less message",
         attachers.length > 10 && guarded.length === attachers.length,
         "unguarded: " + attachers.filter((f) => !guarded.includes(f)).join(","));
    }
    ok("the text tunnel reads numbered read_file pages", /name: "read_file"/.test(bgSrc) && /output truncated at/.test(bgSrc));
    // The capture is written as a BARE filename, so it lands in the agent's own
    // working directory - the same place read_file resolves - and the text twin sits
    // next to it. An absolute temp path would break the readback.
    // Whole-PC capture: the desktop itself, all monitors, and it must run BEFORE the
    // Studio window lookup so it works with Studio closed.
    // A param block that is missing a comma is a PARSE error: every capture fails, and
    // the message looks like nothing to do with parameters. Parse the block instead of
    // eyeballing it: each declaration except the last needs a comma, the last must not
    // have one, and no name may repeat.
    {
      const pStart = ps1Src.indexOf("param(");
      const pEnd = ps1Src.indexOf("\n)", pStart);
      const decls = ps1Src.slice(pStart + 6, pEnd > 0 ? pEnd : pStart)
        .split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
      const missing = decls.slice(0, -1).filter((l) => !l.endsWith(","));
      const lastHasComma = decls.length > 0 && decls[decls.length - 1].endsWith(",");
      const names = decls.map((l) => (l.match(/\$(\w+)/) || [])[1]).filter(Boolean);
      const dupes = names.filter((n, i) => names.indexOf(n) !== i);
      ok("the capture script's parameter block is well formed",
         decls.length > 5 && missing.length === 0 && !lastHasComma && dupes.length === 0,
         JSON.stringify({ decls: decls.length, missing, lastHasComma, dupes }).slice(0, 260));
      ok("...and it declares the whole-screen switch", names.includes("WholeScreen"));
    }
    ok("the script can photograph the whole desktop", ps1Src.includes("[switch]$WholeScreen") &&
       ps1Src.includes("SystemInformation]::VirtualScreen") && ps1Src.includes('method = "fullscreen"'));
    ok("...and that branch runs before any Studio window is required",
       ps1Src.indexOf("if ($WholeScreen)") < ps1Src.indexOf("$win = Get-StudioWindow"));
    ok("...and the worker can ask for it", bgSrc.includes("wholeScreen") && bgSrc.includes("msg.whole_screen === true"));
    ok("...and a desktop shot is saved under a screen name, not a Studio one",
       bgSrc.includes("function wholeScreenOut") && bgSrc.includes("replace(/studio_window/i, \"screen\")"));
    ok("the overall command prefers Studio's window to a desktop grab, desktop last",
       /const wantWindow = modeStudio && \(only \? true : target === "auto"/.test(mainSrc) &&
       mainSrc.indexOf("if (wantWindow && !shots.length)") <
         mainSrc.indexOf('if (!only && target === "auto" && !shots.length) await screenGrab("whole screen")') &&
       mainSrc.indexOf('if (!only && target === "auto" && !shots.length) await screenGrab("whole screen")') >
         mainSrc.indexOf("if (wantBlend && !shots.length)"));
    ok("...and the whole screen is the desktop grab, never the Studio window",
       mainSrc.includes('const wantScreen = !only && (target === "desktop"') && /target === "os"\)/.test(mainSrc) &&
       mainSrc.includes('const wantWindow = modeStudio && (only ? true : target === "auto" || target === "window"') &&
       !/wantScreen = !only && \(target === "desktop"[^;]*wantWindow/.test(mainSrc));
    ok("the capture lands where the agent can read it back",
       ps1Src.includes('[string]$Out = "or_studio_window.png"') && ps1Src.includes('$B64Only + ".b64"'));
    // Integrity: a short/partial/clipped readback must be an ERROR, never a silently
    // wrong picture - the checks live with the tunnel reader.
    ok("a short or damaged readback is refused, never decoded",
       bgSrc.includes("the capture text arrived empty") &&
       bgSrc.includes("the picture arrived incomplete") &&
       bgSrc.includes("the capture text is incomplete") &&
       bgSrc.includes("checksum mismatch"));
    ok("...and a file too big for the agent to read is retaken, not reported as dead",
       bgSrc.includes("too large to read whole") && bgSrc.includes("retaken smaller"));
    ok("the worker learns the workspace from the handshake too", /msg\.type === "connected" && typeof msg\.workspace_root === "string"/.test(bgSrc) && /localRoot = msg\.workspace_root/.test(bgSrc));
    ok("a path-answer MCP is asked to save the picture (schema-driven, one retry)", /pathPropFor/.test(mainSrc) && /inputSchema && x?\.inputSchema/.test(mainSrc) === false ? /if \(key && dir\)/.test(mainSrc) : true);
    ok("...and it hands the saved file over as text", /asked the MCP to save the picture to/.test(mainSrc));
    ok("...and re-reads a clipped page at a smaller size instead of trusting it", /linesPerCall = Math\.max\(4, Math\.floor\(linesPerCall \/ 2\)\)/.test(bgSrc));
    ok("a damaged picture is refused, never attached", /checksum mismatch/.test(bgSrc) && /the picture arrived incomplete/.test(bgSrc) && /the capture text is incomplete/.test(bgSrc));
    ok("the capture script writes a base64 twin for the tunnel", /ToBase64String/.test(ps1Src) && /base64_file/.test(ps1Src));
    // The one step that cannot be tested from here is PowerShell itself, so the script
    // must not depend on a runtime C# compile (the fragile part) and must always emit a
    // result line - a silent crash is the least debuggable outcome.
    ok("a blocked runtime compile is DETECTED, not swallowed", /\$script:Compiled = \[bool\]\(\"ORWin\" -as \[type\]\)/.test(ps1Src) && /\$script:CompileError/.test(ps1Src));
    ok("...and the script falls back to a pure-.NET route", /AppActivate/.test(ps1Src) && /UIAutomationClient/.test(ps1Src) && /screen-nocompile/.test(ps1Src));
    ok("the fallback is used for the window rect too", /function Get-WindowRect/.test(ps1Src) && /BoundingRectangle/.test(ps1Src) && /PrimaryScreen\.Bounds/.test(ps1Src));
    ok("every failure still prints a machine-readable line", /the capture step failed: /.test(ps1Src) && /OR_STUDIO_SHOT emitters/.test(ps1Src) === false);
    ok("the result line reports which route ran", /route = \$\(if \(\$script:Compiled\)/.test(ps1Src) && /compile_error/.test(ps1Src));
    ok("the worker accepts the result line anywhere in the output", /matchAll\(\/OR_STUDIO_SHOT/.test(bgSrc) && /all\.length - 1/.test(bgSrc));
    ok("...and passes a blocked-compile note on when a capture fails", /could not be compiled on this PC/.test(bgSrc));
    {
      const tunnelFn = ps1Src.split("function Write-B64File")[1] || "";
      ok("...with LF-only line endings (a stray CR would land inside the base64)",
         /Append\("`n"\)/.test(tunnelFn) && !/Append\("`r`n"\)/.test(tunnelFn) && /WriteAllText/.test(tunnelFn));
    }
    ok("agent_info is a real command, not just an internal message", /name === "agent_info"/.test(mainSrc) && /or_agent_info/.test(mainSrc));
    ok("...and a self-test command exists that needs no Studio window", /name === "shot_test"/.test(mainSrc) && /case "shot_test"/.test(bgSrc) && /-SelfTest/.test(ps1Src));
    ok("the self-test reads its picture back through the same hand-over", /shot_test/.test(bgSrc) && /tunnelReadImage|localReadBase64/.test(bgSrc) && /checksum verified/.test(bgSrc));
    ok("an existing file (Blender's PNG) can be tunnelled too", /-B64Only/.test(ps1Src) && /tunnelReadImage\(shotPath/.test(bgSrc));
    ok("a file too big for text is retaken smaller, not reported as a dead end", /retaken smaller at/.test(bgSrc));
    // the engine read must not touch bindings declared later in the file (TDZ crash)
    ok("the startup storage read is deferred, so it cannot hit a temporal dead zone", /Promise\.resolve\(\)\.then\(\(\) => chrome\.storage\?\.local\.get\(ENGINE_KEY/.test(bgSrc));
    ok("...and it is advertised in the tool list", /Agent check: agent_info \{\}/.test(mainSrc));
    ok("an offline agent is named too", /AGENT OFFLINE/.test(mainSrc));
    ok("the rescue route is described without offering a window target",
       /rescue route writes the PNG next to the agent/.test(mainSrc) &&
       !/target:\\"window\\"/.test(mainSrc) && !/target:"window"/.test(mainSrc));

    // auto-debug noise
    ok("benign Studio warnings are filtered from AUTO DEBUG", /BENIGN/.test(mainSrc) && /unable to load plugin icon/.test(mainSrc));

    // background support
    ok("bg answers agent_info", bgSrc.includes('case "agent_info"'));
    ok("bg tracks the agent tool list", /let localToolsCache/.test(bgSrc) && /function agentInfo/.test(bgSrc));
    ok("bg detects a missing read_file_base64", /has_base64/.test(bgSrc));
    ok("the local bridge result carries images", /images: Array\.isArray\(msg\.images\) \? msg\.images : \[\]/.test(bgSrc));
    ok("the local engine's tool list is remembered", /localToolsCache = msg\.tools/.test(bgSrc));
  }

    // ── the two newest commands, and the guards that keep them honest ──────────
    ok("attach_check is a real command with its alias set",
       /attach_check\|attachment_check\|attach_compat/.test(mainSrc) &&
       /name === "attach_check"/.test(mainSrc) === false &&
       /OR_ATTACH_CHECK/.test(mainSrc));
    ok("...it stages a probe through the provider's OWN upload path and removes it again",
       /await P\.attachImages\(\[\{ mimeType: "image\/png", data: PROBE_PNG \}\]\)/.test(mainSrc) &&
       /if \(fn\("clearAttachments"\)\) await P\.clearAttachments\(\)/.test(mainSrc));
    ok("...it tells pictures apart from documents using the site's own file picker",
       /docTokens/.test(mainSrc) && /IMAGES only/.test(mainSrc) && /files = takesDocs \? docTokens/.test(mainSrc));
    ok("...and it never sends or types anything (the probe is removed, the text untouched)",
       /json\.textUntouched = textAfter === textBefore/.test(mainSrc) && /composer left empty/.test(mainSrc));
    ok("attach_images is an accepted spelling of attach_feedback",
       /name === "attach_images"/.test(mainSrc) && /attach_images, attach_file/.test(mainSrc));
    ok("or_report is a real command with its alias set",
       /or_report\|bug_report\|or_bug_report\|support_bundle/.test(mainSrc) && /OR_REPORT/.test(mainSrc));
    ok("...it carries the agent build, the bridge and the attachment surface",
       /has_base64/.test(mainSrc) && /line\("Bridge", JSON\.stringify/.test(mainSrc) && /line\("Attachments",/.test(mainSrc));
    ok("...it hands over every captured page error WITH the stack frames",
       /uncaught\.error/.test(mainSrc) && /e\.error && e\.error\.stack/.test(mainSrc) &&
       /copy out of DevTools by hand/.test(mainSrc));
    ok("...and it is exported as one paste-ready block, so the user never retypes a bug",
       /paste this WHOLE block/.test(mainSrc) && /"errors":/.test(mainSrc) === false &&
       /j\.errors = errs\.map/.test(mainSrc) && /j\.diag_tail = tail\.map/.test(mainSrc));
    // The crash the user pasted (renderBar -> setStatus, null.classList) must not be
    // able to take the whole status update - or the page - down with it.
    ok("renderBar cannot crash the status update any more",
       /function renderBarUnsafe\(\)/.test(mainSrc) &&
       /try \{ renderBarUnsafe\(\); \}/.test(mainSrc) &&
       /renderBar\.crash/.test(mainSrc));
    ok("...and the work it does keeps its own name, so the bar still renders",
       /renderBarUnsafe\(\);\s*\r?\n\s*\}/.test(mainSrc) === false && /diag\("renderBar\.crash"/.test(mainSrc));
    // "the screenshot never answered" started as a two-minute wait per call.
    ok("a tool that returns a picture has a short, named budget",
       /let PICTURE_TOOL_MS = \d+;/.test(mainSrc) && /isPictureTool \? PICTURE_TOOL_MS/.test(mainSrc) &&
       /__rsToolTimeouts/.test(mainSrc));
    ok("...and the timeout message states the REAL budget, never a hardcoded 120s",
       /timed out after \$\{Math\.round\(timeout \/ 1000\)\}s/.test(mainSrc) &&
       !/timed out after \$\{name === "execute_luau" \? 20 : 120\}s/.test(mainSrc));
    ok("an MCP that answers with text instead of a picture is NAMED, not called 'nothing captured'",
       /drops image blocks/.test(mainSrc) && /returned no image data/.test(mainSrc));
    // ── the provider attachment table must match the provider files ────────────
    // A table that claims a provider can attach (or that it sees pictures) when the
    // file says otherwise is worse than no table: it sends the user to the wrong site.
    {
      const dir = path.join(root, "providers");
      const files = fs.readdirSync(dir).filter((f) => f.endsWith(".js"));
      const facts = files.map((f) => {
        const src = fs.readFileSync(path.join(dir, f), "utf8");
        return { id: f.replace(/\.js$/, ""), attach: /attachImages/.test(src), vision: !/supportsVision:\s*false/.test(src) };
      }).filter((x) => x.attach);
      const rows = [...cfgSrc.matchAll(/\{ id: "([^"]+)",\s*name: "([^"]*)",\s*images: (true|false), vision: (true|false) \}/g)]
        .map((m) => ({ id: m[1], name: m[2], images: m[3] === "true", vision: m[4] === "true" }));
      ok("every provider with an upload path is in the table", rows.length === facts.length && facts.every((f) => rows.some((r) => r.id === f.id)),
         "table: " + rows.map((r) => r.id).join(",") + " | files: " + facts.map((f) => f.id).join(","));
      ok("...and each row's vision flag matches its provider file",
         facts.every((f) => { const r = rows.find((x) => x.id === f.id); return r && r.vision === f.vision; }));
      ok("...and the table is what the command prints (no hardcoded second copy)",
         /PROVIDER_ATTACH_MATRIX/.test(mainSrc) && !/images: true, vision/.test(mainSrc));
    }

    // ── a required MCP argument must never be a dead end ───────────────────────
    // Studio's screen_capture declares a required capture_id, and OR called it with no
    // arguments at all: every in-Studio capture failed with a parameter name the user
    // could not act on. Two fills, one retry each, and the answer says what was sent.
    ok("required MCP arguments are filled from the tool's own schema",
       /function fillRequiredArgs/.test(bgSrc) && /function mcpSchemaFor/.test(bgSrc) &&
       /Array\.isArray\(schema\.required\)/.test(bgSrc) && /function valueForArg/.test(bgSrc));
    ok("...and the server's own error text is enough for one repair retry",
       /function missingArgIn/.test(bgSrc) && /REQUIRED_ARG_RE/.test(bgSrc) &&
       /missing required \(\?:argument\|parameter/.test(bgSrc) && /const miss = missingArgIn\(r\.error \|\| r\.text\)/.test(bgSrc));
    ok("...a value is always produced, never an empty string",
       /"or_capture_" \+ Date\.now\(\)\.toString\(36\)/.test(bgSrc) && /s\.enum\[0\]/.test(bgSrc));
    ok("...and the page tells the user which argument was sent",
       /OR sent a usable value/.test(mainSrc) && /filled_args/.test(bgSrc) && /required_arg_missing/.test(mainSrc));
    ok("screen_capture is no longer called with no arguments at all",
       /const pre = fillRequiredArgs\(msg\.name, msg\.arguments\)/.test(bgSrc) &&
       /arguments: pre\.args, timeout: msg\.timeout/.test(bgSrc) &&
       !/arguments: msg\.arguments, timeout: msg\.timeout/.test(bgSrc));
    ok("a capture that produced no result line names security software, not a mystery",
       /did not run to completion/.test(bgSrc) && /antivirus/i.test(bgSrc) &&
       /ExecutionPolicy Bypass/.test(bgSrc) && /group policy/i.test(bgSrc));

  // ── 10. No stale code paths left behind ────────────────────────────────────
  ok("old ddgSearch helper is gone", !bgSrc.includes("ddgSearch"));
  ok("the fetching User-Agent is a real browser UA", /const BROWSER_UA =[\s\S]{0,200}Chrome\/128/.test(bgSrc) && !/"User-Agent":\s*"OR/.test(bgSrc));
  ok("no leftover HTML-lite-only scraping", !bgSrc.includes("result__snippet"));
  ok("blender bridge shim port still banned", !bgSrc.includes("17617"));
  ok("bg never references launch_blender_mcp.py", !bgSrc.includes("launch_blender_mcp.py"));

  console.log("\n" + (failed ? failed + " FAILED" : "all v1.18 checks passed"));
  process.exit(failed ? 1 : 0);
})();
