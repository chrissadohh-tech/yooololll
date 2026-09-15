import io
def load(p): return io.open(p, encoding="utf-8", newline="").read()
def save(p, s): io.open(p, "w", encoding="utf-8", newline="").write(s)
def swap(s, old, new, tag):
    for e in ("\n", "\r\n"):
        o = old.replace("\n", e)
        if s.count(o) == 1:
            return s.replace(o, new.replace("\n", e), 1)
    raise AssertionError((tag, "no match"))

p = "background.js"
s = load(p)
# Drop the proactive list_tools: it put an extra frame in front of every MCP call (which
# the bridge tests rightly noticed) and it is not needed - when the catalogue is in hand
# the schema path fills the argument, and when it is not, the server's own error names it.
s = swap(s, '''// The catalogue is fetched lazily on first need, so a call arriving before any
// list_tools still gets its required arguments filled instead of failing once first.
let schemaFetchAt = 0;
async function ensureMcpSchema(name) {
  if (mcpSchemaFor(name)) return;
  const n = String(name || "");
  const isWorkspaceTool = (localToolsCache || []).some((x) => x && String((x.name || x.id) || "") === n);
  if (isWorkspaceTool) return;                       // no MCP schema exists for these
  if (Date.now() - schemaFetchAt < 5000) return;     // one attempt per 5s, never a loop
  schemaFetchAt = Date.now();
  try {
    const r = await send({ type: "list_tools" }, 10000);
    if (r && Array.isArray(r.tools)) toolsCache = r.tools;
  } catch {}
}
''', "", "remove ensureMcpSchema")
s = swap(s, '''        await ensureMcpSchema(msg.name);
        const pre = fillRequiredArgs(msg.name, msg.arguments);''',
        '''        const pre = fillRequiredArgs(msg.name, msg.arguments);''', "remove call")
save(p, s)
print("background.js: proactive fetch removed")
