import io
def load(p): return io.open(p, encoding="utf-8", newline="").read()
def save(p, s): io.open(p, "w", encoding="utf-8", newline="").write(s)

p = "core/main.js"
s = load(p)
old = '''      rememberImages(shots, "or_screenshot:" + target);
      ui.showImages(shots, "or_screenshot");
      A.pendingImages = shots;
      const caption = notes.join("; ") || (shots.length + " image(s) captured");
      return "Output of 'or_screenshot':\\n" + caption + "\\n(The image is attached to THIS message — you can see it directly. Analyse it and continue.)";'''
assert s.count(old) == 1, s.count(old)
new = '''      rememberImages(shots, "or_screenshot:" + target);
      ui.showImages(shots, "or_screenshot");
      A.pendingImages = shots;
      // The clipboard is the ONE delivery route that cannot break: no site cooperation,
      // no provider, no agent. Put the picture there too and say so, so that even if a
      // chat site refuses the attachment the user presses Ctrl+V and has it anyway.
      let copied = false;
      try { copied = !!(await copyImageToClipboard(shots[0])).ok; } catch {}
      const caption = notes.join("; ") || (shots.length + " image(s) captured");
      return "Output of 'or_screenshot':\\n" + caption +
        "\\n(The image is attached to THIS message — you can see it directly. Analyse it and continue.)" +
        (copied ? "\\nIt is also on your clipboard, so Ctrl+V drops it in by hand if a site ever refuses the attachment." : "");'''
s = s.replace(old, new, 1)

# the same for attach_feedback's send path, which is what "re-send the screenshot" means
old2 = '''      rememberImages([img], "attach_feedback");'''
assert s.count(old2) == 1
new2 = '''      rememberImages([img], "attach_feedback");
      // Same promise as or_screenshot: the picture is on the clipboard as well, so the
      // user is never stuck waiting on a site to accept it.
      try { if (isImage) await copyImageToClipboard(img); } catch {}'''
s = s.replace(old2, new2, 1)
save(p, s)
print("main.js: captures land on the clipboard too")

p = "test-shots.js"
t = load(p)
anchor = '''        ok("...and the zero-argument call is never made at all",'''
assert t.count(anchor) == 1
add = '''        ok("a delivered screenshot is ALSO put on the clipboard (Ctrl+V always works)",
           /also on your clipboard/.test(shot) && /Ctrl\\+V/.test(shot), shot.slice(-220));
''' + anchor
t = t.replace(anchor, add, 1)
save(p, t)
print("test-shots.js: clipboard assertion")
