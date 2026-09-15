import io

MSG = ('throw new Error("OR_IMAGE_ATTACH_FAILED: the screenshot did not reach this chat\'s composer, '
       'so nothing was sent (the picture IS the message). Retry, or use attach_feedback {action:\\"copy\\"} '
       'and paste it with Ctrl+V.");')

def load(p):
    return io.open(p, encoding="utf-8", newline="").read()
def save(p, s):
    io.open(p, "w", encoding="utf-8", newline="").write(s)
def eol(s):
    return "\r\n" if "\r\n" in s else "\n"
def swap(s, old, new, path):
    e = eol(s)
    o = old.replace("\n", e); n = new.replace("\n", e)
    c = s.count(o)
    assert c == 1, (path, c, old.split("\n")[0][:70])
    return s.replace(o, n)

# gemini
p = "providers/gemini.js"; s = load(p)
old = """        try { const ok = await attachImages(images); diag("attach.afterCall", { ok }); }
        catch (e) { diag("attach.threw", { msg: String((e && e.message) || e) }); }"""
new = """        // If the picture never reaches the composer, sending anyway tells the model to
        // look at an image it cannot see. Retry once, then refuse - unless the site is
        // already showing a staged preview, which is proof enough that it worked.
        let orAttached = false;
        for (let orTry = 0; orTry < 2 && !orAttached; orTry++) {
          try { orAttached = (await attachImages(images)) !== false; diag("attach.afterCall", { ok: orAttached }); }
          catch (e) { orAttached = false; diag("attach.threw", { msg: String((e && e.message) || e) }); }
        }
        if (!orAttached && !hasPendingAttachment()) { %s }""" % MSG
s = swap(s, old, new, p); save(p, s); print("gemini patched")

# copilot
p = "providers/copilot.js"; s = load(p)
old = """      try { await attachImages(images); } catch (e) { diag("attach.err", { msg: String(e && e.message || e).slice(0, 120) }); }"""
new = """      // A picture-less send would leave the model describing nothing, so make sure it
      // landed: retry once, then refuse instead of pretending.
      let orAttached = false;
      for (let orTry = 0; orTry < 2 && !orAttached; orTry++) {
        try { orAttached = (await attachImages(images)) !== false; }
        catch (e) { orAttached = false; diag("attach.err", { msg: String((e && e.message) || e).slice(0, 120) }); }
      }
      if (!orAttached) { %s }""" % MSG
s = swap(s, old, new, p); save(p, s); print("copilot patched")

# meta
p = "providers/meta.js"; s = load(p)
old = """      try {
        const ok = await attachImages(images);
        if (ok) _attachedImages = images;
        diag("meta.tas.attached", { ok, imgId: images.__rsId });
      } catch (e) { diag("meta.tas.attachErr", { msg: String((e && e.message) || e) }); }"""
new = """      let ok = false;
      try {
        ok = await attachImages(images);
        if (ok) _attachedImages = images;
        diag("meta.tas.attached", { ok, imgId: images.__rsId });
      } catch (e) { diag("meta.tas.attachErr", { msg: String((e && e.message) || e) }); }
      if (!ok) {
        // One retry (uploads are timing-sensitive), then refuse to send the text alone:
        // a message claiming a picture the model cannot see is worse than an error.
        try { ok = await attachImages(images); if (ok) _attachedImages = images; } catch { ok = false; }
      }
      if (!ok && !hasPendingAttachment()) { %s }""" % MSG
s = swap(s, old, new, p); save(p, s); print("meta patched")

# arena
p = "providers/arena.js"; s = load(p)
old = """      try {
        const ok = await attachImages(images);
        if (ok) _attachedImages = images;
        diag("arena.tas.attached", { imgId: images.__rsId, ok, pendingAfter: pendingCount() });
      } catch (e) { diag("arena.tas.attachErr", { msg: String((e && e.message) || e) }); }"""
new = """      let ok = false;
      try {
        ok = await attachImages(images);
        if (ok) _attachedImages = images;
        diag("arena.tas.attached", { imgId: images.__rsId, ok, pendingAfter: pendingCount() });
      } catch (e) { diag("arena.tas.attachErr", { msg: String((e && e.message) || e) }); }
      if (!ok) {
        // Retry once, then refuse to send a message whose picture never arrived.
        try { ok = await attachImages(images); if (ok) _attachedImages = images; } catch { ok = false; }
      }
      if (!ok && !hasPendingAttachment()) { %s }""" % MSG
s = swap(s, old, new, p); save(p, s); print("arena patched")

# ollama
p = "providers/ollama.js"; s = load(p)
old = """    if(images && images.length){ try{ await attachImages(images); }catch{} }"""
new = """    if(images && images.length){
      // The screenshot IS the message: if it did not stage, stop rather than send text
      // that points the model at a picture it cannot see.
      let orAttached=false;
      for(let orTry=0; orTry<2 && !orAttached; orTry++){
        try{ orAttached=(await attachImages(images))!==false; }catch{ orAttached=false; }
      }
      if(!orAttached){ %s }
    }""" % MSG
s = swap(s, old, new, p); save(p, s); print("ollama patched")
