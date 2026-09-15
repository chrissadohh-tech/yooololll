// SPDX-License-Identifier: GPL-3.0-or-later
// background.js - service worker.
// Owns ONE resilient WebSocket to the local bridge (ws://127.0.0.1:PORT).
// Keeping the socket here (not in the content script) avoids https→ws mixed
// content issues and centralises reconnect / timeout logic.
//
// Contract with content.js: every sendMessage ALWAYS gets a response object,
// even when the bridge is offline. The agentic loop must never hang waiting.

const PORT_ROBLOX = 17613;
const PORT_LOCAL = 17615; // AgentScript — native FS/terminal engine
const BLENDER_ADDON_PORT = 9876;
const RUST_ROBLOX_HTTP = "http://127.0.0.1:3000";
const ENGINE_KEY = "rs-engine";
// "anim" (Animation mode) is a persona-driven view of the SAME Roblox bridge:
// it maps to 17613 everywhere a port/HTTP target is picked, but keeps its own
// id so prompts, accents and UI state stay engine-isolated.
const ENGINES = ["roblox", "local"];
function normalizeEngine(v) { return v === "local" ? "local" : "roblox"; }
let engine = "roblox"; // "roblox" | "local"
let rustMode = false; // true if Rust agent on 3000 is reachable (preferred)
// Deferred by one microtask on purpose: this callback touches ws / connected /
// reconnectDelay, all of which are declared FURTHER DOWN this file, so a callback
// that ran synchronously would land in their temporal dead zone and kill the whole
// service worker - the same failure class as the RECENT_IMAGES_MAX screenshot crash.
// The harness reproduces it by answering storage synchronously. Chrome's API is async,
// so this only costs one tick, and it removes the landmine for good.
Promise.resolve().then(() => chrome.storage?.local.get(ENGINE_KEY, (o) => {
  const want = normalizeEngine(o && o[ENGINE_KEY]);
  if (want !== engine) {
    engine = want;
    log(`engine init corrected to ${engineLabel()} -> ${engineUrl()}`);
    try { ws?.close(); } catch {}
    connected = false;
    reconnectDelay = RECONNECT_MIN;
    connect();
    broadcastStatus();
  }
}));
// Probe Rust agent on 3000 at startup — if reachable, use HTTP pipe (CORS bypass) as primary
(async () => {
  try {
    const r = await fetch(`${RUST_ROBLOX_HTTP}/api/status`, { method: "GET" });
    if (r.ok) {
      rustMode = true;
      log("Rust agent detected on 3000 — HTTP pipe enabled (CORS bypass via background)");
    }
  } catch {}
})();
function engineUrl() { return `ws://127.0.0.1:${engine === "local" ? PORT_LOCAL : PORT_ROBLOX}`; }
function engineHttpUrl() { return RUST_ROBLOX_HTTP; }
function engineLabel() { return engine === "local" ? "AgentScript" : "Roblox"; }
chrome.storage?.onChanged.addListener((changes, area) => {
  if (area === "local" && changes[ENGINE_KEY]) {
    const want = normalizeEngine(changes[ENGINE_KEY].newValue);
    if (want === engine) return; // dedupe rs-set-engine double fire
    engine = want;
    log(`engine switched to ${engineLabel()} -> ${engineUrl()} — FULL ISOLATION`);
    try { ws?.close(); } catch {}
    connected = false;
    mcpAlive = false;
    toolsCache = [];
    serversCache = [];
    studioConnected = null;
    studioApp = null;
    studioProc = null;
    failAllPending(`engine switched to ${engine}`);
    reconnectDelay = RECONNECT_MIN;
    connect();
    broadcastStatus();
  }
});

// Chat sites where an OR provider content script runs. Status pushes go
// to every tab matching these. Add the new provider's URL pattern here (and in
// manifest.json content_scripts + host_permissions) when integrating another AI.
const PROVIDER_URLS = ["https://chat.deepseek.com/*", "https://deepseek.com/*", "https://chatgpt.com/*", "https://chat.openai.com/*", "https://claude.ai/*", "https://www.claude.ai/*", "https://claude.com/*", "https://www.claude.com/*", "https://gemini.google.com/*", "https://www.kimi.com/*", "https://kimi.com/*", "https://kimi.ai/*", "https://www.kimi.ai/*", "https://chat.z.ai/*", "https://chat.qwen.ai/*", "https://arena.ai/*", "https://freebuff.ai/*", "https://www.freebuff.ai/*", "https://freebuff.com/*", "https://www.freebuff.com/*", "https://www.meta.ai/*", "https://meta.ai/*", "https://github.com/copilot", "https://github.com/copilot/*", "https://copilot.microsoft.com/*", "https://m365.cloud.microsoft/*", "https://gpt.crax.lol/*", "https://use.ai/*", "https://www.use.ai/*", "https://oxalpha.com/*", "https://www.oxalpha.com/*", "https://oxalpha.org/*", "https://www.oxalpha.org/*", "http://localhost/*", "http://127.0.0.1/*", "https://ollama.com/*", "https://*.ollama.com/*"];

const RECONNECT_MIN = 500;
const RECONNECT_MAX = 5000;
const HEARTBEAT_MS = 10000;
// If no message (incl. pong) arrives within this window while we believe we're
// connected, the socket is half-open: force a reconnect instead of letting
// pending requests slowly time out.
const STALE_SOCKET_MS = 140000; // above 120s tool timeout so a long execute_luau never looks half-open
const REQUEST_TIMEOUT_DEFAULT = 130000; // a bit above the 120s tool timeout

let ws = null;
let connected = false;
let reconnectDelay = RECONNECT_MIN;
let reconnectTimer = null;
let heartbeatTimer = null;
let lastMessageAt = 0; // timestamp of the last frame received from the bridge
let nextId = 1;
const pending = new Map(); // id -> {resolve, timer}
let toolsCache = [];
let mcpAlive = false;
let serversCache = [];
// true/false = a PLACE is loaded and usable in Roblox Studio; null = unknown.
// The MCP process stays alive when Studio is closed or its MCP option is off,
// so this is probed separately (bridge "studio_status").
let studioConnected = null;
// true/false = a Roblox Studio app is connected to the MCP server at all; null =
// unknown. studioApp=true with studioConnected=false means "Studio open but no
// place"; studioApp=false means "Studio closed OR its MCP option disabled".
let studioApp = null;
// true/false = a Roblox Studio WINDOW/PROCESS exists on this machine (checked
// bridge-side via tasklist); null = unknown/old bridge. Distinguishes the two
// studioApp=false sub-cases the UI must word differently: Studio genuinely not
// launched ("open Roblox Studio") vs Studio OPEN but its MCP plugin never
// registered with the bridge - the documented fix for the latter is opening
// Assistant Settings > MCP Servers inside Studio (validated live 3x), which
// "open Roblox Studio" wording completely fails to convey.
let studioProc = null;
let robloxProc = false;
// Editor-backed status. A local bridge socket is not an editor connection.
let robloxEditorConnected = false;
let localReady = false; // agent's workspace is up (from /api/status local_ready)
let localFull = false; // AgentScript FULL PC ACCESS (agent is source of truth)
let localRoot = ""; // workspace path, injected into the AI's state line
let blenderAddon = false; // blender-mcp addon listening on TCP 9876
let blenderError = "";
let blenderScriptsReady = false;
const BLENDER_TOOL_NAMES = new Set([
  "get_scene_info", "get_object_info", "execute_blender_code", "get_viewport_screenshot",
  "blender_export_fbx", "blender_import_fbx", "blender_export_obj", "blender_import_obj",
  "blender_mesh_dump", "blender_send_to_studio", "blender_execute_code",
  "blender_get_scene_info", "blender_get_object_info", "blender_screenshot",
  "export_blender_fbx", "import_blender_fbx",
]);
function btool(name, description, props, required) {
  return { name, server: "blender", description, inputSchema: { type: "object", properties: props || {}, required: required || [] } };
}
const BLENDER_TOOLS = [
  btool("get_scene_info", "Inspect the live Blender scene (objects, cameras, lights, collections).", {}, []),
  btool("get_object_info", "Details for one object in the Blender scene.", { name: { type: "string" } }, ["name"]),
  btool("execute_blender_code", "Run Python (bpy) inside Blender. Prefer the named blender_* tools.", { code: { type: "string" } }, ["code"]),
  btool("get_viewport_screenshot", "Capture the Blender 3D viewport.", { max_size: { type: "integer" } }, []),
  btool("blender_send_to_studio", "ONE SHOT: dump the live Blender meshes and import them into Roblox Studio as Workspace.OR_Imported. No filepath needed.", { objects: { type: "array", items: { type: "string" } }, dest: { type: "string" }, scale: { type: "number" } }, []),
  btool("blender_export_fbx", "Export meshes to an FBX (Forward -Z, Up Y). filepath optional. Also dumps meshes so blender_send_to_studio / asset_bridge_import can run with no path.", { filepath: { type: "string" }, objects: { type: "array", items: { type: "string" } } }, []),
  btool("blender_import_fbx", "Import an FBX into the live Blender scene. filepath optional — defaults to the last OR export.", { filepath: { type: "string" } }, []),
  btool("blender_export_obj", "Export selected/all meshes to OBJ. filepath optional.", { filepath: { type: "string" }, objects: { type: "array", items: { type: "string" } } }, []),
  btool("blender_import_obj", "Import an OBJ into the live Blender scene.", { filepath: { type: "string" } }, ["filepath"]),
  btool("blender_add_cube", "Add a cube.", { name: { type: "string" }, size: { type: "number" }, location: { type: "array", items: { type: "number" } } }, []),
  btool("blender_add_sphere", "Add a UV sphere.", { name: { type: "string" }, radius: { type: "number" }, location: { type: "array" } }, []),
  btool("blender_add_cylinder", "Add a cylinder.", { name: { type: "string" }, radius: { type: "number" }, depth: { type: "number" }, location: { type: "array" } }, []),
  btool("blender_add_cone", "Add a cone.", { name: { type: "string" }, radius: { type: "number" }, depth: { type: "number" }, location: { type: "array" } }, []),
  btool("blender_add_plane", "Add a plane.", { name: { type: "string" }, size: { type: "number" }, location: { type: "array" } }, []),
  btool("blender_add_torus", "Add a torus.", { name: { type: "string" }, location: { type: "array" } }, []),
  btool("blender_add_monkey", "Add Suzanne (monkey head).", { name: { type: "string" }, location: { type: "array" } }, []),
  btool("blender_add_empty", "Add an Empty (use as a group parent).", { name: { type: "string" }, location: { type: "array" } }, []),
  btool("blender_add_camera", "Add a camera.", { name: { type: "string" }, location: { type: "array" } }, []),
  btool("blender_add_light", "Add a light (SUN/POINT/SPOT/AREA).", { name: { type: "string" }, type: { type: "string" }, location: { type: "array" }, energy: { type: "number" } }, []),
  btool("blender_group", "Group objects: parent them to a new Empty and put them in a collection of the same name.", { name: { type: "string", description: "Group name" }, objects: { type: "array", items: { type: "string" }, description: "Object names; omit = selected/all meshes" } }, []),
  btool("blender_ungroup", "Ungroup: clear parent, keep world transforms, remove the group Empty.", { name: { type: "string" } }, []),
  btool("blender_parent", "Parent objects under an existing object/Empty.", { parent: { type: "string" }, objects: { type: "array", items: { type: "string" } } }, ["parent"]),
  btool("blender_unparent", "Clear parent, keep world transforms.", { objects: { type: "array", items: { type: "string" } } }, []),
  btool("blender_join", "Join mesh objects into one.", { objects: { type: "array", items: { type: "string" } }, name: { type: "string" } }, []),
  btool("blender_move_to_collection", "Move objects into a collection (created if missing).", { collection: { type: "string" }, objects: { type: "array", items: { type: "string" } } }, []),
  btool("blender_list_collections", "List collections and their objects.", {}, []),
  btool("blender_list_objects", "List every object: type, location, parent, collections.", {}, []),
  btool("blender_delete", "Delete objects.", { name: { type: "string" }, objects: { type: "array", items: { type: "string" } } }, []),
  btool("blender_duplicate", "Duplicate objects.", { name: { type: "string" }, objects: { type: "array", items: { type: "string" } } }, []),
  btool("blender_rename", "Rename an object.", { name: { type: "string" }, new_name: { type: "string" } }, ["new_name"]),
  btool("blender_select", "Select objects by name.", { name: { type: "string" }, objects: { type: "array", items: { type: "string" } } }, []),
  btool("blender_transform", "Set location / rotation (radians) / scale.", { name: { type: "string" }, objects: { type: "array" }, location: { type: "array" }, rotation: { type: "array" }, scale: { type: "array" } }, []),
  btool("blender_apply_transforms", "Apply rotation/scale (and optional location).", { objects: { type: "array" }, location: { type: "boolean" }, rotation: { type: "boolean" }, scale: { type: "boolean" } }, []),
  btool("blender_set_origin", "Set object origin (ORIGIN_GEOMETRY, ORIGIN_CURSOR, ORIGIN_CENTER_OF_MASS).", { name: { type: "string" }, type: { type: "string" } }, []),
  btool("blender_shade_smooth", "Shade smooth.", { name: { type: "string" }, objects: { type: "array" } }, []),
  btool("blender_set_material", "Assign a Principled BSDF material. color = [r,g,b] or [r,g,b,a] 0–1.", { name: { type: "string" }, material: { type: "string" }, color: { type: "array" } }, []),
  // ── Material toolkit ──
  btool("blender_material_create", "Create a node-based material (optionally assigning it). Either a preset, explicit PBR values, or both. color = [r,g,b(,a)] 0–1, [r,g,b] 0–255, or '#rrggbb'.", { material: { type: "string" }, preset: { type: "string", description: "metal, steel, iron, chrome, gold, silver, copper, bronze, brass, plastic, rubber, ceramic, concrete, asphalt, wood, marble, fabric, leather, glass, frosted_glass, water, ice, emissive, neon, lava, hologram, ghost, toon, roblox_plastic, roblox_metal, roblox_glass" }, color: { type: "array" }, metallic: { type: "number" }, roughness: { type: "number" }, ior: { type: "number" }, transmission: { type: "number" }, alpha: { type: "number" }, emission: { type: "array" }, emission_strength: { type: "number" }, coat: { type: "number" }, sheen: { type: "number" }, blend: { type: "string", description: "BLEND / HASHED / OPAQUE" }, name: { type: "string", description: "object to assign to" }, objects: { type: "array" }, append_slot: { type: "boolean" } }, ["material"]),
  btool("blender_material_preset", "Create a material from a named preset in one call (see blender_material_create for the list) and assign it.", { material: { type: "string" }, preset: { type: "string" }, name: { type: "string" }, objects: { type: "array" }, color: { type: "array" } }, ["preset"]),
  btool("blender_material_set", "Change values on an EXISTING material (color, metallic, roughness, emission, alpha, ior, transmission, coat, sheen, blend).", { material: { type: "string" }, color: { type: "array" }, metallic: { type: "number" }, roughness: { type: "number" }, emission: { type: "array" }, emission_strength: { type: "number" }, alpha: { type: "number" }, transmission: { type: "number" }, ior: { type: "number" }, coat: { type: "number" }, sheen: { type: "number" }, blend: { type: "string" } }, ["material"]),
  btool("blender_material_assign", "Assign an existing material to objects (all slots, one slot, or append a new slot).", { material: { type: "string" }, name: { type: "string" }, objects: { type: "array" }, slot: { type: "integer" }, append: { type: "boolean" } }, ["material"]),
  btool("blender_material_list", "List every material: users, Principled values, plus the known preset names.", {}, []),
  btool("blender_material_inspect", "Dump one material completely: Principled BSDF inputs, linked inputs, node graph, users.", { material: { type: "string" }, name: { type: "string" } }, []),
  btool("blender_material_remove", "Delete a material from the file.", { material: { type: "string" } }, ["material"]),
  btool("blender_material_noise", "Add a procedural texture to a material (noise, voronoi, wave, checker, brick, gradient) driving bump, base color, roughness or emission.", { material: { type: "string" }, type: { type: "string" }, affect: { type: "string", description: "bump | base_color | roughness | emission" }, scale: { type: "number" }, detail: { type: "number" }, roughness: { type: "number" }, distortion: { type: "number" }, strength: { type: "number" }, color_a: { type: "array" }, color_b: { type: "array" }, replace: { type: "boolean" } }, ["material"]),
  btool("blender_material_image", "Wire an image file into a material slot (base_color, roughness, metallic, normal, emission).", { material: { type: "string" }, path: { type: "string" }, slot: { type: "string" }, strength: { type: "number" }, alpha_to_alpha: { type: "boolean" }, colorspace: { type: "string" } }, ["material", "path"]),
  btool("blender_material_pbr", "Build a full PBR graph from map files (base_color/albedo + optional orm, roughness, metallic, normal, emission) with correct Non-Color colorspaces.", { material: { type: "string" }, base_color: { type: "string" }, albedo: { type: "string" }, orm: { type: "string" }, roughness: { type: "string" }, metallic: { type: "string" }, normal: { type: "string" }, emission: { type: "string" } }, ["material"]),
  btool("blender_add_modifier", "Add a modifier: SUBSURF, BEVEL, SOLIDIFY, MIRROR, ARRAY, BOOLEAN, DECIMATE. apply=true to apply.", { name: { type: "string" }, type: { type: "string" }, levels: { type: "integer" }, apply: { type: "boolean" }, target: { type: "string" } }, []),
  btool("blender_boolean", "Boolean one mesh with another (DIFFERENCE/UNION/INTERSECT) and apply.", { name: { type: "string" }, target: { type: "string" }, operation: { type: "string" } }, ["target"]),
  btool("blender_clear_scene", "Delete objects. keep = names to leave.", { keep: { type: "array", items: { type: "string" } } }, []),
  btool("blender_add_grid", "Add a grid.", { name: { type: "string" }, size: { type: "number" }, location: { type: "array" } }, []),
  btool("blender_add_text", "Add 3D text. text=string, extrude=thickness.", { name: { type: "string" }, text: { type: "string" }, extrude: { type: "number" }, location: { type: "array" } }, []),
  btool("blender_translate", "Move objects by offset [x,y,z] (relative).", { offset: { type: "array" }, name: { type: "string" }, objects: { type: "array" } }, []),
  btool("blender_rotate", "Set rotation in DEGREES [x,y,z]. add=true to add.", { rotation_deg: { type: "array" }, add: { type: "boolean" }, name: { type: "string" }, objects: { type: "array" } }, []),
  btool("blender_set_dimensions", "Set object size in meters [x,y,z].", { dimensions: { type: "array" }, name: { type: "string" } }, []),
  btool("blender_origin_to_bottom", "Put origin at the lowest point (Roblox feet).", { name: { type: "string" }, objects: { type: "array" } }, []),
  btool("blender_drop_to_ground", "Move objects so the lowest vertex sits on Z=0.", { name: { type: "string" }, objects: { type: "array" } }, []),
  btool("blender_array", "Duplicate along offset, count times.", { count: { type: "integer" }, offset: { type: "array" }, objects: { type: "array" } }, []),
  btool("blender_mirror", "Mirror-duplicate across X/Y/Z.", { axis: { type: "string" }, objects: { type: "array" } }, []),
  btool("blender_triangulate", "Convert faces to triangles (needed before Studio).", { objects: { type: "array" } }, []),
  btool("blender_apply_modifiers", "Apply every modifier so dump/export sees the result.", { objects: { type: "array" } }, []),
  btool("blender_merge", "Merge-by-distance (remove doubles).", { distance: { type: "number" }, objects: { type: "array" } }, []),
  btool("blender_recalc_normals", "Recalculate outside normals.", { objects: { type: "array" } }, []),
  btool("blender_hide", "Hide objects.", { name: { type: "string" }, objects: { type: "array" } }, []),
  btool("blender_unhide", "Unhide objects (omit names = all).", { name: { type: "string" }, objects: { type: "array" } }, []),
  btool("blender_undo", "Undo last Blender action.", {}, []),
  btool("blender_stats", "Vertex/face/modifier counts.", { objects: { type: "array" } }, []),
  btool("blender_get_selection", "Names of selected objects.", {}, []),
  btool("blender_uv_unwrap", "Smart UV project.", { objects: { type: "array" } }, []),
  btool("blender_look_at", "Point an object/camera at a target or location.", { name: { type: "string" }, target: { type: "string" }, location: { type: "array" } }, []),
  btool("blender_align_camera", "Align the scene camera to an axis (front/back/left/right/top/bottom/iso) looking at a target or the selection.", { axis: { type: "string" }, distance: { type: "number" }, target: { type: "string" }, name: { type: "string" } }, []),
  btool("blender_align_camera_axis", "Same as blender_align_camera.", { axis: { type: "string" }, distance: { type: "number" }, target: { type: "string" }, name: { type: "string" } }, []),
  btool("blender_view_axis", "Align the 3D viewport to FRONT/BACK/LEFT/RIGHT/TOP/BOTTOM (or iso via camera).", { axis: { type: "string" } }, []),
  btool("blender_camera_to_view", "Move the scene camera to match the current 3D viewport.", {}, []),
  btool("blender_set_camera_lens", "Set camera focal length, clip planes, or orthographic mode.", { name: { type: "string" }, lens: { type: "number" }, clip_start: { type: "number" }, clip_end: { type: "number" }, ortho: { type: "boolean" }, ortho_scale: { type: "number" } }, []),
  btool("blender_scale", "Scale selected/named objects. scale:[x,y,z] or a number. multiply=true multiplies current scale.", { name: { type: "string" }, scale: { type: "array" }, factor: { type: "array" }, multiply: { type: "boolean" } }, []),
  btool("blender_bevel", "Bevel mesh edges in edit mode.", { name: { type: "string" }, width: { type: "number" }, segments: { type: "number" } }, []),
  btool("blender_solidify", "Add a Solidify modifier (thickness).", { name: { type: "string" }, thickness: { type: "number" } }, []),
  btool("blender_extrude", "Extrude the mesh along normals.", { name: { type: "string" }, distance: { type: "number" } }, []),
  btool("blender_add_curve", "Add a Bezier curve.", { name: { type: "string" }, location: { type: "array" } }, []),
  btool("blender_add_armature", "Add an armature (single bone).", { name: { type: "string" }, location: { type: "array" } }, []),
  btool("blender_keyframe_insert", "Insert a keyframe on location/rotation/scale (or data_path) at frame.", { name: { type: "string" }, frame: { type: "number" }, data_path: { type: "string" } }, []),
  btool("blender_set_frame", "Set the current scene frame.", { frame: { type: "number" } }, []),
  btool("blender_set_active_camera", "Make a camera the scene camera.", { name: { type: "string" } }, []),
  btool("blender_track_to", "TRACK_TO constraint from selected objects toward target.", { target: { type: "string" }, name: { type: "string" } }, ["target"]),
  btool("blender_cursor_to_selected", "Move the 3D cursor to the selection midpoint.", { name: { type: "string" } }, []),
  btool("blender_randomize_transform", "Jitter location/rotation/scale of selected objects.", { name: { type: "string" }, location: { type: "number" }, rotation: { type: "number" }, scale: { type: "number" }, seed: { type: "number" } }, []),
  btool("blender_hide_render", "Hide (or unhide) objects from render.", { name: { type: "string" }, hide: { type: "boolean" } }, []),
  btool("blender_subdivision", "Add a Subdivision Surface modifier.", { name: { type: "string" }, levels: { type: "number" }, render_levels: { type: "number" } }, []),
  btool("blender_origin_to_geometry", "Set origin to geometry for selected objects.", { name: { type: "string" } }, []),
];
for (const t of BLENDER_TOOLS) BLENDER_TOOL_NAMES.add(t.name);

function blenderServers(list) {
  const rest = (Array.isArray(list) ? list : []).filter((s) => s && s.id !== "blender");
  if (blenderAddon) {
    rest.push({
      id: "blender", name: "Blender",
      alive: true, tools: BLENDER_TOOLS.length,
    });
  }
  return rest;
}
function mergeBlenderTools(tools) {
  const base = Array.isArray(tools) ? tools.slice() : [];
  if (!blenderAddon) return base;
  const have = new Set(base.map((t) => t && t.name));
  for (const t of BLENDER_TOOLS) if (!have.has(t.name)) base.push(t);
  return base;
}

function log(...a) {
  console.log("[or-bg]", ...a);
}

// ── WebSocket lifecycle ─────────────────────────────────────────────────
function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }
  clearTimeout(reconnectTimer);
  const url = engineUrl();
  let sock;
  try {
    sock = new WebSocket(url);
  } catch (e) {
    log("WebSocket ctor failed", e);
    scheduleReconnect();
    return;
  }
  ws = sock;

  sock.onopen = () => {
    if (sock !== ws) return;
    connected = true;
    reconnectDelay = RECONNECT_MIN;
    lastMessageAt = Date.now();
    log(`connected to ${engineLabel()} bridge (${url})`);
    startHeartbeat();
    refreshProcStatus();
    broadcastStatus();
  };

  sock.onmessage = (ev) => {
    if (sock !== ws) return;
    lastMessageAt = Date.now();
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    // The agent names its workspace in its handshake. Remember it HERE as well as
    // from the HTTP API: a capture must never have to guess where to write a file
    // just because that one request was slow or blocked.
    if (msg && msg.type === "connected" && typeof msg.workspace_root === "string" && msg.workspace_root) localRoot = msg.workspace_root;
    handleBridgeMessage(msg);
  };

  sock.onclose = () => {
    if (sock !== ws) return;
    connected = false;
    mcpAlive = false;
    studioConnected = null;
    studioApp = null;
    studioProc = null;
    robloxEditorConnected = false;
    toolsCache = [];
    serversCache = [];
    stopHeartbeat();
    failAllPending("bridge connection closed");
    broadcastStatus();
    scheduleReconnect();
  };

  sock.onerror = () => {
    if (sock !== ws) return;
    // onclose will follow; nothing to do here but avoid an unhandled error.
    try { sock.close(); } catch {}
  };
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connect, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 1.7, RECONNECT_MAX);
}

function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    if (connected) {
      // Half-open socket: the WS still reports OPEN but nothing comes through.
      // The pong (and every other frame) refreshes lastMessageAt; if it has
      // gone stale, drop the dead socket so onclose triggers a reconnect.
      const toolPending = [...pending.values()].some((p) => p.type === "call_tool");
      if (lastMessageAt && Date.now() - lastMessageAt > STALE_SOCKET_MS) {
        if (toolPending) return; // execute_luau owns the helper — pong resumes after it
        log("socket stale, forcing reconnect");
        try { ws.close(); } catch {}
        return;
      }
      // Keeps the MV3 service worker alive AND detects a half-open socket.
      // Use short timeout so pending ping doesn't leak for 130s
      send({ type: "ping" }, 12000).catch(() => {});
      refreshStudioStatus();
      // ── MCP auto-heal (v1.12) ────────────────────────────────────────────
      // The StudioMCP helper the agent spawns can die on its own (Studio
      // update, sleep/resume, crash). The agent only recycles it when a TOOL
      // call proves the helper dead - so between calls the bar kept showing
      // "connected" with a corpse helper and every command failed. If the
      // helper has been dead for two consecutive heartbeats, restart it
      // proactively (max once per 3 min so a legitimately closed Studio can't
      // cause a restart loop - the agent refuses when Studio's MCP option is
      // off, and that answer must win).
      if ((engine === "roblox" || engine === "anim") && !toolPending) {
        // Studio closed / MCP plugin off: do not restart-loop the helper.
        if (studioProc === false || studioApp === false) {
          mcpDownStreak = 0;
        } else if (!mcpAlive) {
          mcpDownStreak++;
          // Idle heal: one missed heartbeat, 30s cooldown. Never heal mid-tool.
          if (mcpDownStreak >= 1 && Date.now() - lastMcpHealAt > 30000) {
            lastMcpHealAt = Date.now();
            mcpDownStreak = 0;
            log("MCP helper down across heartbeats - auto-restarting Studio MCP");
            send({ type: "restart_mcp" }, 30000).then((r) => {
              if (r && r.ok) {
                send({ type: "list_tools" }, 10000).catch(() => {});
                refreshStudioStatus();
              }
            }).catch(() => {});
          }
        } else {
          mcpDownStreak = 0;
        }
      }
    }
  }, HEARTBEAT_MS);
}
// Auto-heal state (see startHeartbeat).
let mcpDownStreak = 0;
let lastMcpHealAt = 0;

function stopHeartbeat() {
  clearInterval(heartbeatTimer);
  heartbeatTimer = null;
}

// Resolve once the socket is OPEN, or false after `timeout` ms.
function waitForConnection(timeout = 20000) {
  return new Promise((resolve) => {
    if (connected && ws && ws.readyState === WebSocket.OPEN) return resolve(true);
    connect(); // nudge a (re)connection - important after a worker wake-up
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (connected && ws && ws.readyState === WebSocket.OPEN) {
        clearInterval(iv);
        resolve(true);
      } else if (Date.now() - t0 > timeout) {
        clearInterval(iv);
        resolve(false);
      }
    }, 100);
  });
}

// ── request/response over the socket ────────────────────────────────────
// opts.connectWait - how long to wait for the socket to OPEN (default 20s, right for
// real work because an MV3 worker may have just woken up). A SCREENSHOT passes a
// short budget: half a minute is not worth it when other routes can be tried instead.
async function send(obj, timeout = REQUEST_TIMEOUT_DEFAULT, opts) {
  // The MV3 service worker can be suspended; the first message after a wake-up
  // arrives before the socket has re-opened. Wait for it instead of failing -
  // otherwise Kimi wrongly hears "bridge offline".
  if (!connected || !ws || ws.readyState !== WebSocket.OPEN) {
    await waitForConnection((opts && opts.connectWait) || 20000);
  }
  const attempt = () => new Promise((resolve) => {
    if (!connected || !ws || ws.readyState !== WebSocket.OPEN) {
      resolve({ ok: false, kind: "disconnected", error: "bridge not connected" });
      return;
    }
    const id = nextId++;
    const payload = { ...obj, id };
    const timer = setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        resolve({ ok: false, kind: "timeout", error: "bridge did not respond in time" });
      }
    }, timeout);
    pending.set(id, { resolve, timer, type: obj.type });
    try {
      ws.send(JSON.stringify(payload));
    } catch (e) {
      clearTimeout(timer);
      pending.delete(id);
      resolve({ ok: false, kind: "disconnected", error: String(e) });
    }
  });
  let r = await attempt();
  if (r && r.kind === "disconnected") {
    await waitForConnection((opts && opts.connectWait) ? (opts.connectWait) : 15000);
    if (!connected || !ws || ws.readyState !== WebSocket.OPEN) return r;   // asked to be quick: give up now
    r = await attempt();
  }
  return r;
}

// Ask the bridge whether a Roblox Studio instance is actually connected to the
// MCP server. Broadcasts only on change so the UI updates promptly but quietly.
let studioProbing = false;
async function refreshStudioStatus() {
  if (studioProbing || !connected) return;
  if ([...pending.values()].some((p) => p.type === "call_tool")) return;
  studioProbing = true;
  try {
    const r = await send({ type: "studio_status" }, 12000);
    const v = r && r.ok && typeof r.studio === "boolean" ? r.studio : null;
    if (engine === "roblox" || engine === "anim") robloxEditorConnected = v === true;
    // local readiness comes from the agent's /api/status (local_ready), not editor probes
    if (v !== studioConnected) {
      studioConnected = v;
      broadcastStatus();
    } else {
      // The probe result can change independently of the tri-state cache when a
      // timeout returns null, so still publish the strict editor flag.
      broadcastStatus();
    }
  } finally {
    studioProbing = false;
  }
}

function handleBridgeMessage(msg) {
  if ("studio" in msg && (typeof msg.studio === "boolean" || msg.studio === null)) {
    studioConnected = msg.studio;
  }
  if ("studio_app" in msg && (typeof msg.studio_app === "boolean" || msg.studio_app === null)) {
    studioApp = msg.studio_app;
  }
  if ("studio_proc" in msg && (typeof msg.studio_proc === "boolean" || msg.studio_proc === null)) {
    studioProc = msg.studio_proc;
  }
  if (msg.type === "studio_status") {
    const online = studioConnected === true;
    if (engine === "roblox" || engine === "anim") robloxEditorConnected = online;
    resolvePending(msg.id, { ok: true, studio: online });
    broadcastStatus();
    return;
  }
  if (msg.type === "connected") {
    mcpAlive = !!msg.mcp_alive;
    if (Array.isArray(msg.tools)) toolsCache = msg.tools;
    if (Array.isArray(msg.servers)) serversCache = msg.servers;
    const online = msg.studio === true;
    if (engine === "roblox" || engine === "anim") robloxEditorConnected = online;
    broadcastStatus();
    return;
  }
  if (msg.type === "pong") {
    resolvePending(msg.id, { ok: true });
    return;
  }
  if (msg.type === "tools") {
    if (Array.isArray(msg.tools)) toolsCache = msg.tools;
    if (Array.isArray(msg.servers)) serversCache = msg.servers;
    mcpAlive = !!msg.mcp_alive;
    const online = msg.studio === true;
    if (engine === "roblox" || engine === "anim") robloxEditorConnected = online;
    resolvePending(msg.id, { ok: !!msg.ok, tools: toolsCache, studio: online });
    broadcastStatus();
    return;
  }
  if (msg.type === "tool_result") {
    resolvePending(msg.id, msg.ok
      ? { ok: true, text: msg.text, images: msg.images || [] }
      : { ok: false, kind: msg.kind, error: msg.error });
    return;
  }
  if (msg.type === "mcp_status") {
    mcpAlive = !!msg.alive;
    if (Array.isArray(msg.tools)) toolsCache = msg.tools;
    if (Array.isArray(msg.servers)) {
      serversCache = msg.servers;
      const rbx = serversCache.find((x) => x.id === "roblox" || x.id === "studio");
      if (rbx) robloxEditorConnected = !!rbx.alive;
      const loc = serversCache.find((x) => x.id === "local");
      if (loc) localReady = !!loc.alive;
    }
    resolvePending(msg.id, { ok: !!msg.ok, alive: mcpAlive, error: msg.error });
    broadcastStatus();
    return;
  }
  if (msg.type === "server_changed") {
    // The bridge acks, then restarts itself to reload config.json. The socket
    // will drop right after this - the content script shows a spinner until the
    // reconnect lands and a fresh status arrives.
    resolvePending(msg.id, { ok: !!msg.ok, error: msg.error, restarting: !!msg.restarting });
    return;
  }
  if (msg.type === "error") {
    resolvePending(msg.id, { ok: false, error: msg.error });
    return;
  }
}

function resolvePending(id, value) {
  const p = pending.get(id);
  if (!p) return;
  clearTimeout(p.timer);
  pending.delete(id);
  p.resolve(value);
}

function failAllPending(reason) {
  for (const [, p] of pending) {
    clearTimeout(p.timer);
    p.resolve({ ok: false, kind: "disconnected", error: reason });
  }
  pending.clear();
}

// ── status push to any open DeepSeek tab + popup ─────────────────────────
function statusObj() {
  return {
    type: "rs-status", connected, mcpAlive, studio: studioConnected, studioApp, studioProc,
    robloxProc, roblox_connected: robloxEditorConnected,
    local_connected: localReady, local_full: localFull,
    local_root: localRoot,
    tools: mergeBlenderTools(toolsCache).length,
    servers: blenderServers(serversCache), engine,
    blender: blenderAddon, blender_error: blenderError || undefined,
  };
}

async function refreshProcStatus() {
  try {
    const r = await fetch(`${RUST_ROBLOX_HTTP}/api/status`, { method: "GET" });
    if (!r.ok) return;
    const j = await r.json();
    const nr = !!j.roblox_proc;
    const nl = j.local_ready === true;
    const nf = j.local_full === true;
    const nrRoot = typeof j.local_root === "string" ? j.local_root : localRoot;
    const changed = nr !== robloxProc || nl !== localReady || nf !== localFull || nrRoot !== localRoot;
    robloxProc = nr;
    localReady = nl;
    localFull = nf;
    localRoot = nrRoot;
    // One-shot re-sync: if the agent restarted with FULL off but the user's
    // persisted toggle says ON, re-apply their choice once.
    if (!fullSyncedOnce) {
      fullSyncedOnce = true;
      try {
        chrome.storage.local.get("rs-local-full", (o) => {
          const want = o && o["rs-local-full"];
          if (typeof want === "boolean" && want !== nf) {
            fetch("http://127.0.0.1:3000/api/local-full", {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ enabled: want }),
            }).then((r2) => r2.json()).then((j2) => { localFull = j2.local_full === true; broadcastStatus(); }).catch(() => {});
          }
        });
      } catch {}
    }
    if (changed) broadcastStatus();
  } catch {}
}

function broadcastStatus() {
  chrome.runtime.sendMessage(statusObj()).catch(() => {});
  chrome.tabs.query({ url: PROVIDER_URLS }, (tabs) => {
    for (const t of tabs) chrome.tabs.sendMessage(t.id, statusObj()).catch(() => {});
  });
}


// ── Web tools (search + fetch) ──────────────────────────────────────────────
// Health notes (why this is not one DDG call anymore):
//  * html.duckduckgo.com/html/ is the endpoint OR used to scrape with a
//    "OR/1.0" UA. DDG now treats that as an anomaly: it answers 202/403 with a
//    challenge page that contains ZERO .result__a anchors, so the old parser
//    returned [] and the tool reported "no results" on every query.
//  * A browser UA + Accept-Language + Referer is required for the same URL to
//    serve real results, and even then DDG rate-limits datacenter IPs.
//  * So: try several independent backends in order, use a REAL browser UA, and
//    fall back to a generic anchor parser per backend (markup drifts; a
//    changed class name must not zero out the whole tool).
// Every backend failure is collected and reported, so "it doesn't work" is
// always accompanied by WHY (status codes included) instead of a bare "no
// results for X".
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";
const WEB_FETCH_TIMEOUT = 20000;
const WEB_SEARCH_TIMEOUT = 12000;

function webHeaders(extra, referer) {
  const h = {
    "User-Agent": BROWSER_UA,
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.7",
    "Accept-Language": "en-US,en;q=0.9",
    "Cache-Control": "no-cache",
  };
  if (referer) h.Referer = referer;
  return Object.assign(h, extra || {});
}

// A hung fetch is worse than a failed one: the content script's bg() has no
// timeout of its own, so an endpoint that never answers used to spin the tool
// forever. AbortController gives every request a hard deadline.
async function fetchWithTimeout(url, opts, ms) {
  const ctrl = typeof AbortController === "function" ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => { try { ctrl.abort(); } catch {} }, ms || WEB_FETCH_TIMEOUT) : null;
  try {
    return await fetch(url, Object.assign({ redirect: "follow" }, opts || {}, ctrl ? { signal: ctrl.signal } : {}));
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const ENTITIES = {
  nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'", "#x27": "'",
  mdash: "—", ndash: "–", hellip: "…", rsquo: "’", lsquo: "‘", ldquo: "“", rdquo: "”",
  middot: "·", times: "×", deg: "°", copy: "©", reg: "®", trade: "™", euro: "€", pound: "£",
};
function decodeEntities(s) {
  // Numeric forms first, then named. &amp; is decoded LAST via a single pass so
  // a literal "&amp;lt;" does not turn into "<" (double-decoding).
  return String(s || "")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch { return " "; } })
    .replace(/&#(\d+);/g, (_, d) => { try { return String.fromCodePoint(Number(d)); } catch { return " "; } })
    .replace(/&([a-z#0-9x]+);/gi, (m, name) => {
      const key = String(name).toLowerCase();
      if (key === "amp") return "&";
      return Object.prototype.hasOwnProperty.call(ENTITIES, key) ? ENTITIES[key] : m;
    });
}

function stripTags(html) {
  return decodeEntities(String(html || "").replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

// DDG wraps every result link as /l/?uddg=<urlencoded>&rut=…
function unwrapDdg(href) {
  let h = String(href || "").trim();
  if (h.startsWith("//")) h = "https:" + h;
  const m = h.match(/[?&]uddg=([^&]+)/);
  if (m) { try { return decodeURIComponent(m[1]); } catch { return h; } }
  const m2 = h.match(/[?&]url=([^&]+)/);
  if (m2 && /duckduckgo\.com\/l\//.test(h)) { try { return decodeURIComponent(m2[1]); } catch {} }
  return h;
}

function cleanHits(list, n, engineHost) {
  const out = [];
  const seen = new Set();
  for (const r of list) {
    let url = String((r && r.url) || "").trim();
    const title = stripTags((r && r.title) || "");
    if (!/^https?:\/\//i.test(url)) continue;
    if (engineHost && url.includes(engineHost)) continue;
    if (!title || title.length < 3) continue;
    const key = url.replace(/[#?].*$/, "").replace(/\/+$/, "");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ title: title.slice(0, 180), url });
    if (out.length >= n) break;
  }
  return out;
}

// Last-resort parser: ANY anchor with an http(s) href and real text. Used when
// a backend's markup changed (or is unknown) so the tool still returns hits.
function parseGenericAnchors(html, n, engineHost) {
  const hits = [];
  const re = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(String(html || ""))) !== null) {
    const url = unwrapDdg(m[1]);
    const title = stripTags(m[2]);
    if (!title || title.length < 12 || title.length > 180) continue;
    hits.push({ url, title });
  }
  return cleanHits(hits, n, engineHost);
}

function parseDdgHtml(html, n) {
  const hits = [];
  const re = /<a\b[^>]*class="[^"]*result__a[^"]*"[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(String(html || ""))) !== null) hits.push({ url: unwrapDdg(m[1]), title: m[2] });
  // class before href (older markup) — attribute order is not guaranteed.
  if (!hits.length) {
    const re2 = /<a\b[^>]*href=["']([^"']+)["'][^>]*class="[^"]*result__a[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
    while ((m = re2.exec(String(html || ""))) !== null) hits.push({ url: unwrapDdg(m[1]), title: m[2] });
  }
  const clean = cleanHits(hits, n, "duckduckgo.com");
  return clean.length ? clean : parseGenericAnchors(html, n, "duckduckgo.com");
}

function parseDdgLite(html, n) {
  const hits = [];
  const re = /<a\b[^>]*class="[^"]*result-link[^"]*"[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(String(html || ""))) !== null) hits.push({ url: unwrapDdg(m[1]), title: m[2] });
  const clean = cleanHits(hits, n, "duckduckgo.com");
  return clean.length ? clean : parseGenericAnchors(html, n, "duckduckgo.com");
}

function parseMojeek(html, n) {
  const hits = [];
  const re = /<a\b[^>]*class="[^"]*\bob\b[^"]*"[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(String(html || ""))) !== null) hits.push({ url: m[1], title: m[2] });
  if (!hits.length) {
    const re2 = /<h2>\s*<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    while ((m = re2.exec(String(html || ""))) !== null) hits.push({ url: m[1], title: m[2] });
  }
  const clean = cleanHits(hits, n, "mojeek.com");
  return clean.length ? clean : parseGenericAnchors(html, n, "mojeek.com");
}

// Wikipedia has a real JSON API with CORS — not scraped, so it never breaks.
// Not a general web search, but an excellent last resort for API/property
// questions and it keeps the tool useful when every scraper is blocked.
function parseWikipedia(json, n) {
  const out = [];
  try {
    const rows = (JSON.parse(json).query || {}).search || [];
    for (const r of rows) {
      out.push({
        title: r.title + " — Wikipedia",
        url: "https://en.wikipedia.org/wiki/" + encodeURIComponent(String(r.title).replace(/ /g, "_")),
      });
      if (out.length >= n) break;
    }
  } catch {}
  return out;
}

const SEARCH_BACKENDS = [
  { id: "duckduckgo", url: (q) => "https://html.duckduckgo.com/html/?q=" + encodeURIComponent(q), parse: parseDdgHtml, referer: "https://duckduckgo.com/" },
  { id: "ddg-lite", url: (q) => "https://lite.duckduckgo.com/lite/?q=" + encodeURIComponent(q), parse: parseDdgLite, referer: "https://lite.duckduckgo.com/" },
  { id: "mojeek", url: (q) => "https://www.mojeek.com/search?q=" + encodeURIComponent(q), parse: parseMojeek, referer: "https://www.mojeek.com/" },
  { id: "wikipedia", url: (q) => "https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&srlimit=5&srsearch=" + encodeURIComponent(q), parse: parseWikipedia, json: true, referer: "https://en.wikipedia.org/" },
];

// Try every backend until one yields hits. Returns { hits, backend, notes }.
async function webSearch(query, limit) {
  const q = String(query || "").trim();
  const n = Math.max(1, Math.min(8, Number(limit) || 3));
  if (!q) return { hits: [], backend: null, notes: ["empty query"] };
  const notes = [];
  for (const b of SEARCH_BACKENDS) {
    try {
      const extra = b.json ? { Accept: "application/json,text/plain,*/*" } : null;
      const res = await fetchWithTimeout(b.url(q), { headers: webHeaders(extra, b.referer) }, WEB_SEARCH_TIMEOUT);
      if (!res.ok) { notes.push(`${b.id}: HTTP ${res.status}`); continue; }
      const body = await res.text();
      const hits = b.parse(body, n);
      if (hits.length) return { hits, backend: b.id, notes };
      notes.push(`${b.id}: no results parsed${/anomaly|captcha|unusual traffic/i.test(body) ? " (bot challenge page)" : ""}`);
    } catch (e) {
      notes.push(`${b.id}: ${String((e && e.message) || e).slice(0, 90)}`);
    }
  }
  return { hits: [], backend: null, notes };
}

function htmlToText(html) {
  let s = String(html || "");
  s = s.replace(/<script[\s\S]*?<\/script>/gi, " ");
  s = s.replace(/<style[\s\S]*?<\/style>/gi, " ");
  s = s.replace(/<noscript[\s\S]*?<\/noscript>/gi, " ");
  s = s.replace(/<!--[\s\S]*?-->/g, " ");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<\/(p|div|h[1-6]|li|tr|section|article|header|footer|blockquote|pre|ul|ol|table)>/gi, "\n");
  s = s.replace(/<(p|div|h[1-6]|li|tr|section|article|header|footer|blockquote|pre|ul|ol|table)\b[^>]*>/gi, "\n");
  s = s.replace(/<[^>]+>/g, " ");
  s = decodeEntities(s);
  s = s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").replace(/[ \t]{2,}/g, " ").trim();
  return s;
}

// A JS-only shell ("enable JavaScript", a few hundred chars) is not a page we
// can read; the reader proxy renders it server-side and returns Markdown.
function looksLikeShell(text) {
  const t = String(text || "");
  if (t.length < 400) return true;
  return /enable javascript|javascript is (required|disabled)|checking your browser|just a moment|cf-browser-verification/i.test(t.slice(0, 600));
}
async function readerFallback(url, maxChars) {
  const res = await fetchWithTimeout("https://r.jina.ai/" + url, { headers: webHeaders() }, WEB_FETCH_TIMEOUT);
  if (!res.ok) throw new Error("reader HTTP " + res.status);
  let text = await res.text();
  if (!text || text.length < 40) throw new Error("reader returned nothing");
  const orig = text.length;
  if (orig > maxChars) text = text.slice(0, maxChars) + `\n\n…[truncated ${orig - maxChars} chars]`;
  return text;
}


// ── Blender (one-shot TCP 9876 via AgentScript) ─────────────────────────
// Native or-agent.exe rejects add_server/uvx. Chrome cannot open raw TCP.
// Connect is a short PowerShell/Python probe of the blender-mcp addon the
// user already started. Tool calls write a JSON request, run blender_once,
// then read the JSON response. No daemon, so the agent console is not
// flooded with failed `start /B py` / shim-restart loops.
function isBlenderToolName(name) {
  const bare = String(name || "").split("/").pop().split(".").pop();
  return BLENDER_TOOL_NAMES.has(bare) || /^blender_/.test(bare);
}
const BLENDER_KEY = "rs-blender-on";
try {
  chrome.storage?.local.get(BLENDER_KEY, (o) => {
    if (o && o[BLENDER_KEY]) blenderAddon = true;
  });
} catch {}
function setBlender(on, err) {
  const was = blenderAddon;
  blenderAddon = !!on;
  blenderError = on ? "" : (err || blenderError);
  try { chrome.storage.local.set({ [BLENDER_KEY]: !!on }); } catch {}
  if (was !== blenderAddon) broadcastStatus();
}

async function sendLocalEngine(obj, timeout = 25000) {
  if (engine === "local" && connected && ws && ws.readyState === WebSocket.OPEN) {
    return send(obj, timeout);
  }
  return await new Promise((resolve) => {
    let sock;
    try { sock = new WebSocket(`ws://127.0.0.1:${PORT_LOCAL}`); }
    catch (e) { resolve({ ok: false, error: "or-agent.exe is not running" }); return; }
    const id = 800000 + Math.floor(Math.random() * 99999);
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { sock.close(); } catch {}
      resolve(v);
    };
    const timer = setTimeout(() => done({ ok: false, error: "or-agent.exe did not answer — is it running?" }), timeout);
    sock.onerror = () => done({ ok: false, error: "or-agent.exe is not running" });
    sock.onopen = () => {
      try { sock.send(JSON.stringify({ ...obj, id })); }
      catch (e) { done({ ok: false, error: String(e) }); }
    };
    sock.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type === "connected") {
        if (typeof msg.workspace_root === "string" && msg.workspace_root) localRoot = msg.workspace_root;
        if (Array.isArray(msg.tools)) localToolsCache = msg.tools;
        return;
      }
      if (msg.type === "tools" && (msg.id == null || msg.id === id)) {
        if (Array.isArray(msg.tools)) localToolsCache = msg.tools;
        done({ ok: !!msg.ok, tools: msg.tools || [], text: "" });
        return;
      }
      if (msg.type === "tool_result" && (msg.id == null || msg.id === id)) {
        // Images (and their mime types) ride along, so a Studio/Blender capture
        // can be attached instead of being reported as an empty result.
        done(msg.ok
          ? { ok: true, text: msg.text, images: Array.isArray(msg.images) ? msg.images : [] }
          : { ok: false, error: msg.error || "tool failed" });
        return;
      }
      if (msg.type === "error" && (msg.id == null || msg.id === id)) {
        done({ ok: false, error: msg.error || "error" });
      }
    };
  });
}

// The local engine's advertised tool names, remembered from its `connected` /
// `tools` frames. Used to answer "is this or-agent.exe new enough to hand the
// browser a FILE (read_file_base64)?" - every screenshot path needs that, and an
// outdated exe fails silently, which is what makes screenshots look broken.
let localToolsCache = [];
function localToolNames() {
  return localToolsCache.map((t) => (t && (t.name || t.id)) || "").filter(Boolean);
}
async function agentInfo() {
  let names = localToolNames();
  if (!names.length) {
    try {
      const r = await sendLocalEngine({ type: "list_tools" }, 8000);
      if (r && Array.isArray(r.tools)) { localToolsCache = r.tools; names = localToolNames(); }
    } catch {}
  }
  return {
    ok: names.length > 0,
    workspace_root: localRoot || "",
    tools: names.length,
    has_base64: names.length ? names.some((n) => n === "read_file_base64" || n.endsWith("/read_file_base64")) : null,
    // The text tunnel needs only these two, and every build has had them, so an
    // agent that lacks read_file_base64 can STILL deliver a screenshot.
    has_read_file: names.length ? names.some((n) => n === "read_file" || n.endsWith("/read_file")) : null,
    has_run_command: names.length ? names.some((n) => n === "run_command" || n.endsWith("/run_command")) : null,
    reason: names.length ? "" : "or-agent.exe did not report a tool list (not running, or an old build)",
  };
}

async function extText(name) {
  const r = await fetch(chrome.runtime.getURL(name));
  if (!r.ok) throw new Error("extension file missing: " + name);
  return await r.text();
}

async function localWrite(path, content) {
  const r = await sendLocalEngine({
    type: "call_tool", name: "write_file",
    arguments: { path, content },
  }, 20000);
  if (!r || !r.ok) throw new Error((r && r.error) || ("could not write " + path));
  return r.text || "";
}

async function localRead(path, offset) {
  const r = await sendLocalEngine({
    type: "call_tool", name: "read_file",
    arguments: { path, offset: offset || 1, limit: 4000 },
  }, 20000);
  if (!r || !r.ok) throw new Error((r && r.error) || ("could not read " + path));
  const lines = String(r.text || "").split("\n");
  const body = [];
  let more = false;
  let next = offset || 1;
  for (const ln of lines) {
    const cont = ln.match(/\.\.\. lines (\d+)/);
    if (cont) { more = true; next = Number(cont[1]); continue; }
    const m = ln.match(/^\s*\d+\s+\|\s(.*)$/);
    if (m) body.push(m[1]);
  }
  return { text: body.join("\n"), more, next, count: body.length };
}
async function localReadAll(path) {
  let offset = 1, chunks = [];
  for (let i = 0; i < 20; i++) {
    const part = await localRead(path, offset);
    if (part.text) chunks.push(part.text);
    if (!part.more || !part.count) break;
    offset = part.next || (offset + part.count);
  }
  return chunks.join("\n");
}

// Read ANY workspace file as base64 (images/binaries included) through the
// native AgentScript engine. This is the ONLY way browser-side code can get at
// bytes on disk, so it backs every "attach this file / screenshot" feature.
async function localReadBase64(path) {
  const r = await sendLocalEngine({ type: "call_tool", name: "read_file_base64", arguments: { path } }, 30000);
  if (!r || !r.ok) throw new Error((r && r.error) || ("could not read " + path));
  let parsed = null;
  try { parsed = JSON.parse(String(r.text || "")); } catch {}
  if (!parsed || !parsed.data) throw new Error("the bridge returned no file data for " + path);
  return parsed;
}

// ── the TEXT TUNNEL: a picture that travels as base64 TEXT ─────────────────
// Why this exists: reading a local file needs read_file_base64, which only the
// 1.18.0 agent has. Every other agent tool the tunnel needs (run_command,
// read_file, write_file) is present in OLDER exes too - the user's prebuilt
// or-agent.exe advertises 18 tools and everything but read_file_base64 - so a
// screenshot still reaches the browser without rebuilding anything.
//
// read_file numbers its lines ("  12 | <content>") and CLIPS the whole reply at
// 40,000 characters, cutting mid-line, so each request asks for few enough lines
// that the clip never triggers; if a reply is clipped anyway the chunk size is
// halved and the same offset re-read (self-healing, never a corrupt image).
const READ_CLIP_MARK = /\n?\.\.\. \[output truncated at \d+ characters\]/;

async function localReadTextFile(path, opts) {
  const o = opts || {};
  const maxChars = o.maxChars || 34000;
  const maxCalls = o.maxCalls || 60;
  let linesPerCall = Math.max(4, Math.min(2000, o.linesPerCall || 80));
  let offset = 1;
  let calls = 0;
  const parts = [];
  let clipped = 0;
  for (let n = 0; n < maxCalls; n++) {
    calls++;
    const r = await sendLocalEngine({ type: "call_tool", name: "read_file",
      arguments: { path, offset, limit: linesPerCall } }, 25000);
    if (!r || !r.ok) throw new Error((r && r.error) || ("the agent could not read " + path));
    let text = String(r.text == null ? "" : r.text);
    const wasClipped = READ_CLIP_MARK.test(text);
    if (wasClipped) { clipped++; text = text.replace(READ_CLIP_MARK, ""); linesPerCall = Math.max(4, Math.floor(linesPerCall / 2)); }
    const got = [];
    for (const line of text.split("\n")) {
      const m = line.match(/^\s*\d+ \| ?([\s\S]*)$/);
      if (m) got.push(m[1]);
    }
    if (!got.length) {
      if (/\(no lines in range/.test(text)) break;              // past the end: done
      break;                                                     // header only
    }
    // A clipped reply may end in half a line - drop it and re-read that offset.
    if (wasClipped) got.pop();
    parts.push(...got);
    const consumed = Math.max(1, got.length);
    offset += consumed;
    if (got.length < linesPerCall && !wasClipped) break;          // last page
    if (parts.join("").length > (o.maxB64 || 4 * 1024 * 1024)) throw new Error("the capture file is unexpectedly large");
  }
  return { text: parts.join(""), lines: offset - 1, chunks: calls, clipped };
}

// Verify the tunnel end-to-end: same byte count, and the same SHA-256 the script
// computed, so a truncated or re-encoded picture is never attached as if it were
// the screenshot.
async function b64ToVerifiedImage(b64, meta) {
  const clean = String(b64 || "").replace(/[^A-Za-z0-9+/=]/g, "");
  if (!clean) throw new Error("the capture text arrived empty");
  let bin;
  try { bin = atob(clean); } catch (e) { throw new Error("the capture text is not valid base64: " + String((e && e.message) || e)); }
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  // Three independent checks, cheapest first, so a damaged or half-read picture can
  // never be attached as if it were the screenshot:
  //   1. the text itself must be the length the script reported;
  //   2. the decoded bytes must be the size the script reported;
  //   3. the bytes must hash to the SHA-256 the script computed.
  if (meta && meta.base64_chars && clean.length !== Number(meta.base64_chars)) {
    throw new Error("the capture text is incomplete (" + clean.length + " of " + meta.base64_chars + " base64 characters) - the file readback was cut short");
  }
  const expected = Number(meta && meta.bytes) || 0;
  if (expected && bytes.length !== expected) {
    throw new Error("the picture arrived incomplete (" + bytes.length + " of " + expected + " bytes) - the file readback was cut short");
  }
  if (meta && meta.sha256 && crypto && crypto.subtle && crypto.subtle.digest) {
    let hex = "";
    try {
      const d = await crypto.subtle.digest("SHA-256", bytes);
      hex = Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, "0")).join("");
    } catch { hex = ""; }                                  // no digest support: checks 1 and 2 still held
    if (hex && hex !== String(meta.sha256).toLowerCase()) {
      throw new Error("checksum mismatch: the picture was damaged on the way to the browser (expected " +
        String(meta.sha256).slice(0, 12) + "…, got " + hex.slice(0, 12) + "…)");
    }
  }
  return { mimeType: (meta && meta.mime) || "image/jpeg", data: clean, bytes: bytes.length };
}

// Hand a picture file to the browser by ANY route the agent supports:
//   1. read_file_base64 (new agent) - one call;
//   2. otherwise ask studio_shot.ps1 to write the base64 text twin and read that back
//      with read_file, verifying size + SHA-256 (old agent).
// Throws with .code = "too-large" when the file cannot travel as text at all, so the
// caller can retake it smaller instead of giving up.
// ── a picture that arrives as TEXT ──────────────────────────────────────────
// Not every MCP hands the picture over as image data. Studio's own capture and
// Blender's addon both WRITE a file and answer with its path, and some servers inline
// base64. Image blocks need an up-to-date or-agent.exe; a path or inline base64 does
// NOT - it can be read back through the same text tunnel the window capture uses.
// Without this, a text-only answer read as "captured nothing" even though the picture
// was sitting on disk the whole time.
const IMAGE_FILE_RE = /(?:[A-Za-z]:[\\/]|\\\\[^\s"']+[\\/]|\/)[^"'\r\n<>|?*]*?\.(?:png|jpe?g|webp|bmp|gif)\b/i;
function imagePathInText(text) {
  const m = String(text || "").match(IMAGE_FILE_RE);
  return m ? m[0].trim() : "";
}
function imageDataInText(text) {
  const t = String(text || "");
  const uri = t.match(/data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]{200,})/i);
  if (uri) return { mimeType: uri[1], data: uri[2].replace(/\s+/g, "") };
  const blob = t.match(/(?:^|[\s"'(=:\[])([A-Za-z0-9+/]{400,}={0,2})(?=$|[\s"')])/m);
  if (blob) {
    const b = blob[1].replace(/\s+/g, "");
    // Only data whose type we can name from its own header - never a guess.
    const mime = b.startsWith("iVBOR") ? "image/png"
      : b.startsWith("/9j/") ? "image/jpeg"
      : b.startsWith("R0lGOD") ? "image/gif" : "";
    if (mime) return { mimeType: mime, data: b };
  }
  return null;
}
// Applies to capture-ish tools only: a tool that merely MENTIONS a .png (a file
// listing, say) must not drag an unrelated picture into the model's context.
const CAPTURE_TOOL_RE = /screenshot|screen_capture|capture|viewport/i;
async function harvestToolImage(r, toolName) {
  if (!r || !r.ok || (Array.isArray(r.images) && r.images.length)) return r;
  if (toolName && !CAPTURE_TOOL_RE.test(String(toolName))) return r;
  const text = String(r.text || "");
  if (!text) return r;
  const inline = imageDataInText(text);
  if (inline) return Object.assign({}, r, { images: [inline], image_source: "base64 TEXT in the tool's own answer" });
  const file = imagePathInText(text);
  if (!file) {
    // Nothing convertible in the answer. "No picture" is true but useless on its own:
    // a build without image support THROWS PICTURES AWAY, and the user cannot tell that
    // apart from a Studio that never took one. Say which it probably is, and what to do.
    let note = "no picture came back with the answer, and nothing in it named a file or held base64";
    try {
      const info = await agentInfo();
      if (info && info.has_base64 === false) {
        note = "no picture came back: this or-agent.exe (" + info.tools + " tools, no read_file_base64) predates image handling, " +
          "so a picture Studio sent as IMAGE DATA was thrown away here. Either rebuild the agent (cd agent && cargo build --release) " +
          "for in-Studio screenshots, or use {target:\"window\"} now.";
      }
    } catch {}
    return Object.assign({}, r, { image_error: note });
  }
  try {
    const t = await tunnelReadImage(file, null);
    return Object.assign({}, r, { images: [{ mimeType: t.img.mimeType, data: t.img.data }], meta: t.meta,
      image_source: "the file the tool named (" + file + "), read back as base64 TEXT in " + t.chunks + " chunk(s)" });
  } catch (e) {
    return Object.assign({}, r, { image_error: "the tool named " + file + " but its bytes could not be read back: " + String((e && e.message) || e).slice(0, 200) });
  }
}

async function tunnelReadImage(file, knownMeta) {
  let meta = knownMeta && knownMeta.base64_file ? knownMeta : null;
  if (!meta) {
    const r = await localRun(`powershell -NoProfile -ExecutionPolicy Bypass -File studio_shot.ps1 -B64Only "${file}"`, 45);
    const m2 = parseShotMeta(String((r && (r.text || r.error)) || ""));
    if (!m2 || !m2.ok) {
      const err = new Error((m2 && m2.error) || ("could not prepare " + file + " for text readback") +
        (r && r.error && r.error !== (m2 && m2.error) ? " (" + String(r.error).slice(0, 160) + ")" : ""));
      if (m2 && /too big to hand over as text|too large to read whole/i.test(String(m2.error || ""))) err.code = "too-large";
      throw err;
    }
    meta = m2;
  }
  const rd = await localReadTextFile(meta.base64_file || (file + ".b64"), { linesPerCall: 90 });
  const img = await b64ToVerifiedImage(rd.text, meta);
  return { img, meta, lines: rd.lines, chunks: rd.chunks, clipped: rd.clipped };
}

async function localRun(command, timeoutSeconds = 12) {
  return sendLocalEngine({
    type: "call_tool", name: "run_command",
    arguments: { command, timeout_seconds: timeoutSeconds },
  }, (timeoutSeconds + 8) * 1000);
}

function probeCommands(win) {
  if (win) {
    return [
      "powershell -NoProfile -Command try{$c=New-Object Net.Sockets.TcpClient;$c.ReceiveTimeout=2500;$c.Connect('127.0.0.1',9876);$c.Close();Write-Output BLENDER_UP}catch{Write-Output BLENDER_DOWN}",
    ];
  }
  return [
    "python3 -c \"import socket;s=socket.create_connection(('127.0.0.1',9876),2);s.close();print('BLENDER_UP')\"",
    "python -c \"import socket;s=socket.create_connection(('127.0.0.1',9876),2);s.close();print('BLENDER_UP')\"",
    "(echo >/dev/tcp/127.0.0.1/9876) >/dev/null 2>&1 && echo BLENDER_UP || echo BLENDER_DOWN",
  ];
}

async function probeBlenderTcp() {
  let plat = { os: "win" };
  try { plat = await chrome.runtime.getPlatformInfo(); } catch {}
  const win = plat.os === "win";
  let last = "";
  for (const cmd of probeCommands(win)) {
    const r = await localRun(cmd, 8);
    const text = String((r && (r.text || r.error)) || "");
    last = text;
    if (/BLENDER_UP/.test(text)) return { ok: true };
    if (r && r.ok === false && /not running|not connected|timeout/i.test(text)) {
      return { ok: false, error: "or-agent.exe is not running — start it, then Connect Blender again." };
    }
  }
  const down = /BLENDER_DOWN/.test(last);
  const err = down
    ? "Blender addon is not on port 9876. In Blender: press N → MCP for Blender → Start MCP Server."
    : (last && last.slice(0, 220)) || "Could not reach Blender. Run or-agent.exe, then Start MCP Server in Blender.";
  return { ok: false, error: err };
}

async function connectBlender() {
  const p = await probeBlenderTcp();
  if (!p.ok) {
    setBlender(false, p.error);
    broadcastStatus();
    return { ok: false, blender: false, error: p.error };
  }
  setBlender(true, "");
  try {
    const ping = await blenderCall("get_scene_info", {}, 20000);
    if (ping && ping.ok === false && /not listening|closed|refused|10061|Connection refused/i.test(String(ping.error || ""))) {
      setBlender(false, ping.error);
      broadcastStatus();
      return { ok: false, blender: false, error: ping.error };
    }
  } catch {}
  broadcastStatus();
  return { ok: true, blender: true };
}

async function agentWorkspaceRoot() {
  if (localRoot) return localRoot;
  const r = await sendLocalEngine({ type: "call_tool", name: "workspace_info", arguments: {} }, 12000);
  const t = String((r && r.text) || "");
  const m = t.match(/Workspace root:\s*(.+)/);
  if (m) { localRoot = m[1].trim(); return localRoot; }
  return "";
}

function pyLiteral(v) {
  if (v === null || v === undefined) return "None";
  if (typeof v === "boolean") return v ? "True" : "False";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "0";
  if (typeof v === "string") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(pyLiteral).join(", ") + "]";
  const parts = [];
  for (const [k, val] of Object.entries(v)) parts.push(JSON.stringify(k) + ": " + pyLiteral(val));
  return "{" + parts.join(", ") + "}";
}

const BLENDER_CMD = {
  blender_export_fbx: "export_fbx", export_blender_fbx: "export_fbx",
  blender_import_fbx: "import_fbx", import_blender_fbx: "import_fbx",
  blender_export_obj: "export_obj", blender_import_obj: "import_obj",
  blender_mesh_dump: "dump", blender_send_to_studio: "dump",
  blender_group: "group", blender_ungroup: "ungroup",
  blender_parent: "parent", blender_unparent: "unparent", blender_join: "join",
  blender_move_to_collection: "move_to_collection",
  blender_list_collections: "list_collections", blender_list_objects: "list_objects",
  blender_delete: "delete", blender_duplicate: "duplicate", blender_rename: "rename",
  blender_select: "select", blender_transform: "transform",
  blender_apply_transforms: "apply_transforms", blender_set_origin: "set_origin",
  blender_shade_smooth: "shade_smooth", blender_set_material: "set_material",
  // ── Material toolkit (node-based; version-safe across Blender 3.x/4.x) ──
  blender_material_create: "material_create", blender_material_new: "material_create",
  blender_make_material: "material_create", blender_material_preset: "material_preset",
  blender_material_apply_preset: "material_preset", blender_material_set: "material_set",
  blender_material_edit: "material_set", blender_material_assign: "material_assign",
  blender_material_apply: "material_assign", blender_material_list: "material_list",
  blender_materials: "material_list", blender_material_inspect: "material_inspect",
  blender_material_info: "material_inspect", blender_material_remove: "material_remove",
  blender_material_delete: "material_remove", blender_material_noise: "material_noise",
  blender_material_texture: "material_noise", blender_material_image: "material_image",
  blender_material_texture_image: "material_image", blender_material_pbr: "material_pbr",
  blender_material_maps: "material_pbr",
  blender_add_modifier: "add_modifier", blender_boolean: "boolean",
  blender_add_cube: "add_cube", blender_add_sphere: "add_sphere",
  blender_add_cylinder: "add_cylinder", blender_add_cone: "add_cone",
  blender_add_plane: "add_plane", blender_add_torus: "add_torus",
  blender_add_monkey: "add_monkey", blender_add_empty: "add_empty",
  blender_add_camera: "add_camera", blender_add_light: "add_light",
  blender_add_ico_sphere: "add_ico_sphere", blender_add_grid: "add_grid",
  blender_add_circle: "add_circle", blender_add_text: "add_text",
  blender_clear_scene: "clear_scene",
  blender_select_all: "select_all", blender_deselect: "deselect",
  blender_invert_selection: "invert_selection", blender_select_children: "select_children",
  blender_get_selection: "get_selection",
  blender_translate: "translate", blender_rotate: "rotate_deg", blender_rotate_deg: "rotate_deg",
  blender_set_dimensions: "set_dimensions",
  blender_origin_to_bottom: "origin_to_bottom", blender_drop_to_ground: "drop_to_ground",
  blender_center: "center", blender_snap_to_grid: "snap_to_grid",
  blender_shade_flat: "shade_flat",
  blender_apply_modifiers: "apply_modifiers", blender_remove_modifier: "remove_modifier",
  blender_triangulate: "triangulate", blender_decimate: "decimate",
  blender_merge: "merge", blender_recalc_normals: "recalc_normals",
  blender_flip_normals: "flip_normals", blender_separate: "separate_loose",
  blender_subdivide: "subdivide", blender_uv_unwrap: "uv_unwrap",
  blender_array: "array", blender_mirror: "mirror",
  blender_hide: "hide", blender_unhide: "unhide", blender_unhide_all: "unhide_all",
  blender_hide_unselected: "hide_unselected",
  blender_undo: "undo", blender_redo: "redo",
  blender_frame_selected: "frame_selected", blender_stats: "stats",
  blender_save: "save_blend", blender_look_at: "look_at",
  blender_convert_to_mesh: "convert_to_mesh",
  blender_align_camera: "align_camera_axis", blender_align_camera_axis: "align_camera_axis",
  blender_view_axis: "view_axis", blender_camera_to_view: "camera_to_view",
  blender_set_camera_lens: "set_camera_lens",
  blender_scale: "scale", blender_bevel: "bevel", blender_solidify: "solidify",
  blender_extrude: "extrude", blender_add_curve: "add_curve", blender_add_armature: "add_armature",
  blender_keyframe: "keyframe_insert", blender_keyframe_insert: "keyframe_insert",
  blender_set_frame: "set_frame", blender_set_active_camera: "set_active_camera",
  blender_track_to: "track_to", blender_cursor_to_selected: "cursor_to_selected",
  blender_randomize: "randomize_transform", blender_randomize_transform: "randomize_transform",
  blender_hide_render: "hide_render", blender_subdivision: "subdivision",
  blender_subsurf: "subdivision", blender_origin_to_geometry: "origin_to_geometry",
};

async function blenderOpsCode(cmd, args) {
  let py = await extText("blender_ops.py");
  const status = "or_status.json";
  const mesh = "or_mesh.json";
  py = py.split("__OR_CMD__").join(String(cmd || ""));
  py = py.split("__OR_ARGS__").join(JSON.stringify(args || {}));
  py = py.split("__OR_OUT__").join(JSON.stringify(status || "or_status.json"));
  py = py.split("__OR_MESH__").join(JSON.stringify(mesh || "or_mesh.json"));
  return { py, status, mesh };
}

function wrapBlenderUserCode(code) {
  const src = String(code || "");
  if (!src.trim()) return src;
  if (src.indexOf("_or_items") >= 0 && src.indexOf("_or_src =") >= 0) return src;
  return [
    "import bpy, re as _or_re",
    "_or_src = " + JSON.stringify(src),
    "try:",
    "    _or_items = set(getattr(it, 'identifier', str(it)) for it in bpy.context.scene.render.bl_rna.properties['engine'].enum_items)",
    "except Exception:",
    "    _or_items = set()",
    "if 'BLENDER_EEVEE_NEXT' not in _or_items and 'BLENDER_EEVEE' in _or_items:",
    "    _or_src = _or_src.replace('BLENDER_EEVEE_NEXT', 'BLENDER_EEVEE')",
    "elif 'BLENDER_EEVEE' not in _or_items and 'BLENDER_EEVEE_NEXT' in _or_items:",
    "    _or_src = _or_re.sub(r'BLENDER_EEVEE(?!_NEXT)', 'BLENDER_EEVEE_NEXT', _or_src)",
    "if not hasattr(bpy.context.scene, 'eevee_next') and hasattr(bpy.context.scene, 'eevee'):",
    "    _or_src = _or_src.replace('.eevee_next', '.eevee')",
    "exec(compile(_or_src, '<or_blender>', 'exec'))",
  ].join("\n");
}

async function blenderPayload(name, args) {
  const bare = String(name || "").split("/").pop().split(".").pop();
  const a = args || {};
  if (bare === "get_scene_info" || bare === "blender_get_scene_info") return { type: "get_scene_info", params: {} };
  if (bare === "get_object_info" || bare === "blender_get_object_info") return { type: "get_object_info", params: { name: a.name || a.object_name || "" } };
  if (bare === "execute_blender_code" || bare === "execute_code" || bare === "blender_execute_code") return { type: "execute_code", params: { code: wrapBlenderUserCode(a.code || "") } };
  if (bare === "get_viewport_screenshot" || bare === "blender_screenshot" || bare === "blender_viewport_shot" || bare === "blender_window_shot") {
    let shot = "or_blender_shot.png";
    const root = await agentWorkspaceRoot();
    if (root) shot = root.replace(/[\\/]+$/, "") + "/or_blender_shot.png";
    // _orShot: the exact path we asked Blender to write, so blenderCall can read
    // the pixels back (see the screenshot branch there) without guessing.
    return { type: "get_viewport_screenshot", params: { max_size: Number(a.max_size) || 1000, filepath: shot, format: "png" }, _orShot: shot };
  }
  const mapped = BLENDER_CMD[bare];
  if (mapped) {
    const packed = await blenderOpsCode(mapped, a);
    return { type: "execute_code", params: { code: packed.py }, _orStatus: packed.status, _orMesh: packed.mesh };
  }
  const params = Object.assign({}, a);
  delete params.user_prompt;
  return { type: bare, params };
}

async function ensureBlenderScripts() {
  if (blenderScriptsReady) return;
  const py = await extText("blender_once.py");
  const ps = await extText("blender_once.ps1");
  await localWrite("blender_once.py", py);
  await localWrite("blender_once.ps1", ps);
  blenderScriptsReady = true;
}

let blenderCallLock = Promise.resolve();
async function blenderCall(name, args, timeout) {
  if (!blenderAddon) {
    return { ok: false, error: "Blender is not connected. Click Connect Blender (Blender: N → MCP for Blender → Start MCP Server)." };
  }
  const run = async () => {
    await ensureBlenderScripts();
    const payload = await blenderPayload(name, args);
    const statusPath = payload._orStatus || "";
    const meshPath = payload._orMesh || "";
    const wire = { type: payload.type, params: payload.params };
    await localWrite("or_blender_in.json", JSON.stringify(wire));
    let plat = { os: "win" };
    try { plat = await chrome.runtime.getPlatformInfo(); } catch {}
    const win = plat.os === "win";
    const secs = Math.max(20, Math.min(180, Math.round((timeout || 120000) / 1000)));
    const cmds = win ? [
      "powershell -NoProfile -ExecutionPolicy Bypass -File blender_once.ps1 or_blender_in.json or_blender_out.json",
      "py -3 blender_once.py or_blender_in.json or_blender_out.json",
      "python blender_once.py or_blender_in.json or_blender_out.json",
    ] : [
      "python3 blender_once.py or_blender_in.json or_blender_out.json",
      "python blender_once.py or_blender_in.json or_blender_out.json",
    ];
    let last = "";
    let okRun = false;
    for (const cmd of cmds) {
      const r = await localRun(cmd, secs);
      last = String((r && (r.text || r.error)) || "");
      if (/OR_BLENDER_OK/.test(last)) { okRun = true; break; }
      // Blender refused / socket error — do not try py/python after PowerShell already ran.
      if (/OR_BLENDER_ERR/.test(last)) break;
      // Missing interpreter only: try the next runner. Anything else is a real error.
      if (!/not recognized|cannot find|No such file|not found|is not recognized/i.test(last)) break;
    }
    let raw = "";
    try { raw = (await localReadAll("or_blender_out.json")).replace(/^\uFEFF/, "").trim(); } catch (e) {
      if (!okRun) return { ok: false, error: last.slice(0, 400) || String(e.message || e) };
    }
    let data;
    try { data = JSON.parse(raw); } catch {
      return { ok: false, error: raw ? raw.slice(0, 400) : (last.slice(0, 400) || "empty Blender response") };
    }
    if (data && data.status === "error") {
      const msg = data.message || "Blender addon error";
      if (/not listening|closed|actively refused|10061|Connection refused/i.test(msg)) {
        setBlender(false, "Blender addon dropped. Start MCP Server in Blender, then Connect Blender again.");
      }
      return { ok: false, error: msg };
    }
    let result = (data && Object.prototype.hasOwnProperty.call(data, "result")) ? data.result : data;
    const rawText = typeof result === "string" ? result : JSON.stringify(result);
    const marker = String(rawText).indexOf("OR_MESH_JSON:");
    if (marker >= 0) {
      try { result = JSON.parse(String(rawText).slice(marker + 13)); } catch {}
    }
    if (result && result.ok === false) {
      return { ok: false, error: result.error || "Blender FBX failed" };
    }
    if (statusPath) {
      try {
        const st = (await localReadAll(statusPath)).replace(/^\uFEFF/, "").trim();
        if (st) {
          try { result = JSON.parse(st); } catch {}
        }
      } catch {}
    }
    if (result && result.ok === false) {
      return { ok: false, error: result.error || "Blender command failed" };
    }
    let meshes = result && result.meshes;
    const mf = (result && result.mesh_file) || meshPath || "or_mesh.json";
    if ((!meshes || !meshes.length) && mf) {
      for (const cand of [mf, "or_mesh.json"]) {
        try {
          const rawM = (await localReadAll(cand)).replace(/^\uFEFF/, "").trim();
          if (!rawM) continue;
          const parsed = JSON.parse(rawM);
          meshes = parsed.meshes || (parsed.result && parsed.result.meshes);
          if (meshes && meshes.length) break;
        } catch {}
      }
    }
    if (meshes && meshes.length && result && typeof result === "object") result.meshes = meshes;
    // ── Screenshot → real image bytes ──────────────────────────────────────
    // The blender-mcp addon WRITES the viewport capture to a PNG path and
    // answers with that path as text. A Chrome extension cannot read a local
    // path, so this used to hand back images:[] and or_screenshot silently fell
    // through to a tab capture (the AI got a picture of its own chat window).
    // The path IS inside the AgentScript workspace, so read it back as base64
    // through the bridge and return it as a real attachment.
    let images = [];
    const shotPath = payload._orShot ||
      (result && typeof result === "object" && (result.filepath || result.file_path || result.path)) ||
      (payload.type === "get_viewport_screenshot" ? "or_blender_shot.png" : "");
    if (shotPath && payload.type === "get_viewport_screenshot") {
      try {
        const parsed = await localReadBase64(shotPath);
        images = [{ mimeType: parsed.mimeType || "image/png", data: parsed.data }];
        if (result && typeof result === "object") result.bytes = parsed.bytes;
      } catch (e) {
        // Old agent (no read_file_base64): the Blender addon already wrote a PNG into
        // the workspace, so hand it over as base64 TEXT instead - the same tunnel the
        // Studio window capture uses. Without this, a Blender viewport screenshot
        // silently failed on any agent older than 1.18.0.
        try {
          const t = await tunnelReadImage(shotPath, null);
          images = [{ mimeType: t.img.mimeType, data: t.img.data }];
          if (result && typeof result === "object") result.bytes = t.img.bytes || undefined;
        } catch (e2) {
          // Keep the path in the text so the model/user can still open the file;
          // report the reason rather than pretending a capture happened.
          const t2msg = String((e2 && e2.message) || e2);
          result = typeof result === "object" && result
            ? Object.assign({}, result, { image_error: String((e && e.message) || e).slice(0, 200) + (t2msg ? " | text tunnel: " + t2msg.slice(0, 200) : "") +
                (/too big to hand over as text|too large to read whole/i.test(t2msg) ? " — re-capture with a smaller size: blender_screenshot {max_size: 600}" : "") })
            : result;
        }
      }
    }
    let textOut = typeof result === "string" ? result : JSON.stringify(result, null, 2);
    if (payload.type === "get_viewport_screenshot" && !images.length) {
      textOut += "\n\n[OR: the viewport image could not be read back from disk" +
        (shotPath ? ` (${shotPath})` : "") + " — the capture file may be missing or unreadable.]";
    }
    return { ok: true, text: textOut, images, meshFile: mf, filepath: result && result.filepath, meshes: meshes || undefined };
  };
  const prev = blenderCallLock;
  let release;
  blenderCallLock = new Promise((res) => { release = res; });
  await prev.catch(() => {});
  try { return await run(); }
  finally { release(); }
}

// ── Studio WINDOW capture / focus (OS side, needs or-agent.exe) ─────────────
// A browser extension cannot photograph a desktop window, and captureVisibleTab
// only ever sees the tab IN FRONT. Studio is a separate application, so this goes
// through the agent: studio_shot.ps1 (written into the agent workspace) uses
// PrintWindow first - which works while Studio is behind other windows - and
// falls back to raising the window and grabbing the screen.
let studioShotScriptReady = false;   // same pattern as ensureBlenderScripts

async function ensureStudioShotScript() {
  if (studioShotScriptReady) return;
  const ps = await extText("studio_shot.ps1");
  await localWrite("studio_shot.ps1", ps);
  studioShotScriptReady = true;
}

// capture:true → also write the PNG. Focus-only is the "make Studio the front
// window" action (no capture). Returns { ok, text, images, meta }.
// The script's last line is machine-readable: OR_STUDIO_SHOT {...}
function parseShotMeta(raw) {
  const text = String(raw || "");
  // Take the LAST result line: PowerShell can print warnings after the JSON, and a
  // strict end-anchored match turned "the capture worked" into "no answer".
  const all = [...text.matchAll(/OR_STUDIO_SHOT\s+(\{.*\})/g)];
  for (let i = all.length - 1; i >= 0; i--) {
    // Trim to the first balanced object: the line may carry trailing prose.
    const body = all[i][1];
    let depth = 0, end = -1, inStr = false, esc = false;
    for (let j = 0; j < body.length; j++) {
      const ch = body[j];
      if (esc) { esc = false; continue; }
      if (ch === "\\") { esc = true; continue; }
      if (ch === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (ch === "{") depth++;
      else if (ch === "}") { depth--; if (depth === 0) { end = j; break; } }
    }
    if (end < 0) continue;
    try { return JSON.parse(body.slice(0, end + 1)); } catch { }
  }
  return null;
}

// The whole-screen capture writes its own file name: a shot of the desktop must not be
// saved as "or_studio_window.jpg", or the user (and attach_feedback {path}) would be told
// the wrong thing about what the file is.
function wholeScreenOut(name) {
  const s = String(name || "or_studio_window.png");
  return /studio/i.test(s) ? s.replace(/studio_window/i, "screen").replace(/studio/i, "screen") : s;
}

async function studioWindowShot({ focus = false, focusOnly = false, maxWidth = 1600, out = "or_studio_window.png", wholeScreen = false } = {}) {
  const ps1 = (cmd) => `powershell -NoProfile -ExecutionPolicy Bypass -File studio_shot.ps1 ${cmd}`;
  try {
    await ensureStudioShotScript();
  } catch (e) {
    return { ok: false, error: "could not write studio_shot.ps1 into the agent workspace: " + String((e && e.message) || e) + " (is or-agent.exe running?)" };
  }
  // wholeScreen ignores -Focus/-FocusOnly: it photographs the desktop, so there is no
  // Studio window to raise and nothing to focus.
  const flags = [
    wholeScreen ? `-WholeScreen -Out ${wholeScreenOut(out)}` : (focusOnly ? "-FocusOnly" : `-Out ${out}`),
    focus && !focusOnly && !wholeScreen ? "-Focus" : "",
    focusOnly && !wholeScreen ? "" : `-MaxWidth ${Math.max(320, Math.min(3000, Number(maxWidth) || 1600))}`,
  ].filter(Boolean).join(" ");
  const cmd = ps1(flags);
  const r = await localRun(cmd, 45);
  const raw = String((r && (r.text || r.error)) || "");
  let meta = parseShotMeta(raw);
  if (!meta) {
    return { ok: false, error: (raw.slice(-400) || "no answer from the agent (is or-agent.exe running?)"), command: cmd,
             hint: "the script prints one OR_STUDIO_SHOT {...} line; a PowerShell parse error or a missing Add-Type means this needs the rebuilt agent" };
  }
  if (!meta.ok) {
    // Carry the script's own diagnosis through: if the fast helper could not be
    // compiled, that is the first thing worth knowing when a capture fails.
    return { ok: false, meta, command: cmd,
             error: (meta.error || "capture failed") +
               (meta.compile_error ? " [the fast PrintWindow helper could not be compiled on this PC: " + String(meta.compile_error).slice(0, 160) + "]" : "") };
  }
  if (focusOnly) {
    return { ok: true, text: (meta.focused ? "Roblox Studio is now the FRONT window" : "Windows refused keyboard focus; Studio was raised above other windows instead"), meta, command: cmd };
  }
  const file = meta.file || out;
  let images = [];
  let how2 = "";
  try {
    const b64 = await localReadBase64(file);
    images = [{ mimeType: b64.mimeType || "image/png", data: b64.data }];
    how2 = "file readback (read_file_base64)";
  } catch (e1) {
    // Old agent (no read_file_base64): pull the same bytes back as TEXT. This is
    // the path that makes a screenshot work on the user's current exe.
    try {
      const t = await tunnelReadImage(file, meta);
      images = [{ mimeType: t.img.mimeType, data: t.img.data }];
      meta = t.meta;
      how2 = "text tunnel (" + t.lines + " base64 lines read with read_file in " + t.chunks + " chunk(s)" + (t.clipped ? ", a clipped reply re-read at a smaller size" : "") + ")";
    } catch (e2) {
      const why2 = String((e2 && e2.message) || e2);
      // The agent refuses to read a file bigger than 2 MB as text, and a 4K Studio
      // window can easily exceed that once base64-inflated. Retake SMALLER (about a
      // third of the pixels) rather than reporting a dead end - a slightly softer
      // screenshot beats no screenshot.
      // Both wordings matter: the agent's own refusal ("too large to read whole") and
      // the capture script's guard on the file it just wrote ("too big to hand over as
      // text"). Either way the answer is the same: take a smaller picture.
      if ((e2 && e2.code === "too-large") || /too large to read whole|unexpectedly large|too big to hand over as text/i.test(why2)) {
        try {
          const smallW = Math.max(640, Math.min(1100, Math.round((Number(maxWidth) || 1600) * 0.65)));
          const cmd2 = ps1(`-Out ${out} -MaxWidth ${smallW} -Quality 60` + (wholeScreen ? " -WholeScreen" : ""));
          const r2 = await localRun(cmd2, 45);
          const meta2 = parseShotMeta(String((r2 && (r2.text || r2.error)) || ""));
          if (meta2 && meta2.ok) {
            const t2 = await tunnelReadImage(meta2.file || file, meta2);
            images = [{ mimeType: t2.img.mimeType, data: t2.img.data }];
            how2 = "text tunnel, retaken smaller at " + smallW + "px because the full-size file was too big for the agent to read back (" +
                   t2.lines + " base64 lines in " + t2.chunks + " chunk(s))";
            meta = t2.meta;
          }
        } catch (e3) { /* fall through to the plain error below */ }
      }
      if (images.length) {
        // delivered by the smaller re-capture - continue to the normal return
      } else {
        return { ok: false, meta, command: cmd,
                 error: (wholeScreen ? "the screen WAS captured to " : "the window WAS captured to ") + file + ", but the picture could not be read back: " +
                   why2 + " (direct file read: " + String((e1 && e1.message) || e1).slice(0, 160) + "). " +
                   (meta && meta.tunnel_error ? "The capture script could not write the tunnel file: " + String(meta.tunnel_error).slice(0, 160) + ". " : "") +
                   "The capture itself worked - only the hand-over failed." };
      }
    }
  }
  const what = wholeScreen ? "your whole screen (all monitors)"
    : "the Roblox Studio WINDOW";
  const how = meta.method === "fullscreen" ? "a full-desktop grab (VirtualScreen)"
    : meta.method === "printwindow" ? "PrintWindow (Studio never had to come forward)"
    : meta.method === "screen" ? "screen grab after raising the Studio window"
    : meta.method === "screen-nocompile" ? "screen grab after raising Studio (fallback route: the fast helper could not be compiled on this PC)"
    : String(meta.method || "capture");
  return {
    ok: true, images, meta, command: cmd,
    text: `Captured ${what} via ${how} — ${(meta.width || (meta.window && meta.window.width))}x${(meta.height || (meta.window && meta.window.height))} px, saved as ${file}` +
      (how2 ? ` (delivered through the ${how2}).` : ".") +
      (meta.method === "screen" && meta.focused ? " Studio is now the front window." : "") +
      (meta.method === "screen" && !meta.focused ? " (Windows would not give Studio keyboard focus; it was raised above other windows.)" : "") +
      (meta.compile_error ? " Note: the fast in-memory capture helper could not be compiled here (" + String(meta.compile_error).slice(0, 120) + "), so the script used its fallback route - the screenshot still works." : ""),
  };
}

// ── shot_test: prove the screenshot machinery on THIS machine ───────────────
// Runs studio_shot.ps1 -SelfTest (no Studio window needed), then pulls the little
// test picture back through the SAME hand-over a real capture uses - one-call file
// readback on a new agent, the base64 text tunnel on an older one - and verifies the
// checksum. Green here means a real or_screenshot is going to deliver too; a failure
// names the step that broke instead of leaving the user guessing.
async function shotTest() {
  const steps = [];
  const fail = (error) => ({ ok: false, error, steps });
  try { await ensureStudioShotScript(); steps.push("script written into the agent workspace"); }
  catch (e) { return fail("could not write studio_shot.ps1 into the agent workspace: " + String((e && e.message) || e) + " (is or-agent.exe running?)"); }

  const cmd = `powershell -NoProfile -ExecutionPolicy Bypass -File studio_shot.ps1 -SelfTest`;
  const r = await localRun(cmd, 45);
  const raw = String((r && (r.text || r.error)) || "");
  const meta = parseShotMeta(raw);
  if (!meta) return fail("the self-test printed no result line - the script did not run: " + (raw.slice(-300) || "no answer from the agent"));
  if (!meta.ok) return fail(meta.error || "the self-test failed");
  steps.push("PowerShell + System.Drawing work (JPEG written: " + (meta.jpeg_ok ? "yes" : "NO") + ")");
  if (!meta.roundtrip_ok) return fail("the script wrote the base64 text but could not decode it back to the same bytes - the tunnel format is broken");

  const info = await agentInfo();
  const viaFast = info.has_base64 === true;
  try {
    let img = null;
    if (viaFast) {
      const b64 = await localReadBase64(meta.file);
      img = { mimeType: b64.mimeType || meta.mime, data: b64.data };
      steps.push("picture read back in one call (read_file_base64)");
    } else {
      const rd = await localReadTextFile(meta.base64_file, { linesPerCall: 90 });
      img = await b64ToVerifiedImage(rd.text, meta);
      steps.push("picture read back as base64 text in " + rd.chunks + " chunk(s) of read_file (" + rd.lines + " lines)");
    }
    const decoded = atob(String(img.data).replace(/[^A-Za-z0-9+/=]/g, ""));
    if (!decoded.length) return fail("the picture read back empty");
    steps.push("checksum verified (" + decoded.length + " bytes)");
    return { ok: true, steps, meta,
      text: "Everything a screenshot needs works on this machine: " + steps.join("; ") + ". " +
        (viaFast ? "Picture hand-over: one-call file readback." : "Picture hand-over: the BASE64 TEXT TUNNEL (your agent has no read_file_base64 - that is fine).") +
        " So or_screenshot will deliver: {target:\"studio\"} needs only Studio open, {target:\"desktop\"} needs no Studio at all (whole PC), and {target:\"window\"} photographs the Studio window - none of them cares which window is in front." };
  } catch (e) {
    return fail("the capture machinery works, but the picture could not be read back: " + String((e && e.message) || e) +
      " - that is the hand-over (the tunnel), not the capture.");
  }
}

async function robloxCsrf() {
  try {
    const r = await fetch("https://auth.roblox.com/v2/logout", { method: "POST", credentials: "include" });
    return r.headers.get("x-csrf-token") || r.headers.get("X-CSRF-TOKEN") || "";
  } catch {
    return "";
  }
}
async function robloxAuthedFetch(url, opts) {
  opts = opts || {};
  const method = opts.method || "GET";
  const headers = Object.assign({}, method !== "GET" ? { "Content-Type": "application/json" } : {}, opts.headers || {});
  const go = async (token) => {
    const h = Object.assign({}, headers);
    if (token) h["X-CSRF-TOKEN"] = token;
    const r = await fetch(url, { method, credentials: "include", headers: h, body: opts.body });
    const text = await r.text();
    const csrf = r.headers.get("x-csrf-token") || r.headers.get("X-CSRF-TOKEN") || "";
    return { r, text, csrf };
  };
  let token = await robloxCsrf();
  let res = await go(token);
  if ((res.r.status === 403 || res.r.status === 401) && res.csrf && res.csrf !== token) {
    res = await go(res.csrf);
  }
  let data = null;
  try { data = JSON.parse(res.text); } catch {}
  return { ok: res.r.ok, status: res.r.status, text: res.text, data };
}
async function robloxResolveUniverse(msg) {
  let universeId = Number(msg.universeId || msg.universe_id || msg.gameId || 0) || 0;
  const placeId = Number(msg.placeId || msg.place_id || 0) || 0;
  if (universeId > 0) return { ok: true, universeId, placeId };
  if (placeId > 0) {
    const res = await robloxAuthedFetch("https://apis.roblox.com/universes/v1/places/" + placeId + "/universe", { method: "GET" });
    const id = Number(res.data && (res.data.universeId || res.data.id) || 0) || 0;
    if (id > 0) return { ok: true, universeId: id, placeId };
  }
  const listed = await robloxAuthedFetch("https://develop.roblox.com/v1/user/universes?limit=50&sortOrder=Desc", { method: "GET" });
  const rows = (listed.data && listed.data.data) || [];
  if (placeId > 0) {
    const hit = rows.find((u) => Number(u.rootPlaceId) === placeId || Number(u.id) === placeId);
    if (hit) return { ok: true, universeId: Number(hit.id), placeId, name: hit.name };
  }
  if (rows.length === 1) return { ok: true, universeId: Number(rows[0].id), placeId: Number(rows[0].rootPlaceId) || placeId, name: rows[0].name };
  if (rows.length > 1) {
    const top = rows[0];
    return {
      ok: true,
      universeId: Number(top.id),
      placeId: Number(top.rootPlaceId) || placeId,
      name: top.name,
      candidates: rows.slice(0, 8).map((u) => ({ id: u.id, name: u.name, rootPlaceId: u.rootPlaceId })),
    };
  }
  const who = await robloxAuthedFetch("https://users.roblox.com/v1/users/authenticated", { method: "GET" });
  if (!who.ok) return { ok: false, error: "Could not reach the game. Sign into roblox.com in this Chrome profile, publish the place in Studio, then retry." };
  return { ok: false, error: "Could not reach a universe for this place (GameId/PlaceId empty). Publish the place (File > Publish to Roblox) so it has a Universe ID." };
}
async function robloxCreateDevProduct(msg) {
  const resolved = await robloxResolveUniverse(msg);
  if (!resolved.ok) return resolved;
  const universeId = resolved.universeId;
  const name = String(msg.name || "").trim();
  const description = String(msg.description || name).trim();
  const priceInRobux = Math.floor(Number(msg.priceInRobux || msg.price || 0));
  if (!name) return { ok: false, error: "name required" };
  if (!priceInRobux || priceInRobux < 1) return { ok: false, error: "priceInRobux must be >= 1" };
  const qUrl = "https://apis.roblox.com/developer-products/v1/universes/" + universeId +
    "/developerproducts?name=" + encodeURIComponent(name) +
    "&description=" + encodeURIComponent(description) +
    "&priceInRobux=" + encodeURIComponent(String(priceInRobux));
  let res = await robloxAuthedFetch(qUrl, { method: "POST" });
  if (!res.ok && (res.status === 400 || res.status === 404 || res.status === 415)) {
    res = await robloxAuthedFetch("https://apis.roblox.com/developer-products/v1/universes/" + universeId + "/developerproducts", {
      method: "POST",
      body: JSON.stringify({ name: name, description: description, priceInRobux: priceInRobux }),
    });
  }
  if (!res.ok) {
    let err = res.text.slice(0, 280) || ("HTTP " + res.status);
    try {
      const d = res.data;
      if (d) err = d.message || d.error || (d.errors && d.errors[0] && d.errors[0].message) || err;
    } catch {}
    if (res.status === 401 || res.status === 403) {
      return { ok: false, error: "Not signed into Roblox in this Chrome profile. Open roblox.com, log in, then retry. (" + err + ")" };
    }
    return { ok: false, error: String(err) + " (universe " + universeId + (resolved.name ? " / " + resolved.name : "") + ")", status: res.status, universeId: universeId };
  }
  const product = res.data || {};
  return { ok: true, product: product, productId: product.id || product.productId, universeId: universeId, universeName: resolved.name || "", text: JSON.stringify(product) };
}
async function robloxListDevProducts(msg) {
  const resolved = await robloxResolveUniverse(msg);
  if (!resolved.ok) return resolved;
  const universeId = resolved.universeId;
  const url = "https://apis.roblox.com/developer-products/v1/universes/" + universeId + "/developerproducts?pageNumber=1&pageSize=50";
  const res = await robloxAuthedFetch(url, { method: "GET" });
  if (!res.ok) {
    const err = (res.data && (res.data.message || res.data.error)) || res.text.slice(0, 280) || ("HTTP " + res.status);
    if (res.status === 401 || res.status === 403) {
      return { ok: false, error: "Not signed into Roblox in this Chrome profile. Open roblox.com, log in, then retry. (" + err + ")" };
    }
    return { ok: false, error: String(err), status: res.status };
  }
  return { ok: true, products: res.data, text: typeof res.text === "string" ? res.text.slice(0, 4000) : JSON.stringify(res.data) };
}

// ── messages from content.js / popup.js ─────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    switch (msg.type) {
      case "rs-get-engine":
        sendResponse({ engine });
        break;
      case "rs-set-engine":
        engine = normalizeEngine(msg.engine);
        try { await chrome.storage.local.set({ [ENGINE_KEY]: engine }); } catch {}
        // fully isolate — wipe previous engine's cache so hallucination impossible
        try { ws?.close(); } catch {}
        connected = false;
        mcpAlive = false;
        toolsCache = [];
        serversCache = [];
        studioConnected = null;
        studioApp = null;
        studioProc = null;
        robloxEditorConnected = false;
        failAllPending(`engine switched to ${engine}`);
        reconnectDelay = RECONNECT_MIN;
        connect();
        broadcastStatus();
          // also push to all provider tabs so their bars / prompts flip instantly.
          // tabs.sendMessage returns a Promise in MV3 — orphaned content scripts
          // (tab not refreshed after reload) reject with "Receiving end does not
          // exist"; that's expected and harmless here, so swallow it.
          try {
            const tabs = await chrome.tabs.query({ url: PROVIDER_URLS });
            for (const t of tabs) chrome.tabs.sendMessage(t.id, { type: "rs-engine", engine }).catch(() => {});
          } catch {}
        sendResponse({ engine });
        break;
      case "rs-set-full": {
        // FULL PC ACCESS toggle for the AgentScript engine. The agent process
        // is the source of truth; mirror its answer into the status broadcast.
        const want = !!msg.enabled;
        try {
          const r = await fetch("http://127.0.0.1:3000/api/local-full", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ enabled: want }),
          });
          const j = await r.json().catch(() => ({}));
          localFull = j.local_full === true ? true : j.local_full === false ? false : want;
          try { chrome.storage.local.set({ "rs-local-full": localFull }); } catch {}
        } catch {
          localFull = want; // agent unreachable — optimistic, corrected on next poll
          try { chrome.storage.local.set({ "rs-local-full": localFull }); } catch {}
        }
        broadcastStatus();
        sendResponse({ ok: true, enabled: localFull });
        break;
      }
      case "rs-get-full":
        sendResponse({ enabled: localFull });
        break;
      case "status":
        if (!connected) connect(); // self-heal after a worker wake-up
        sendResponse(statusObj());
        break;
      case "list_tools": {
        // Prefer a live refresh; fall back to cache so the loop never stalls.
        // 10s, not 25s: a catalogue request only blocks this long when one of the
        // MCP servers is dead (typically Roblox in a degraded, Blender-only
        // session), and in that exact case we already hold a perfectly good cached
        // catalogue. Waiting the full 25s just froze the boot for no new data.
        const r = await send({ type: "list_tools" }, 10000);
        if (r.ok && Array.isArray(r.tools)) toolsCache = r.tools;
        const tools = mergeBlenderTools(r.ok ? toolsCache : toolsCache);
        const ok = r.ok || tools.length > 0;
        sendResponse({ ok, tools, error: r.ok ? undefined : r.error });
        break;
      }
      case "call_tool": {
        const timeout = (msg.timeout || 120000) + 10000;
        if (blenderAddon && isBlenderToolName(msg.name)) {
          sendResponse(await blenderCall(msg.name, msg.arguments, timeout));
          break;
        }
        const r = await send(
          { type: "call_tool", name: msg.name, arguments: msg.arguments, timeout: msg.timeout },
          timeout,
          { connectWait: msg.connectWait }   // a screenshot asks for a short budget
        );
        // A capture tool that answers with a path or inline base64 is turned into a
        // real attachment HERE, so every caller benefits (and no rebuild is needed).
        sendResponse(await harvestToolImage(r, msg.name));
        break;
      }
      case "restart_mcp": {
        const r = await send({ type: "restart_mcp" }, 30000);
        if (r && r.ok) {
          const tools = await send({ type: "list_tools" }, 10000);
          if (tools && tools.ok && Array.isArray(tools.tools)) toolsCache = tools.tools;
          mcpAlive = true;
        }
        sendResponse(r);
        break;
      }
      case "local_read": {
        try {
          const text = await localReadAll(String(msg.path || ""));
          sendResponse({ ok: true, text });
        } catch (e) {
          sendResponse({ ok: false, error: String(e && e.message || e) });
        }
        break;
      }
      // Base64 read (any file: images, PDFs, binaries) — powers attach_feedback
      // ({"path": ...}), which puts a workspace file into the chat as an
      // attachment instead of pasting its text.
      case "local_read_base64": {
        try {
          const data = await localReadBase64(String(msg.path || ""));
          sendResponse({ ok: true, path: data.path, mimeType: data.mimeType, bytes: data.bytes, data: data.data });
        } catch (e) {
          sendResponse({ ok: false, error: String(e && e.message || e) });
        }
        break;
      }
      // OS-side Studio window capture / focus (no page permission involved).
      case "shot_test": {
        try { sendResponse(await shotTest()); } catch (e) { sendResponse({ ok: false, error: String((e && e.message) || e) }); }
        break;
      }
      case "studio_window_shot": {
        const r = await studioWindowShot({
          focus: msg.focus === true,
          focusOnly: msg.focus_only === true,
          maxWidth: msg.max_width,
          out: msg.out,
          wholeScreen: msg.whole_screen === true,
        });
        sendResponse(r);
        break;
      }
      // Version/health of the agent: the extension uses this to explain WHY a
      // screenshot could not be delivered instead of looping on the call.
      case "agent_info": {
        sendResponse(await agentInfo());
        break;
      }
      case "blender_connect": {
        sendResponse(await connectBlender());
        break;
      }
      case "blender_status": {
        sendResponse({ ok: blenderAddon, blender: blenderAddon, error: blenderError || undefined });
        break;
      }
      case "blender_disconnect": {
        setBlender(false, "");
        broadcastStatus();
        sendResponse({ ok: true, blender: false });
        break;
      }
      case "add_server": {
        // Native or-agent.exe rejects custom MCP. Blender uses blender_connect.
        if (String(msg.server_id || "").toLowerCase() === "blender") {
          sendResponse(await connectBlender());
          break;
        }
        const r = await send({
          type: "add_server", server_id: msg.server_id,
          command: msg.command, args: msg.args, env: msg.env,
        }, 15000);
        sendResponse(r);
        break;
      }
      case "remove_server": {
        const r = await send({ type: "remove_server", server_id: msg.server_id }, 15000);
        sendResponse(r);
        break;
      }
      case "reconnect":
        reconnectDelay = RECONNECT_MIN;
        connect();
        sendResponse({ ok: true });
        break;
      // ── ZeroScript Rust pipe — CORS bypass via background (content script → background → 127.0.0.1) ──
      case "rs-push":
      case "push_payload": {
        // Content script payload from AI chat (Gemini/ChatGPT/Claude) → local bridge
        // Must go through background to bypass chat site CORS on http://127.0.0.1
        try {
          const target = RUST_ROBLOX_HTTP;
          const res = await fetch(`${target}/api/push`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(msg.payload || msg),
          });
          const j = await res.json().catch(() => ({}));
          sendResponse({ ok: res.ok, ...j });
        } catch (e) {
          // Fallback to legacy WS if Rust HTTP not reachable
          const r = await send({ type: "call_tool", name: msg.name || "push_payload", arguments: msg.arguments || msg.payload || {} }, 10000);
          sendResponse(r);
        }
        break;
      }
      case "rs-poll": {
        try {
          const target = RUST_ROBLOX_HTTP;
          const res = await fetch(`${target}/api/poll?client_id=${encodeURIComponent(msg.client_id || engine)}`);
          const j = await res.json().catch(() => ({}));
          sendResponse(j);
        } catch (e) {
          sendResponse({ ok: false, error: String(e && e.message || e) });
        }
        break;
      }
      case "web_fetch": {
        try {
          let url = String(msg.url || "").trim();
          const query = String(msg.query || "").trim();
          if (!url) {
            const q = String(msg.q || query).trim();
            if (/^https?:\/\//i.test(q)) url = q;
          }
          let searchNote = "";
          if (!url) {
            const q = query || String(msg.q || "").trim();
            if (!q) { sendResponse({ ok: false, error: "url or query is required" }); break; }
            const found = await webSearch(q, 3);
            if (!found.hits.length) {
              sendResponse({ ok: false, error: `no search results for: ${q} (tried ${found.notes.join("; ") || "all backends"})` });
              break;
            }
            url = found.hits[0].url;
            searchNote = `Searched "${q}" [${found.backend}]. Top result: ${url}\n` +
              found.hits.map((h, i) => (i + 1) + ". " + h.title + " — " + h.url).join("\n") + "\n\n";
          }
          if (!/^https?:\/\//i.test(url)) { sendResponse({ ok: false, error: "url must start with http:// or https://" }); break; }
          const maxChars = Math.max(500, Math.min(50000, Number(msg.max_chars) || 12000));
          let text = "";
          let directWasHtml = false;
          let status = 0;
          let ctype = "";
          let via = "direct";
          const notes = [];
          try {
            const res = await fetchWithTimeout(url, { headers: webHeaders({}, (() => { try { return new URL(url).origin + "/"; } catch { return undefined; } })()) }, WEB_FETCH_TIMEOUT);
            status = res.status;
            ctype = (res.headers.get("content-type") || "").toLowerCase();
            if (!res.ok) {
              notes.push(`direct HTTP ${res.status}`);
            } else {
              let raw = await res.text();
              const looksHtml = /html|xml/.test(ctype) || /^\s*</.test(raw);
              directWasHtml = looksHtml;
              text = looksHtml ? htmlToText(raw) : raw.trim();
            }
          } catch (e) {
            notes.push("direct: " + String((e && e.message) || e).slice(0, 90));
          }
          // Reader proxy when the direct fetch failed, was blocked, or returned
          // a JavaScript shell we cannot read.
          // Short pages are only suspicious when they were HTML: a 200-char
          // plain-text/JSON answer is a complete document, and re-reading it
          // through a proxy would be wasted time.
          const wasShell = !text || (directWasHtml && looksLikeShell(text));
          if (wasShell) {
            try {
              const viaReader = await readerFallback(url, maxChars);
              if (viaReader) { text = viaReader; via = "reader"; }
            } catch (e) {
              notes.push("reader: " + String((e && e.message) || e).slice(0, 90));
            }
          }
          if (!text) {
            sendResponse({ ok: false, error: `fetch failed for ${url}${notes.length ? " (" + notes.join("; ") + ")" : ""}` });
            break;
          }
          const origLen = text.length;
          const truncated = origLen > maxChars;
          if (truncated) text = text.slice(0, maxChars) + `\n\n…[truncated ${origLen - maxChars} chars]`;
          const suffix = via === "reader"
            ? `\n\n[OR: the page served no readable text directly (${notes.join("; ") || "blocked"}), so it was read through a rendering proxy — layout/menus may be missing.]`
            : (wasShell
              ? `\n\n[OR: this page returned almost no readable text${notes.length ? " (" + notes.join("; ") + ")" : ""} — it is served by JavaScript or blocks non-browser readers, so the text above is all there is. Use web_search for a text source instead of relying on this page.]`
              : "");
          sendResponse({ ok: true, text: searchNote + text + suffix, truncated, status, url, content_type: ctype, via });
        } catch (e) { sendResponse({ ok: false, error: String(e && e.message || e) }); }
        break;
      }
      case "web_search": {
        try {
          const q = String(msg.query || msg.q || "").trim();
          if (!q) { sendResponse({ ok: false, error: "query is required" }); break; }
          const limit = Math.max(1, Math.min(8, Number(msg.limit) || 3));
          const found = await webSearch(q, limit);
          if (!found.hits.length) {
            sendResponse({ ok: false, error: `no results for '${q}' (tried ${found.notes.join("; ") || "all backends"})`, notes: found.notes });
            break;
          }
          const results = found.hits;
          const txt = results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}`).join("\n");
          sendResponse({ ok: true, text: `Searched "${q}" [${found.backend}]\n${txt}`, results, query: q, backend: found.backend, notes: found.notes });
        } catch (e) { sendResponse({ ok: false, error: String(e && e.message || e) }); }
        break;
      }
      case "ollama_list_models": {
        try {
          const res = await fetch("http://127.0.0.1:11434/api/tags");
          if (!res.ok) { sendResponse({ ok: false, error: `Ollama not running (HTTP ${res.status}) — run 'ollama serve'` }); break; }
          const j = await res.json();
          sendResponse({ ok: true, models: j.models || [] });
        } catch (e) { sendResponse({ ok: false, error: `Ollama not reachable at 127.0.0.1:11434 — is 'ollama serve' running? ${String(e&&e.message||e)}` }); }
        break;
      }
      // One-click start: ask whichever bridge is connected to spawn `ollama serve`.
      case "ollama_ensure": {
        const ask = (type) => send({ type, timeoutMs: 12000 });
        let r = await ask("start_ollama");
        if (!r || r.error === "bridge not connected") {
          // Engine bridge down? try the other port by flipping engine briefly is
          // too invasive; instead just report so popup can hint to run robloxscript-agent.exe.
          sendResponse({ ok: false, up: false, error: "bridge offline - run or-agent.exe first" });
          break;
        }
        sendResponse(r);
        break;
      }
      case "ollama_status": {
        const r = await send({ type: "ollama_status" }, 8000);
        if (!r || r.error === "bridge not connected") {
          sendResponse({ ok: false, up: false, error: "bridge offline" });
          break;
        }
        sendResponse(r);
        break;
      }
      case "ollama_chat": {
        try {
          let model = msg.model ? String(msg.model) : "";
          const messages = Array.isArray(msg.messages) ? msg.messages : [{role:"user", content:String(msg.prompt||"")}];
          // Validate the model against what is ACTUALLY installed before calling
          // /api/chat - a stale name (model deleted after being picked, or the
          // hardcoded default no longer pulled) otherwise surfaces as a raw 404
          // body. Return a structured error the page can react to (auto-recover).
          let available = [];
          try {
            const tr = await fetch("http://127.0.0.1:11434/api/tags");
            if (tr.ok) { const tj = await tr.json(); available = (tj.models || []).map(m => m.name); }
          } catch {}
          if (!available.length) {
            sendResponse({ ok:false, errKind:"no_server", error:"ERR: OLLAMA NOT RUNNING - nothing answered on 127.0.0.1:11434." });
            break;
          }
          if (!model || !available.includes(model)) {
            if (model) {
              sendResponse({
                ok: false, errKind: "model_not_found", available,
                error: `ERR: MODEL NOT FOUND - "${model}" is not installed anymore.`
              });
              break;
            }
            // No model given: fall back to a coder model if present, else first.
            const pref = available.find(n => /coder|code/i.test(n));
            model = pref || available[0];
          }
          const res = await fetch("http://127.0.0.1:11434/api/chat", {
            method: "POST",
            headers: { "Content-Type":"application/json" },
            body: JSON.stringify({ model, messages, stream: false })
          });
          if (!res.ok) {
            const t = await res.text().catch(()=> "");
            sendResponse({ ok: false, errKind:"http_"+res.status, model,
              error: `Ollama chat HTTP ${res.status}: ${t.slice(0,400)}` });
            break;
          }
          const j = await res.json();
          const text = (j.message && j.message.content) || j.response || "";
          sendResponse({ ok: true, text, model, raw: j });
        } catch (e) { sendResponse({ ok: false, error: `Ollama chat failed: ${String(e&&e.message||e)} - try OLLAMA_ORIGINS=* ollama serve` }); }
        break;
      }
      case "resolve_universe": {
        try { sendResponse(await robloxResolveUniverse(msg)); }
        catch (e) { sendResponse({ ok: false, error: String(e && e.message || e) }); }
        break;
      }
      case "create_dev_product": {
        try { sendResponse(await robloxCreateDevProduct(msg)); }
        catch (e) { sendResponse({ ok: false, error: String(e && e.message || e) }); }
        break;
      }
      case "list_dev_products": {
        try { sendResponse(await robloxListDevProducts(msg)); }
        catch (e) { sendResponse({ ok: false, error: String(e && e.message || e) }); }
        break;
      }
      // Which tab is IN FRONT, asked BEFORE a capture: captureVisibleTab always
      // photographs that one, so the caller can warn instead of silently handing
      // the model a picture of an unrelated page.
      case "tab_front": {
        const windowId = (_sender.tab && _sender.tab.windowId) || undefined;
        const senderTabId = (_sender.tab && _sender.tab.id) || null;
        let front = null;
        try {
          const tabs = await chrome.tabs.query(
            windowId === undefined ? { active: true, lastFocusedWindow: true } : { active: true, windowId }
          );
          front = (tabs && tabs[0]) || null;
        } catch {}
        sendResponse({
          ok: true,
          url: (front && front.url) || "",
          title: (front && front.title) || "",
          is_sender_tab: !!front && senderTabId !== null && front.id === senderTabId,
          capturable: !!front && /^https?:/i.test((front && front.url) || ""),
        });
        break;
      }
      case "capture_tab": {
        // captureVisibleTab photographs whichever tab is IN FRONT in the window,
        // and Chrome only allows it when the extension is permitted on THAT page:
        //   * "activeTab" is granted by clicking the toolbar icon / context menu
        //     (OR is driven from inside the page, so it never gets that grant), or
        //   * the page must be covered by host_permissions.
        // chrome:// pages, the New Tab page, PDFs and other extensions' pages can
        // NEVER be captured, and neither can a site where the user set OR's
        // "Site access" to on-click/limited.
        // So this reports WHICH tab was in front (and whether it was this chat)
        // instead of a bare "Either the '<all_urls>' or 'activeTab' permission is
        // required", which told the model nothing it could act on.
        const windowId = (_sender.tab && _sender.tab.windowId) || undefined;
        const senderTabId = (_sender.tab && _sender.tab.id) || null;
        let front = null;
        try {
          const tabs = await chrome.tabs.query(
            windowId === undefined ? { active: true, lastFocusedWindow: true } : { active: true, windowId }
          );
          front = (tabs && tabs[0]) || null;
        } catch {}
        const frontUrl = (front && front.url) || "";
        const frontTitle = (front && front.title) || "";
        const isSenderTab = !!front && senderTabId !== null && front.id === senderTabId;
        // Name it exactly: a bare title ("Extensions") does not tell the user
        // WHICH kind of page blocked the capture.
        const where = frontTitle && frontUrl ? `${frontTitle} (${frontUrl})`
          : (frontUrl || frontTitle || "a browser-internal page (chrome://, New Tab or a PDF)");
        try {
          const dataUrl = await new Promise((resolve, reject) => {
            try {
              chrome.tabs.captureVisibleTab(windowId, { format: "png" }, (url) => {
                if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
                else resolve(url);
              });
            } catch (e) { reject(e); }
          });
          const m = String(dataUrl || "").match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
          if (!m) {
            sendResponse({ ok: false, error: "tab capture returned no image" });
            break;
          }
          sendResponse({
            ok: true,
            images: [{ mimeType: m[1], data: m[2] }],
            captured: { url: frontUrl, title: frontTitle, is_sender_tab: isSenderTab },
            // The model MUST know when it is looking at the wrong screen: a
            // capture of an unrelated tab used to be described as "Studio looks
            // like this".
            warning: isSenderTab ? undefined
              : `this is a capture of '${where}' (the tab in front), NOT of this chat`,
          });
        } catch (e) {
          const msg = String((e && e.message) || e);
          const blocked = /permission|all_urls|activeTab|not allowed/i.test(msg);
          sendResponse({
            ok: false,
            error: msg + (blocked
              ? ` - Chrome only lets OR photograph a page it is allowed to read, and it photographs the tab in FRONT: that was '${where}'. Bring the chat tab (or any normal http/https page) to the front and retry; chrome:// pages, the New Tab page and PDF viewers can never be captured.`
              : ""),
            front_url: frontUrl,
            front_title: frontTitle,
          });
        }
        break;
      }
      default:
        sendResponse({ ok: false, error: "unknown message" });
    }
  })();
  return true; // async sendResponse
});

// Proc poll — keeps RS availability gated on the live Studio process
refreshProcStatus();
setInterval(refreshProcStatus, 5000);

// Wake/keepalive hooks.
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);

connect();
