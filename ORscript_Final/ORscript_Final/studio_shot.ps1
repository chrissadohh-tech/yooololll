# SPDX-License-Identifier: GPL-3.0-or-later
# studio_shot.ps1 - photograph the Roblox Studio WINDOW on Windows, outside the
# browser. Run by the OR agent (never by the page): the extension writes this file
# into the agent workspace, then runs it with `run_command`.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File studio_shot.ps1 -Out or_studio_window.png
#   powershell -NoProfile -ExecutionPolicy Bypass -File studio_shot.ps1 -Out or_studio_window.png -Focus
#   powershell -NoProfile -ExecutionPolicy Bypass -File studio_shot.ps1 -FocusOnly
#
# WHY THIS EXISTS: a Chrome extension cannot screenshot a window that is not a
# tab, and chrome.tabs.captureVisibleTab only photographs the tab IN FRONT (and
# refuses chrome:// pages entirely). Studio is a separate desktop application, so
# the only way to see it is from the OS side.
#
# TWO CAPTURE PATHS (best first):
#   1. PrintWindow(hwnd, hdc, PW_RENDERFULLCONTENT) - works while Studio is BEHIND
#      other windows, so the user's workflow is not interrupted. Some GPU surfaces
#      come back black, which is DETECTED (uniform frame) and reported via
#      "method":"printwindow-blank" so the caller can retry with -Focus.
#   2. Bring the window to the front, then BitBlt the screen over the window rect.
#      Always correct, but steals focus - therefore opt-in via -Focus.
# TEXT TUNNEL: with -NoB64 off (the default) the capture is also written as
# <Out>.b64 - the same bytes as base64 text, one $Wrap-char line each. An older
# or-agent.exe (no read_file_base64) still HAS read_file, so the extension reads
# that text back in chunks and rebuilds the image in the browser. That is what
# makes a screenshot work without rebuilding the agent. \n-only line endings on
# purpose: a \r would land inside the base64 and corrupt the picture.
# Exit codes: 0 ok, 2 no Studio window, 3 capture failed. Machine-readable line
# "OR_STUDIO_SHOT {...}" is printed last so the caller does not have to parse
# PowerShell prose.

param(
  [string]$Out = "or_studio_window.png",
  [switch]$Focus,
  [switch]$FocusOnly,
  [int]$MaxWidth = 1600,
  [string]$ProcessName = "",
  # ── text tunnel ─────────────────────────────────────────────────────────
  # The extension can only read a local file through the agent. A NEW agent
  # (>= 1.18.0) has read_file_base64 and needs this off; an OLDER exe does not,
  # so the picture travels as BASE64 TEXT instead: this writes <Out>.b64 (one
  # long line per $Wrap chars) and the extension reads it back with read_file in
  # chunks. Nothing else about the capture changes.
  [switch]$NoB64 = $false,
  [int]$Wrap = 400,
  # JPEG shrinks the payload ~10x, which is what makes the tunnel a handful of
  # chunks instead of dozens. -Png forces a lossless file.
  [switch]$Png = $false,
  [int]$Quality = 78,
  # -SelfTest proves the capture machinery works on THIS machine without Roblox
  # Studio being open: it builds a small bitmap in memory, JPEG-encodes it, writes
  # the .b64 twin, decodes that back and compares checksums. Run it before blaming
  # a missing screenshot on Studio - if this passes, only the window matters.
  [switch]$SelfTest = $false,
  # -B64Only <path>: no capture at all - just turn an EXISTING file (e.g. the PNG the
  # Blender addon wrote) into the same <path>.b64 text twin, so an older agent can
  # hand it over too. Prints the same OR_STUDIO_SHOT line.
  # -WholeScreen: capture the ENTIRE desktop (all monitors). Needs no Roblox
  # Studio window at all - this is the "screenshot of my whole PC" route.
  [switch]$WholeScreen,
  [string]$B64Only = ""
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing
$script:UseJpeg = (-not $Png)
$script:JpegQuality = [Math]::Max(20, [Math]::Min(100, $Quality))

$src = @"
using System;
using System.Runtime.InteropServices;
public class ORWin {
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hwnd, int cmd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, IntPtr pid);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr hwnd, uint cmd);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  public struct RECT { public int Left, Top, Right, Bottom; }
}
"@
# The compiled helper is the FAST path (PrintWindow = capture while Studio stays
# behind). Compiling C# at runtime is the most fragile thing in this file: a locked-down
# Windows, a missing csc, or an antivirus policy can block it. It used to be wrapped in
# "catch { }", so a blocked compile showed up later as an unhelpful crash with no result
# line. Now the failure is remembered and the script degrades to a pure-.NET route.
if (-not ("ORWin" -as [type])) {
  try { Add-Type -TypeDefinition $src -ErrorAction Stop } catch { $script:CompileError = $_.Exception.Message }
}
$script:Compiled = [bool]("ORWin" -as [type])

# PW_RENDERFULLCONTENT (0x2) is what makes a GPU/DirectX window printable.
$PW_RENDERFULLCONTENT = 0x2

function Get-StudioWindow {
  param([string]$Name)
  $names = @()
  if ($Name) { $names += $Name } else { $names += @("RobloxStudioBeta", "RobloxStudio", "Roblox Studio") }
  foreach ($n in $names) {
    $procs = @(Get-Process -Name $n -ErrorAction SilentlyContinue)
    foreach ($p in $procs) {
      # Prefer a real top-level window; skip the tiny helper windows Studio opens.
      $h = $p.MainWindowHandle
      if ($h -eq [IntPtr]::Zero) { continue }
      $r = Get-WindowRect -Handle $h
      if ($null -eq $r) { continue }
      $w = $r.Right - $r.Left; $ht = $r.Bottom - $r.Top
      if ($w -lt 200 -or $ht -lt 150) { continue }
      return [pscustomobject]@{ Handle = $h; Proc = $p; Width = $w; Height = $ht; Rect = $r; Name = $p.ProcessName }
    }
  }
  return $null
}

function Bring-ToFront {
  param([IntPtr]$Handle)
  # Windows refuses SetForegroundWindow from a background process unless the
  # calling thread shares the foreground thread's input queue. Attaching to it
  # for the duration of the call is the standard, non-hacky workaround (same
  # trick the reliable "activate window" snippets use).
  if ([ORWin]::IsIconic($Handle)) { [void][ORWin]::ShowWindow($Handle, 9) }  # SW_RESTORE
  $fg = [ORWin]::GetForegroundWindow()
  $fgThread = [ORWin]::GetWindowThreadProcessId($fg, [IntPtr]::Zero)
  $myThread = [ORWin]::GetCurrentThreadId()
  $attached = $false
  if ($fgThread -ne 0 -and $fgThread -ne $myThread) {
    $attached = [ORWin]::AttachThreadInput($fgThread, $myThread, $true)
  }
  try {
    [void][ORWin]::SetWindowPos($Handle, [IntPtr]::Zero, 0, 0, 0, 0, 0x0003)  # NOMOVE|NOSIZE|SHOWWINDOW -> top of Z-order
    [void][ORWin]::SetForegroundWindow($Handle)
    Start-Sleep -Milliseconds 250
  } finally {
    if ($attached) { [void][ORWin]::AttachThreadInput($fgThread, $myThread, $false) }
  }
  return ([ORWin]::GetForegroundWindow() -eq $Handle)
}

function Get-WindowRect {
  param([IntPtr]$Handle)
  # Preferred: the compiled P/Invoke helper. Returns @{Left;Top;Right;Bottom} or $null.
  if ($script:Compiled) {
    try {
      $r = New-Object ORWin+RECT
      if ([ORWin]::GetWindowRect($Handle, [ref]$r)) {
        return @{ Left = $r.Left; Top = $r.Top; Right = $r.Right; Bottom = $r.Bottom }
      }
    } catch { }
  }
  # No compiler available: UI Automation reports a window's bounding box through a
  # managed API (no code compilation, just an assembly load).
  try {
    Add-Type -AssemblyName UIAutomationClient -ErrorAction Stop
    Add-Type -AssemblyName UIAutomationTypes -ErrorAction Stop
    $el = [System.Windows.Automation.AutomationElement]::FromHandle($Handle)
    if ($el -ne $null) {
      $b = $el.Current.BoundingRectangle
      if ($b.Width -gt 50 -and $b.Height -gt 50) {
        return @{ Left = [int]$b.Left; Top = [int]$b.Top; Right = [int]$b.Right; Bottom = [int]$b.Bottom }
      }
    }
  } catch { }
  # Last resort: the whole primary screen. Studio is raised first, so it is what the
  # picture shows - just with the desktop around it.
  try {
    Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop
    $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    return @{ Left = $b.X; Top = $b.Y; Right = ($b.X + $b.Width); Bottom = ($b.Y + $b.Height) }
  } catch { }
  return $null
}

function Bring-ToFront-NoCompile {
  param($Proc)
  # WScript.Shell.AppActivate is a COM call - it needs no C# compiler, which is the
  # whole point of this fallback. Returns $true when Windows reports the window active.
  try {
    $ws = New-Object -ComObject WScript.Shell
    $null = $ws.AppActivate($Proc.Id)
    Start-Sleep -Milliseconds 400
    return $true
  } catch {
    return $false
  }
}

function Save-Bitmap {
  param($Bmp, [string]$Path)
  if ($script:UseJpeg) {
    # JPEG with an explicit quality level: the default encoder setting is ~75
    # anyway, but being explicit keeps the tunnel payload predictable.
    $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq "image/jpeg" }
    $pars = New-Object System.Drawing.Imaging.EncoderParameters(1)
    $pars.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [long]$script:JpegQuality)
    $Bmp.Save($Path, $codec, $pars)
  } else {
    $Bmp.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
  }
}

function Get-Sha256Hex {
  param([byte[]]$Bytes)
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($sha.ComputeHash($Bytes)) -replace "-", "").ToLowerInvariant() }
  finally { $sha.Dispose() }
}

# The text tunnel: base64 of the captured file, wrapped into fixed-width lines so
# the extension can read it with read_file(offset/limit) without ever splitting a
# line. Written with \n only - read_file splits on \n, and a stray \r would end up
# INSIDE the base64 and corrupt the image. Returns a small table for the JSON line.
function Write-B64File {
  param([string]$Path, [int]$Wrap)
  $bytes = [System.IO.File]::ReadAllBytes($Path)
  $b64 = [Convert]::ToBase64String($bytes)
  $w = [Math]::Max(60, [Math]::Min(4000, $Wrap))
  $sb = New-Object System.Text.StringBuilder
  for ($i = 0; $i -lt $b64.Length; $i += $w) {
    [void]$sb.Append($b64.Substring($i, [Math]::Min($w, $b64.Length - $i)))
    [void]$sb.Append("`n")
  }
  [System.IO.File]::WriteAllText($Path, $sb.ToString(), (New-Object System.Text.UTF8Encoding($false)))
  return @{
    base64_file = $Path
    base64_chars = $b64.Length
    base64_lines = [Math]::Ceiling($b64.Length / $w)
    sha256 = (Get-Sha256Hex -Bytes $bytes)
    bytes = $bytes.Length
    mime = $(if ($script:UseJpeg) { "image/jpeg" } else { "image/png" })
  }
}

function Get-FrameStats {
  # Cheap "is this frame blank?" test: sample a grid of pixels and report how many
  # distinct colours we saw. A black/empty GPU frame is one or two colours.
  param($Bmp)
  $seen = @{}
  for ($x = 0; $x -lt $Bmp.Width; $x += [Math]::Max(1, [int]($Bmp.Width / 24))) {
    for ($y = 0; $y -lt $Bmp.Height; $y += [Math]::Max(1, [int]($Bmp.Height / 24))) {
      $c = $Bmp.GetPixel($x, $y).ToArgb()
      if (-not $seen.ContainsKey($c)) { $seen[$c] = 0 }
      $seen[$c] = $seen[$c] + 1
    }
  }
  $max = 0
  foreach ($k in $seen.Keys) { if ($seen[$k] -gt $max) { $max = $seen[$k] } }
  $total = 0
  foreach ($k in $seen.Keys) { $total += $seen[$k] }
  return [pscustomobject]@{ Colours = $seen.Count; DominantShare = if ($total -gt 0) { $max / $total } else { 1 } }
}

function Scale-Bitmap {
  param($Bmp, [int]$MaxW)
  if ($MaxW -le 0 -or $Bmp.Width -le $MaxW) { return $Bmp }
  $ratio = $MaxW / $Bmp.Width
  $w = $MaxW; $h = [int]($Bmp.Height * $ratio)
  $dst = New-Object System.Drawing.Bitmap($w, $h)
  $g = [System.Drawing.Graphics]::FromImage($dst)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.DrawImage($Bmp, 0, 0, $w, $h)
  $g.Dispose()
  return $dst
}

# ── -B64Only: make the text twin of an existing file (no capture) ──────────
if ($B64Only -ne "") {
  try {
    if (-not (Test-Path -LiteralPath $B64Only)) {
      Write-Output ("OR_STUDIO_SHOT " + (@{ ok = $false; b64_only = $true; error = ("no such file: " + $B64Only); code = 3 } | ConvertTo-Json -Compress -Depth 3))
      exit 3
    }
    $len = (Get-Item -LiteralPath $B64Only).Length
    # The agent refuses to read a file over 2 MB as text, and base64 inflates by 4/3.
    if ($len -gt 1400000) {
      Write-Output ("OR_STUDIO_SHOT " + (@{ ok = $false; b64_only = $true; error = ("the file is " + [Math]::Round($len / 1MB, 2) + " MB - too big to hand over as text; capture it smaller"); code = 3 } | ConvertTo-Json -Compress -Depth 3))
      exit 3
    }
    $t = Write-B64File -Path ($B64Only + ".b64") -Wrap $Wrap
    Write-Output ("OR_STUDIO_SHOT " + (@{
      ok = $true; b64_only = $true; file = $B64Only; bytes = $t.bytes; mime = $t.mime
      base64_file = $t.base64_file; base64_chars = $t.base64_chars; base64_lines = $t.base64_lines
      sha256 = $t.sha256; tunnel_error = ""
    } | ConvertTo-Json -Compress -Depth 4))
    exit 0
  } catch {
    Write-Output ("OR_STUDIO_SHOT " + (@{ ok = $false; b64_only = $true; error = ("could not write the text twin: " + $_.Exception.Message); code = 3 } | ConvertTo-Json -Compress -Depth 3))
    exit 3
  }
}

# ── -SelfTest: the encoding + tunnel path, no Studio required ──────────────
if ($SelfTest) {
  try {
    $bmp = New-Object System.Drawing.Bitmap(320, 200)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.Clear([System.Drawing.Color]::FromArgb(24, 26, 32))
    $g.FillRectangle([System.Drawing.Brushes]::CornflowerBlue, 20, 20, 160, 90)
    $g.FillEllipse([System.Drawing.Brushes]::Goldenrod, 200, 60, 90, 90)
    $g.DrawString("OR self-test", (New-Object System.Drawing.Font("Segoe UI", 14)), [System.Drawing.Brushes]::White, 18, 140)
    $g.Dispose()
    $small = Scale-Bitmap -Bmp $bmp -MaxW 240
    $sf = Join-Path (Get-Location) "or_shot_selftest.jpg"
    try { Save-Bitmap -Bmp $small -Path $sf } finally { if ($small -ne $bmp) { $small.Dispose() }; $bmp.Dispose() }
    $t = Write-B64File -Path ($sf + ".b64") -Wrap $Wrap
    # decode the tunnel text back and compare checksums, exactly like the extension does
    $flat = ([System.IO.File]::ReadAllText($sf + ".b64")) -replace "\r", "" -replace "\n", ""
    $back = [Convert]::FromBase64String($flat)
    $roundtrip = ((Get-Sha256Hex -Bytes $back) -eq (Get-Sha256Hex -Bytes ([System.IO.File]::ReadAllBytes($sf))))
    Write-Output ("OR_STUDIO_SHOT " + (@{
      ok = $true; selftest = $true; file = $sf; bytes = $t.bytes; mime = $t.mime
      base64_file = $t.base64_file; base64_chars = $t.base64_chars; base64_lines = $t.base64_lines
      sha256 = $t.sha256; roundtrip_ok = [bool]$roundtrip
      jpeg_ok = [bool]((Get-Item -LiteralPath $sf).Length -gt 500)
      route = $(if ($script:Compiled) { "compiled" } else { "no-compile" })
      compile_error = $(if ($script:CompileError) { $script:CompileError } else { "" })
      tunnel_error = ""
    } | ConvertTo-Json -Compress -Depth 4))
    exit 0
  } catch {
    Write-Output ("OR_STUDIO_SHOT " + (@{ ok = $false; selftest = $true; error = ("self-test failed: " + $_.Exception.Message); code = 3 } | ConvertTo-Json -Compress -Depth 3))
    exit 3
  }
}

# ── -WholeScreen: the entire desktop, all monitors, no Studio needed ────────
# This runs BEFORE the Studio window lookup on purpose: "screenshot my whole PC"
# must work with Studio closed, minimized or on another monitor.
if ($WholeScreen) {
  try {
    Add-Type -AssemblyName System.Windows.Forms
    $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
    if ($vs.Width -lt 100 -or $vs.Height -lt 100) {
      Write-Output ("OR_STUDIO_SHOT " + (@{ ok = $false; whole_screen = $true; error = ("the desktop size came back unusable (" + $vs.Width + "x" + $vs.Height + ") - is there an interactive session?"); code = 3 } | ConvertTo-Json -Compress -Depth 3))
      exit 3
    }
    $full = Join-Path (Get-Location) $Out
    if ([System.IO.Path]::IsPathRooted($Out)) { $full = $Out }
    $full = [System.IO.Path]::ChangeExtension($full, $(if ($script:UseJpeg) { ".jpg" } else { ".png" }))
    $bmp = New-Object System.Drawing.Bitmap($vs.Width, $vs.Height)
    $gfx = [System.Drawing.Graphics]::FromImage($bmp)
    try { $gfx.CopyFromScreen($vs.Left, $vs.Top, 0, 0, (New-Object System.Drawing.Size($vs.Width, $vs.Height))) }
    finally { $gfx.Dispose() }
    $final = Scale-Bitmap -Bmp $bmp -MaxW $MaxWidth
    try { Save-Bitmap -Bmp $final -Path $full } finally { $final.Dispose(); $bmp.Dispose() }
    $tunnel = @{ base64_file = ""; base64_chars = 0; base64_lines = 0; sha256 = ""; bytes = 0; mime = "" }
    if (-not $NoB64) {
      try { $tunnel = Write-B64File -Path ($full + ".b64") -Wrap $Wrap }
      catch { $tunnel = @{ base64_file = ""; base64_chars = 0; base64_lines = 0; sha256 = ""; bytes = 0; mime = ""; tunnel_error = $_.Exception.Message } }
    }
    Write-Output ("OR_STUDIO_SHOT " + (@{
      ok = $true
      whole_screen = $true
      file = $full
      bytes = (Get-Item -LiteralPath $full).Length
      method = "fullscreen"
      focused = $false
      width = $vs.Width
      height = $vs.Height
      window = @{ process = "desktop"; pid = 0; width = $vs.Width; height = $vs.Height }
      base64_file = $tunnel.base64_file
      base64_chars = $tunnel.base64_chars
      base64_lines = $tunnel.base64_lines
      sha256 = $tunnel.sha256
      mime = $tunnel.mime
      tunnel_error = $(if ($tunnel.tunnel_error) { $tunnel.tunnel_error } else { "" })
      route = $(if ($script:Compiled) { "compiled" } else { "no-compile" })
      compile_error = $(if ($script:CompileError) { $script:CompileError } else { "" })
    } | ConvertTo-Json -Compress -Depth 4))
    exit 0
  } catch {
    Write-Output ("OR_STUDIO_SHOT " + (@{ ok = $false; whole_screen = $true; error = ("whole-screen capture failed: " + $_.Exception.Message); code = 3 } | ConvertTo-Json -Compress -Depth 3))
    exit 3
  }
}

$win = Get-StudioWindow -Name $ProcessName
if ($null -eq $win) {
  $why = "no visible Roblox Studio window found - open Studio (and un-minimize it) first"
  if ($script:CompileError) { $why += " [note: the fast PrintWindow helper could not be compiled - " + $script:CompileError + "]" }
  Write-Output ("OR_STUDIO_SHOT " + (@{ ok = $false; error = $why; route = $(if ($script:Compiled) { "compiled" } else { "no-compile" }); code = 2 } | ConvertTo-Json -Compress -Depth 3))
  exit 2
}

if ($FocusOnly) {
  $ok = Bring-ToFront -Handle $win.Handle
  Write-Output ("OR_STUDIO_SHOT " + (@{
    ok = $true; focus_only = $true; focused = [bool]$ok; base64_file = ""; bytes = 0
    window = @{ title = ""; process = $win.Name; pid = $win.Proc.Id; width = $win.Width; height = $win.Height }
    note = if ($ok) { "Roblox Studio is now the front window" } else { "Windows refused to give Studio keyboard focus - it was raised above other windows instead" }
  } | ConvertTo-Json -Compress -Depth 4))
  exit 0
}

$full = Join-Path (Get-Location) $Out
if (-not [System.IO.Path]::IsPathRooted($Out)) { $full = Join-Path (Get-Location) $Out } else { $full = $Out }

# ── path 1: PrintWindow (no focus change) ──────────────────────────────────
$method = $(if ($script:Compiled) { "printwindow" } else { "screen-nocompile" })
$bmp = $null
if ($script:Compiled) {
  $bmp = New-Object System.Drawing.Bitmap($win.Width, $win.Height)
  try {
    $gfx = [System.Drawing.Graphics]::FromImage($bmp)
    $hdc = $gfx.GetHdc()
    $ok = $false
    try { $ok = [ORWin]::PrintWindow($win.Handle, $hdc, $PW_RENDERFULLCONTENT) } finally { $gfx.ReleaseHdc($hdc); $gfx.Dispose() }
  if ($ok) {
    $stats = Get-FrameStats -Bmp $bmp
    if ($stats.Colours -le 2 -and $stats.DominantShare -gt 0.98) {
      $method = "printwindow-blank"
      $ok = $false
    }
  }
} catch { $ok = $false }
  if (-not $ok) {
    if ($bmp) { $bmp.Dispose(); $bmp = $null }
  }
}

# ── path 2: raise the window, then grab the screen over its rect ───────────
$focused = $false
if ($null -eq $bmp -or $Focus) {
  if ($null -ne $bmp) { $bmp.Dispose(); $bmp = $null }
  if ($script:Compiled) { $focused = Bring-ToFront -Handle $win.Handle }
  else { $focused = Bring-ToFront-NoCompile -Proc $win.Proc }
  Start-Sleep -Milliseconds 350
  $r = Get-WindowRect -Handle $win.Handle
  if ($null -eq $r) { $r = @{ Left = 0; Top = 0; Right = $win.Width; Bottom = $win.Height } }
  $w = $r.Right - $r.Left; $h = $r.Bottom - $r.Top
  if ($w -lt 50 -or $h -lt 50) {
    Write-Output "OR_STUDIO_SHOT {""ok"":false,""error"":""Studio window has no usable size ($w x $h) - un-minimize it and retry"",""code"":3}"
    exit 3
  }
  $bmp = New-Object System.Drawing.Bitmap($w, $h)
  $gfx = [System.Drawing.Graphics]::FromImage($bmp)
  try { $gfx.CopyFromScreen($r.Left, $r.Top, 0, 0, (New-Object System.Drawing.Size($w, $h))) }
  finally { $gfx.Dispose() }
  $method = $(if ($script:Compiled) { "screen" } else { "screen-nocompile" })
}

# JPEG keeps the text tunnel to a few chunks; the PNG twin is optional because a
# file that is never read back is only useful to the user, who already has the JPEG.
# A .png name holding JPEG bytes would lie about the file, so the extension always
# follows the encoder (the caller reads the real path from the JSON line anyway).
$full = [System.IO.Path]::ChangeExtension($full, $(if ($script:UseJpeg) { ".jpg" } else { ".png" }))
try {
$final = Scale-Bitmap -Bmp $bmp -MaxW $MaxWidth
try { Save-Bitmap -Bmp $final -Path $full } finally { $final.Dispose(); $bmp.Dispose() }

$tunnel = @{ base64_file = ""; base64_chars = 0; base64_lines = 0; sha256 = ""; bytes = (Get-Item -LiteralPath $full).Length; mime = "" }
if (-not $NoB64) {
  try {
    $tunnel = Write-B64File -Path ($full + ".b64") -Wrap $Wrap
  } catch {
    $tunnel = @{ base64_file = ""; base64_chars = 0; base64_lines = 0; sha256 = ""; bytes = 0; mime = ""; tunnel_error = $_.Exception.Message }
  }
}

Write-Output ("OR_STUDIO_SHOT " + (@{
  ok = $true
  file = $full
  bytes = (Get-Item -LiteralPath $full).Length
  method = $method
  focused = [bool]$focused
  window = @{ process = $win.Name; pid = $win.Proc.Id; width = $win.Width; height = $win.Height }
  base64_file = $tunnel.base64_file
  base64_chars = $tunnel.base64_chars
  base64_lines = $tunnel.base64_lines
  tunnel_error = $(if ($tunnel.ContainsKey("tunnel_error")) { $tunnel.tunnel_error } else { "" })
  sha256 = $tunnel.sha256
  mime = $tunnel.mime
  route = $(if ($script:Compiled) { "compiled" } else { "no-compile" })
  compile_error = $(if ($script:CompileError) { $script:CompileError } else { "" })
} | ConvertTo-Json -Compress -Depth 4))
exit 0
} catch {
  # Anything unexpected (a blocked API, a locked file, a missing font) must still
  # produce ONE machine-readable line - otherwise the caller can only say "no answer
  # from the agent", which is the least useful sentence in this whole file.
  Write-Output ("OR_STUDIO_SHOT " + (@{
    ok = $false
    error = ("the capture step failed: " + $_.Exception.Message)
    route = $(if ($script:Compiled) { "compiled" } else { "no-compile" })
    compile_error = $(if ($script:CompileError) { $script:CompileError } else { "" })
    code = 3
  } | ConvertTo-Json -Compress -Depth 3))
  exit 3
}
