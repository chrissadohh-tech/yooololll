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
# Exit codes: 0 ok, 2 no Studio window, 3 capture failed. Machine-readable line
# "OR_STUDIO_SHOT {...}" is printed last so the caller does not have to parse
# PowerShell prose.

param(
  [string]$Out = "or_studio_window.png",
  [switch]$Focus,
  [switch]$FocusOnly,
  [int]$MaxWidth = 1600,
  [string]$ProcessName = ""
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

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
try { Add-Type -TypeDefinition $src -ErrorAction Stop } catch { }   # already loaded in this session

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
      $r = New-Object ORWin+RECT
      if (-not [ORWin]::GetWindowRect($h, [ref]$r)) { continue }
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

function Save-Bitmap {
  param($Bmp, [string]$Path)
  $bmp.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
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

$win = Get-StudioWindow -Name $ProcessName
if ($null -eq $win) {
  Write-Output "OR_STUDIO_SHOT {""ok"":false,""error"":""no visible Roblox Studio window found - open Studio (and un-minimize it) first"",""code"":2}"
  exit 2
}

if ($FocusOnly) {
  $ok = Bring-ToFront -Handle $win.Handle
  Write-Output ("OR_STUDIO_SHOT " + (@{
    ok = $true; focus_only = $true; focused = [bool]$ok
    window = @{ title = ""; process = $win.Name; pid = $win.Proc.Id; width = $win.Width; height = $win.Height }
    note = if ($ok) { "Roblox Studio is now the front window" } else { "Windows refused to give Studio keyboard focus - it was raised above other windows instead" }
  } | ConvertTo-Json -Compress -Depth 4))
  exit 0
}

$full = Join-Path (Get-Location) $Out
if (-not [System.IO.Path]::IsPathRooted($Out)) { $full = Join-Path (Get-Location) $Out } else { $full = $Out }

# ── path 1: PrintWindow (no focus change) ──────────────────────────────────
$method = "printwindow"
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

# ── path 2: raise the window, then grab the screen over its rect ───────────
$focused = $false
if ($null -eq $bmp -or $Focus) {
  if ($null -ne $bmp) { $bmp.Dispose(); $bmp = $null }
  $focused = Bring-ToFront -Handle $win.Handle
  Start-Sleep -Milliseconds 350
  $r = New-Object ORWin+RECT
  [void][ORWin]::GetWindowRect($win.Handle, [ref]$r)
  $w = $r.Right - $r.Left; $h = $r.Bottom - $r.Top
  if ($w -lt 50 -or $h -lt 50) {
    Write-Output "OR_STUDIO_SHOT {""ok"":false,""error"":""Studio window has no usable size ($w x $h) - un-minimize it and retry"",""code"":3}"
    exit 3
  }
  $bmp = New-Object System.Drawing.Bitmap($w, $h)
  $gfx = [System.Drawing.Graphics]::FromImage($bmp)
  try { $gfx.CopyFromScreen($r.Left, $r.Top, 0, 0, (New-Object System.Drawing.Size($w, $h))) }
  finally { $gfx.Dispose() }
  $method = "screen"
}

$final = Scale-Bitmap -Bmp $bmp -MaxW $MaxWidth
try { Save-Bitmap -Bmp $final -Path $full } finally { $final.Dispose(); $bmp.Dispose() }

Write-Output ("OR_STUDIO_SHOT " + (@{
  ok = $true
  file = $full
  bytes = (Get-Item -LiteralPath $full).Length
  method = $method
  focused = [bool]$focused
  window = @{ process = $win.Name; pid = $win.Proc.Id; width = $win.Width; height = $win.Height }
} | ConvertTo-Json -Compress -Depth 4))
exit 0
